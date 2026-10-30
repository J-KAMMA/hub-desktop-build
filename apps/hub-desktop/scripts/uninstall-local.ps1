# Per-user uninstall for the locally installed Hub app. Keep this script ASCII-only.
# Removes the Start Menu shortcut, the HKCU uninstall entry and the installed executables.
# User data (app data folders) is kept unless -RemoveUserData is passed. No forced process exit.
# -RemoveCredentials removes this app's Windows Credential Manager entries: AI connection keys,
# the account device key, order tokens, the seller session, the agent session key and the
# encryption keys of the local records. The wallet key (evm-wallet-key.jkamma-hub) is KEPT;
# delete it only from the app (Settings > this device), after moving the balance or keeping a copy.
# Without -RemoveUserData, the encrypted records left on disk can no longer be read.
# -CredentialTargets is for tests: match against that list instead of the store, print, delete nothing.
param(
    [string]$InstallDirectory = $PSScriptRoot,
    [string]$StartMenuDirectory = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    [string]$UninstallRegistryRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    [string]$Identifier = 'com.jkamma.hub',
    [switch]$RemoveUserData,
    [switch]$RemoveCredentials,
    [string[]]$CredentialTargets
)

$ErrorActionPreference = 'Stop'
if ($Identifier -notmatch '^[A-Za-z0-9.\-]+$') { throw 'identifier invalid' }
$installDir = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
$target = Join-Path $installDir 'hub-local-runner.exe'
$running = @(Get-Process -Name 'hub-local-runner' -ErrorAction SilentlyContinue) | Where-Object {
    $_.Path -and [string]::Equals([IO.Path]::GetFullPath($_.Path), $target, [StringComparison]::OrdinalIgnoreCase)
}
if (@($running).Count) { throw 'Hub is running; close it normally and run uninstall again' }

$shortcut = Join-Path $StartMenuDirectory 'Hub.lnk'
if (Test-Path -LiteralPath $shortcut -PathType Leaf) { Remove-Item -LiteralPath $shortcut }
$key = $UninstallRegistryRoot.TrimEnd('\') + '\' + $Identifier
if (Test-Path -Path $key) { Remove-Item -Path $key -Recurse }

# Only the installer's own files; unrelated files in the directory are left alone.
foreach ($pattern in @('hub-local-runner.exe', 'hub-local-runner.*.previous.exe', 'hub-local-runner.*.failed.exe', '.hub-install-*.tmp', '.hub-rollback-*.tmp')) {
    foreach ($file in @(Get-ChildItem -LiteralPath $installDir -Filter $pattern -File -Force -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $file.FullName }
}
if ($RemoveUserData) {
    # Every folder the app writes (docs/hub-desktop-local-data/INVENTORY.md):
    # WebView2 profile (<identifier>), settings/history/Personal Node data (jkamma-hub),
    # compile cache and CLI scratch (Local jkamma-hub), encrypted AI and node records (JKamma\HubLocalRunner).
    # Only HubLocalRunner is removed under JKamma; sibling folders belong to other apps.
    $folders = @()
    foreach ($base in @($env:APPDATA, $env:LOCALAPPDATA)) {
        if ($base) { $folders += (Join-Path $base $Identifier); $folders += (Join-Path $base 'jkamma-hub') }
    }
    if ($env:LOCALAPPDATA) { $folders += (Join-Path (Join-Path $env:LOCALAPPDATA 'JKamma') 'HubLocalRunner') }
    foreach ($data in $folders) {
        if (Test-Path -LiteralPath $data -PathType Container) {
            if ((Get-Item -LiteralPath $data -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse paths are not supported' }
        }
    }
    foreach ($data in $folders) {
        if (Test-Path -LiteralPath $data -PathType Container) { Remove-Item -LiteralPath $data -Recurse }
    }
    'user data removed (a custom Personal Node folder is kept)'
} else { 'user data kept (pass -RemoveUserData to delete it)' }
if ($RemoveCredentials) {
    # keyring names a generic credential "<account>.<service>" (keyring 3, windows-native).
    $services = @('com.jkamma.hub-local-runner', 'jkamma-hub-ai-connection', 'com.jkamma.hub.desktop-account', 'jkamma-hub')
    $kept = 'evm-wallet-key.jkamma-hub'
    $fixture = $PSBoundParameters.ContainsKey('CredentialTargets')
    if ($fixture) { $all = @($CredentialTargets) } else {
        Add-Type -Namespace HubUninstall -Name Credentials -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int CredentialBlobSize; public System.IntPtr CredentialBlob; public int Persist; public int AttributeCount; public System.IntPtr Attributes; public string TargetAlias; public string UserName; }
[System.Runtime.InteropServices.DllImport("advapi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
public static extern bool CredEnumerateW(string filter, int flags, out int count, out System.IntPtr credentials);
[System.Runtime.InteropServices.DllImport("advapi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
public static extern bool CredDeleteW(string target, int type, int flags);
[System.Runtime.InteropServices.DllImport("advapi32.dll")]
public static extern void CredFree(System.IntPtr buffer);
public static string[] GenericTargets() {
    int count; System.IntPtr list;
    if (!CredEnumerateW(null, 0, out count, out list)) { return new string[0]; }
    var names = new System.Collections.Generic.List<string>();
    try {
        for (int i = 0; i < count; i++) {
            System.IntPtr item = System.Runtime.InteropServices.Marshal.ReadIntPtr(list, i * System.IntPtr.Size);
            CREDENTIAL credential = (CREDENTIAL)System.Runtime.InteropServices.Marshal.PtrToStructure(item, typeof(CREDENTIAL));
            if (credential.Type == 1 && credential.TargetName != null) { names.Add(credential.TargetName); }
        }
    } finally { CredFree(list); }
    return names.ToArray();
}
'@
        $all = @([HubUninstall.Credentials]::GenericTargets())
    }
    $targets = @($all | Where-Object {
        $name = [string]$_
        if ([string]::Equals($name, $kept, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        foreach ($service in $services) {
            $suffix = '.' + $service
            if ($name.Length -gt $suffix.Length -and $name.EndsWith($suffix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
        return $false
    })
    foreach ($name in $targets) {
        if ($fixture) { 'credential ' + $name; continue }
        if (-not [HubUninstall.Credentials]::CredDeleteW($name, 1, 0)) { throw ('credential not removed: ' + $name) }
    }
    'credentials removed: ' + @($targets).Count + ' (the wallet key is kept)'
} else { 'credentials kept (pass -RemoveCredentials to delete them; the wallet key is always kept)' }
# This script stays so a failed run can be repeated; remove it and the directory by hand if empty.
'uninstalled'
