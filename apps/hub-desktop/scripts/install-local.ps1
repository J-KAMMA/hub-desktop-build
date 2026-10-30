# Update only the installed executable selected below. No forced process exit.
# Keep this script ASCII-only for Windows PowerShell 5.1.
param(
    [switch]$SkipBuild,
    [switch]$NoLaunch,
    [string]$SourceBinary,
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Hub Local Runner'),
    [switch]$CloseRunning,
    [ValidateRange(5,600)][int]$ExitTimeoutSeconds = 60,
    [string]$StartMenuDirectory = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    [string]$UninstallRegistryRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $SourceBinary) { $SourceBinary = Join-Path $root 'src-tauri\target\release\hub-local-runner.exe' }

function Get-InstallPath([string]$Path) {
    if (-not $Path -or $Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.Substring(2).Contains(':') -or $Path -match '[\x00-\x1f\x7f]') {
        throw 'absolute local path required'
    }
    $full = [IO.Path]::GetFullPath($Path)
    $part = $full
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            $item = Get-Item -LiteralPath $part -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse paths are not supported' }
        }
        $parent = [IO.Path]::GetDirectoryName($part)
        if ($parent -eq $part) { break }
        $part = $parent
    }
    return $full
}
function Get-InstallHash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function Get-TargetProcesses {
    @(Get-Process -Name 'hub-local-runner' -ErrorAction SilentlyContinue) | Where-Object {
        if (-not $_.Path) { throw 'cannot verify running executable' }
        [string]::Equals([IO.Path]::GetFullPath($_.Path), $target, [StringComparison]::OrdinalIgnoreCase)
    }
}
function Confirm-TargetStopped([bool]$MayClose) {
    foreach ($process in @(Get-TargetProcesses)) {
        if (-not $MayClose) { throw 'installed executable is running; use -CloseRunning for normal exit' }
        $processId = $process.Id
        $started = $process.StartTime.ToUniversalTime().Ticks
        $fresh = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $fresh) { continue }
        if ($fresh.StartTime.ToUniversalTime().Ticks -ne $started -or -not [string]::Equals([IO.Path]::GetFullPath($fresh.Path), $target, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'running process identity changed'
        }
        if (-not $fresh.CloseMainWindow()) { throw 'installed executable refused normal exit' }
        Write-Host ('waiting for Hub Desktop to exit normally (up to ' + ($ExitTimeoutSeconds) + 's; it saves the browser session first)')
        $polls = [Math]::Max(1, [int]($ExitTimeoutSeconds * 4))
        for ($attempt = 0; $attempt -lt $polls; $attempt++) {
            $fresh = Get-Process -Id $processId -ErrorAction SilentlyContinue
            if (-not $fresh) { break }
            if ($fresh.StartTime.ToUniversalTime().Ticks -ne $started -or -not [string]::Equals([IO.Path]::GetFullPath($fresh.Path), $target, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'running process identity changed'
            }
            # Normal exit again every 5s: a request lost while the app was busy or
            # a failed session save is retried by the app (second request exits).
            if ($attempt -gt 0 -and $attempt % 20 -eq 0) {
                Write-Host ('still waiting for exit (' + [int]($attempt / 4) + 's); repeating the normal exit request')
                [void]$fresh.CloseMainWindow()
            }
            Start-Sleep -Milliseconds 250
        }
        if ($fresh) { throw 'normal exit timed out; executable unchanged' }
    }
    if (@(Get-TargetProcesses).Count) { throw 'installed executable started again; executable unchanged' }
}
function Copy-InstallExclusive([string]$From, [string]$To) {
    $inputStream = [IO.File]::Open($From, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $outputStream = [IO.File]::Open($To, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        [void]$createdFiles.Add($To)
        try { $inputStream.CopyTo($outputStream); $outputStream.Flush($true) } finally { $outputStream.Dispose() }
    } finally { $inputStream.Dispose() }
}

# Per-user registration (Start Menu shortcut + HKCU uninstall entry). No admin, no machine-wide change.
function Get-AppConfig {
    $conf = Get-Content -LiteralPath (Join-Path $root 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $conf.identifier -or $conf.identifier -notmatch '^[A-Za-z0-9.\-]+$' -or -not $conf.version) { throw 'tauri.conf.json identifier or version invalid' }
    return $conf
}
function Set-ShortcutAppId([string]$LinkPath, [string]$AppId) {
    if (-not ('HubShortcutAppId' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HubShortcutAppId {
    [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Explicit)] struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    interface IPropertyStore {
        void GetCount(out uint c);
        void GetAt(uint i, out PROPERTYKEY k);
        void GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
        void SetValue(ref PROPERTYKEY k, ref PROPVARIANT v);
        void Commit();
    }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
    interface IPersistFile {
        void GetClassID(out Guid g);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string f, uint mode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string f, [MarshalAs(UnmanagedType.Bool)] bool remember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string f);
    }
    public static void Set(string path, string appId) {
        object link = new CShellLink();
        try {
            ((IPersistFile)link).Load(path, 2);
            IPropertyStore store = (IPropertyStore)link;
            PROPERTYKEY key = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
            PROPVARIANT value = new PROPVARIANT { vt = 31, p = Marshal.StringToCoTaskMemUni(appId) };
            try { store.SetValue(ref key, ref value); store.Commit(); } finally { Marshal.FreeCoTaskMem(value.p); }
            ((IPersistFile)link).Save(path, true);
        } finally { Marshal.FinalReleaseComObject(link); }
    }
}
'@
    }
    [HubShortcutAppId]::Set($LinkPath, $AppId)
}
function Set-StartMenuShortcut([string]$LinkPath, [string]$ExePath, [string]$WorkDir, [string]$AppId) {
    $shell = New-Object -ComObject WScript.Shell
    try {
        $link = $shell.CreateShortcut($LinkPath)
        $link.TargetPath = $ExePath
        $link.WorkingDirectory = $WorkDir
        $link.IconLocation = $ExePath + ',0'
        $link.Description = 'Hub'
        $link.Save()
    } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
    Set-ShortcutAppId $LinkPath $AppId
}
function Set-UninstallEntry([string]$Key, [hashtable]$Values) {
    [void](New-Item -Path $Key -Force)
    foreach ($name in $Values.Keys) {
        $value = $Values[$name]
        $kind = if ($value -is [int]) { 'DWord' } else { 'String' }
        Set-ItemProperty -Path $Key -Name $name -Value $value -Type $kind
    }
}

$exe = Get-InstallPath $SourceBinary
$installDir = Get-InstallPath $InstallDirectory
if (-not (Test-Path -LiteralPath $installDir -PathType Container)) { throw 'install directory must already exist' }
$target = Get-InstallPath (Join-Path $installDir 'hub-local-runner.exe')
if (-not [string]::Equals([IO.Path]::GetDirectoryName($target), $installDir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'target outside install directory' }
if ([string]::Equals($exe, $target, [StringComparison]::OrdinalIgnoreCase)) { throw 'source and target must differ' }
# Refuse before spending time building; explicit normal exit happens after build.
if (-not $CloseRunning) { Confirm-TargetStopped $false }
if (-not $SkipBuild) {
    $incrementalBefore = [Environment]::GetEnvironmentVariable('CARGO_INCREMENTAL', 'Process')
    Push-Location (Join-Path $root 'src-tauri')
    try {
        [Environment]::SetEnvironmentVariable('CARGO_INCREMENTAL', '0', 'Process')
        cargo build --release
        if ($LASTEXITCODE -ne 0) { throw 'cargo build --release failed' }
    } finally {
        [Environment]::SetEnvironmentVariable('CARGO_INCREMENTAL', $incrementalBefore, 'Process')
        Pop-Location
    }
}
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'release binary not found' }
$header = [IO.File]::OpenRead($exe)
try { if ($header.Length -lt 64 -or $header.ReadByte() -ne 77 -or $header.ReadByte() -ne 90) { throw 'source executable header invalid' } } finally { $header.Dispose() }
$sourceHash = Get-InstallHash $exe
Confirm-TargetStopped ([bool]$CloseRunning)
$hadTarget = Test-Path -LiteralPath $target -PathType Leaf
$oldHash = if ($hadTarget) { Get-InstallHash $target } else { $null }
$nonce = [Guid]::NewGuid().ToString('N')
$temporary = Join-Path $installDir ('.hub-install-' + $nonce + '.tmp')
$backup = Join-Path $installDir ('hub-local-runner.' + $nonce + '.previous.exe')
$rollback = Join-Path $installDir ('.hub-rollback-' + $nonce + '.tmp')
$failed = Join-Path $installDir ('hub-local-runner.' + $nonce + '.failed.exe')
$createdFiles = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$replaced = $false
try {
    Copy-InstallExclusive $exe $temporary
    if ((Get-InstallHash $temporary) -ne $sourceHash -or (Get-InstallHash $exe) -ne $sourceHash) { throw 'source or copied executable hash changed' }
    Confirm-TargetStopped $false
    if ((Test-Path -LiteralPath $target -PathType Leaf) -ne $hadTarget -or ($hadTarget -and (Get-InstallHash $target) -ne $oldHash)) { throw 'installed executable changed during preparation' }
    if ($hadTarget) { [IO.File]::Replace($temporary, $target, $backup, $true) } else { [IO.File]::Move($temporary, $target) }
    $replaced = $true
    if ((Get-InstallHash $target) -ne $sourceHash -or ($hadTarget -and (Get-InstallHash $backup) -ne $oldHash)) { throw 'installed executable verification failed' }
} catch {
    $failure = $_
    if ($replaced -or (Test-Path -LiteralPath $backup -PathType Leaf)) {
        try {
            Confirm-TargetStopped $false
            if ($hadTarget) {
                if ((Get-InstallHash $backup) -ne $oldHash) { throw 'backup hash mismatch' }
                Copy-InstallExclusive $backup $rollback
                if ((Get-InstallHash $rollback) -ne $oldHash) { throw 'rollback copy hash mismatch' }
                if (Test-Path -LiteralPath $target -PathType Leaf) { [IO.File]::Replace($rollback, $target, $failed, $true) } else { [IO.File]::Move($rollback, $target) }
                if ((Get-InstallHash $target) -ne $oldHash) { throw 'rollback verification failed' }
            } else {
                if ((Get-InstallHash $target) -ne $sourceHash) { throw 'first install changed; retained for inspection' }
                [IO.File]::Move($target, $failed)
            }
        } catch { throw 'update failed; rollback could not be verified; backup retained' }
    }
    throw $failure
} finally {
    foreach ($owned in @($temporary, $rollback)) {
        if ($createdFiles.Contains($owned) -and (Test-Path -LiteralPath $owned -PathType Leaf)) { Remove-Item -LiteralPath $owned }
    }
}
# Registration runs only after the executable is installed and verified.
$app = Get-AppConfig
$uninstallSource = Join-Path $PSScriptRoot 'uninstall-local.ps1'
if (-not (Test-Path -LiteralPath $uninstallSource -PathType Leaf)) { throw 'uninstall-local.ps1 not found next to installer' }
$uninstallTarget = Join-Path $installDir 'uninstall-local.ps1'
Copy-Item -LiteralPath $uninstallSource -Destination $uninstallTarget -Force
$shortcutPath = Join-Path $StartMenuDirectory 'Hub.lnk'
if (-not (Test-Path -LiteralPath $StartMenuDirectory -PathType Container)) { [void][IO.Directory]::CreateDirectory($StartMenuDirectory) }
Set-StartMenuShortcut $shortcutPath $target $installDir ([string]$app.identifier)
$uninstallKey = $UninstallRegistryRoot.TrimEnd('\') + '\' + [string]$app.identifier
$uninstallCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $uninstallTarget + '"'
Set-UninstallEntry $uninstallKey ([ordered]@{
    DisplayName = 'Hub'
    DisplayIcon = $target
    DisplayVersion = [string]$app.version
    Publisher = 'JKamma'
    InstallLocation = $installDir
    UninstallString = $uninstallCommand
    NoModify = 1
    NoRepair = 1
})
"registered: $shortcutPath ; $uninstallKey"
"installed: $target (SHA256 $sourceHash)"
if ($hadTarget) { "previous executable retained: $backup" }
if (-not $NoLaunch) { Start-Process -FilePath $target -WindowStyle Hidden; 'launched' }
