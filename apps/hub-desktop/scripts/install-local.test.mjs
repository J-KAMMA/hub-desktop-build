import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const directory = path.dirname(fileURLToPath(import.meta.url));
const installer = path.join(directory, 'install-local.ps1');
const uninstaller = path.join(directory, 'uninstall-local.ps1');
const tauriConf = path.join(directory, '..', 'src-tauri', 'tauri.conf.json');
const powershell = 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe';
const quote = value => `'${value.replaceAll("'", "''")}'`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const binary = byte => { const bytes = Buffer.alloc(128, byte); bytes[0] = 77; bytes[1] = 90; return bytes; };

async function scenario(name, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'hub-installer-owned-'));
  try {
    const startMenu = path.join(root, 'startmenu');
    const install = path.join(root, 'install'), source = path.join(root, 'source.exe');
    await mkdir(install);
    const target = path.join(install, 'hub-local-runner.exe');
    const old = binary(1), next = await readFile('C:/Windows/System32/notepad.exe');
    await writeFile(source, options.badHeader ? Buffer.alloc(8) : next);
    if (!options.first) await writeFile(target, old);
    await writeFile(path.join(install, 'unrelated.txt'), 'preserved');
    const harness = path.join(root, 'fixture.ps1');
    const script = `
$ErrorActionPreference='Stop'
# Windows PowerShell 5.1 now autoloads Get-FileHash as a module function that shadows script-scope stubs; import first so the stub wins.
Import-Module Microsoft.PowerShell.Utility
$fixtureMode=${quote(name)}
$fixtureTarget=${quote(target)}
$fixtureInstall=${quote(install)}
$global:fixtureClosed=$false; $global:fixtureCloseCalls=0; $global:fixtureLaunches=@(); $global:fixtureHashes=@(); $global:fixtureInjected=$false; $global:fixtureBuilds=0; $global:fixtureReg=@()
function New-Item { param([string]$Path,[switch]$Force) $global:fixtureReg+=@{op='key';path=$Path} }
function Set-ItemProperty { param([string]$Path,[string]$Name,[object]$Value,[string]$Type) $global:fixtureReg+=@{op='set';path=$Path;name=$Name;value=$Value;type=$Type} }
function Make-FixtureProcess([bool]$Other=$false,[bool]$Reused=$false) {
 $p=[pscustomobject]@{Id=991234;Path=$(if($Other){Join-Path ${quote(root)} 'unrelated/hub-local-runner.exe'}else{$fixtureTarget});StartTime=[datetime]'2026-10-07T00:00:00Z'}
 if($Reused){$p.StartTime=$p.StartTime.AddSeconds(1)}
 $p|Add-Member ScriptMethod CloseMainWindow { $global:fixtureCloseCalls++;if($fixtureMode -eq 'refusal'){return $false};if($fixtureMode -eq 'retry'){if($global:fixtureCloseCalls -ge 2){$global:fixtureClosed=$true}}elseif($fixtureMode -ne 'timeout'){$global:fixtureClosed=$true};return $true }
 return $p
}
function Get-Process { param([string]$Name,[int]$Id,[object]$ErrorAction)
 if($fixtureMode -eq 'unrelated'){return Make-FixtureProcess $true}
 if($fixtureMode -notin @('running','refusal','timeout','retry','close','reused','case')){return}
 if($global:fixtureClosed){return}
 if($fixtureMode -eq 'reused' -and $Id){return Make-FixtureProcess $false $true}
 $p=Make-FixtureProcess;if($fixtureMode -eq 'case'){$p.Path=$p.Path.ToUpperInvariant()};return $p
}
function Start-Sleep { param([int]$Milliseconds) }
function Start-Process { param([string]$FilePath,[string]$WindowStyle) $global:fixtureLaunches+=@{path=$FilePath;style=$WindowStyle} }
function cargo { param([string]$Verb,[string]$Profile) $global:fixtureBuilds++;if($env:CARGO_INCREMENTAL -ne '0'){throw 'incremental was not disabled'};$global:LASTEXITCODE=0 }
function Get-FileHash { param([string]$LiteralPath,[string]$Algorithm)
 $actual=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($LiteralPath))).Replace('-','')
 $global:fixtureHashes+=@{path=$LiteralPath;hash=$actual}
 if(-not $global:fixtureInjected -and (($fixtureMode -eq 'copyhash' -and $LiteralPath.EndsWith('.tmp')) -or ($fixtureMode -eq 'readback' -and $LiteralPath -eq $fixtureTarget -and @(Get-ChildItem -LiteralPath $fixtureInstall -Filter '*.previous.exe').Count))){$global:fixtureInjected=$true;return [pscustomobject]@{Hash=('0'*64)}}
 return [pscustomobject]@{Hash=$actual}
}
$ok=$false;$errorText='';$beforeIncremental=[Environment]::GetEnvironmentVariable('CARGO_INCREMENTAL','Process')
try { & ${quote(installer)} ${options.build ? '' : '-SkipBuild'} ${options.launch ? '' : '-NoLaunch'} ${options.close ? '-CloseRunning' : ''} -StartMenuDirectory ${quote(startMenu)} -UninstallRegistryRoot 'HKCU:\\Software\\FixtureNeverWritten' -SourceBinary ${quote(options.sourceOverride ?? source)} -InstallDirectory ${quote(options.installOverride ?? install)} *> $null; $ok=$true } catch { $errorText=$_.Exception.Message }
$files=@(Get-ChildItem -LiteralPath $fixtureInstall -File|ForEach-Object{@{name=$_.Name;hash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($_.FullName))).Replace('-','')}})
@{ok=$ok;error=$errorText;closeCalls=$fixtureCloseCalls;launches=@($fixtureLaunches);hashes=@($fixtureHashes);files=$files;builds=$fixtureBuilds;reg=@($fixtureReg);incrementalRestored=([Environment]::GetEnvironmentVariable('CARGO_INCREMENTAL','Process') -eq $beforeIncremental)}|ConvertTo-Json -Depth 6 -Compress
`;
    // Build fixture uses the real script's expected source-root shape, never Cargo.
    let scriptPath = installer;
    if (options.build) {
      const ownedScripts = path.join(root, 'scripts'); await mkdir(ownedScripts); await mkdir(path.join(root, 'src-tauri'));
      scriptPath = path.join(ownedScripts, 'install-local.ps1'); await writeFile(scriptPath, await readFile(installer));
      await writeFile(path.join(ownedScripts, 'uninstall-local.ps1'), await readFile(uninstaller));
      await writeFile(path.join(root, 'src-tauri', 'tauri.conf.json'), await readFile(tauriConf));
    }
    await writeFile(harness, script.replace(quote(installer), quote(scriptPath)));
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const value = JSON.parse(result.stdout.trim());
    assert.equal(value.files.find(file => file.name === 'unrelated.txt')?.hash, hash(Buffer.from('preserved')));
    assert.equal(value.files.some(file => file.name.endsWith('.tmp')), false);
    const lnk = await readFile(path.join(startMenu, 'Hub.lnk')).catch(() => null);
    return { ...value, lnk, startMenu, install, oldHash: hash(old), nextHash: hash(next), target };
  } finally { await rm(root, { recursive: true, force: true }); }
}
const conf = JSON.parse(await readFile(tauriConf, 'utf8'));
const regValues = result => Object.fromEntries(result.reg.filter(entry => entry.op === 'set').map(entry => [entry.name, entry.value]));
const targetHash = result => result.files.find(file => file.name === 'hub-local-runner.exe')?.hash;
const previous = result => result.files.filter(file => file.name.endsWith('.previous.exe'));

test('default refuses exact running executable without changing files or stopping it', async () => {
  const r=await scenario('running');assert.equal(r.ok,false);assert.match(r.error,/running/);assert.equal(r.closeCalls,0);assert.equal(targetHash(r),r.oldHash);assert.equal(previous(r).length,0);
});
test('unrelated same-name executable is never stopped and update hashes/backup match', async () => {
  const r=await scenario('unrelated');assert.equal(r.ok,true,r.error);assert.equal(r.closeCalls,0);assert.equal(targetHash(r),r.nextHash);assert.deepEqual(previous(r).map(f=>f.hash),[r.oldHash]);assert.equal(r.launches.length,0);assert.ok(r.hashes.some(f=>f.path.endsWith('.tmp')&&f.hash===r.nextHash));
});
test('explicit close uses normal exit only for exact path, case-insensitively', async () => {
  for(const mode of ['close','case']){const r=await scenario(mode,{close:true});assert.equal(r.ok,true,r.error);assert.equal(r.closeCalls,1);assert.equal(targetHash(r),r.nextHash);}
});
test('normal exit refusal and bounded timeout retain original executable', async () => {
  for(const mode of ['refusal','timeout']){const r=await scenario(mode,{close:true});assert.equal(r.ok,false);assert.equal(r.closeCalls,mode==='refusal'?1:12,'timeout repeats the normal request every 5s for 60s, never kills');assert.equal(targetHash(r),r.oldHash);assert.equal(previous(r).length,0);}
});
test('a lost first normal-exit request is repeated and then succeeds', async () => {
  const r=await scenario('retry',{close:true});assert.equal(r.ok,true,r.error);assert.equal(r.closeCalls,2);assert.equal(targetHash(r),r.nextHash);
});
test('fresh process start-time mismatch aborts before even normal close', async () => {
  const r=await scenario('reused',{close:true});assert.equal(r.ok,false);assert.match(r.error,/identity changed/);assert.equal(r.closeCalls,0);assert.equal(targetHash(r),r.oldHash);
});
test('copied hash failure never replaces installed binary', async () => {
  const r=await scenario('copyhash');assert.equal(r.ok,false);assert.equal(targetHash(r),r.oldHash);assert.equal(previous(r).length,0);
});
test('post-replace readback failure restores exact original and retains old backup', async () => {
  const r=await scenario('readback');assert.equal(r.ok,false);assert.match(r.error,/verification failed/);assert.equal(targetHash(r),r.oldHash);assert.deepEqual(previous(r).map(f=>f.hash),[r.oldHash]);assert.equal(r.files.filter(f=>f.name.endsWith('.failed.exe')).length,1);
});
test('first install and hidden launch use selected target; NoLaunch and SkipBuild have no effects', async () => {
  const r=await scenario('idle',{first:true,launch:true});assert.equal(r.ok,true,r.error);assert.equal(targetHash(r),r.nextHash);assert.equal(previous(r).length,0);assert.deepEqual(r.launches,[{path:r.target,style:'Hidden'}]);assert.equal(r.builds,0);
});
test('build is mocked, disables incremental only in process, and restores it', async () => {
  const r=await scenario('idle',{build:true});assert.equal(r.ok,true,r.error);assert.equal(r.builds,1);assert.equal(r.incrementalRestored,true);assert.equal(targetHash(r),r.nextHash);
});
test('invalid small source and nonabsolute paths leave target untouched', async () => {
  for(const options of [{badHeader:true},{sourceOverride:'relative.exe'},{installOverride:'relative-dir'}]){const r=await scenario('idle',options);assert.equal(r.ok,false);assert.equal(targetHash(r),r.oldHash);assert.equal(previous(r).length,0);}
});
test('PowerShell parses and implementation contains no force-stop or bulk-stop command', async () => {
  const body=await readFile(installer,'utf8');assert.doesNotMatch(body,/Stop-Process|Kill\s*\(/m);
  const parsed=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',`$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseFile(${quote(installer)},[ref]$t,[ref]$e);if($e.Count){$e|Out-String|Write-Error;exit 1}`],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(parsed.status,0,parsed.stderr);
});

test('install creates Hub.lnk with app icon and AppUserModelID, and records a per-user uninstall entry', async () => {
  const r=await scenario('idle',{first:true,realBinary:true});assert.equal(r.ok,true,r.error);
  assert.ok(r.lnk,'shortcut written');assert.ok(r.lnk.includes(Buffer.from(conf.identifier,'utf16le')),'AppUserModelID stored');
  assert.ok(r.lnk.includes(Buffer.from('hub-local-runner.exe','utf16le')),'target stored');
  const key='HKCU:\\Software\\FixtureNeverWritten\\'+conf.identifier;
  assert.ok(r.reg.every(e=>e.path===key),'only the uninstall key is touched');
  const v=regValues(r);
  assert.deepEqual(v,{DisplayName:'Hub',DisplayIcon:r.target,DisplayVersion:conf.version,Publisher:'JKamma',InstallLocation:r.install,
    UninstallString:`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${path.join(r.install,'uninstall-local.ps1')}"`,NoModify:1,NoRepair:1});
  assert.equal(r.reg.find(e=>e.name==='NoModify').type,'DWord');assert.equal(r.reg.find(e=>e.name==='DisplayName').type,'String');
  assert.ok(r.files.some(f=>f.name==='uninstall-local.ps1'));
});
test('re-running updates the registration in place with identical values (idempotent)', async () => {
  const a=await scenario('idle',{realBinary:true});const b=await scenario('idle',{realBinary:true});assert.equal(a.ok,true,a.error);assert.equal(b.ok,true,b.error);
  const norm=(r)=>Object.fromEntries(Object.entries(regValues(r)).map(([k,v])=>[k,typeof v==='string'?v.replaceAll(r.install,'<I>'):v]));
  assert.equal(a.reg.filter(e=>e.op==='key').length,1);assert.deepEqual(norm(a),norm(b));assert.equal(norm(a).InstallLocation,'<I>');
});
test('failed install registers nothing', async () => {
  const r=await scenario('idle',{badHeader:true});assert.equal(r.ok,false);assert.equal(r.reg.length,0);assert.equal(r.lnk,null);
});
test('uninstall script parses, keeps user data by default and never stops processes', async () => {
  const body=await readFile(uninstaller,'utf8');assert.doesNotMatch(body,/Stop-Process|Kill\s*\(/m);assert.match(body,/RemoveUserData/);
  assert.doesNotMatch(body,/[^ -]/);
  const parsed=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',`$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseFile(${quote(uninstaller)},[ref]$t,[ref]$e);if($e.Count){$e|Out-String|Write-Error;exit 1}`],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(parsed.status,0,parsed.stderr);
});
test('uninstall removes shortcut, key and installer files only, keeping user data and unrelated files', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'hub-uninstall-owned-'));
  try{
    const install=path.join(root,'install'),menu=path.join(root,'menu'),appdata=path.join(root,'appdata'),data=path.join(appdata,conf.identifier);
    await mkdir(install);await mkdir(menu);await mkdir(data,{recursive:true});
    for(const f of ['hub-local-runner.exe','hub-local-runner.abc.previous.exe','unrelated.txt'])await writeFile(path.join(install,f),'x');
    await writeFile(path.join(menu,'Hub.lnk'),'x');await writeFile(path.join(data,'state.db'),'keep');
    const harness=path.join(root,'u.ps1');
    await writeFile(harness,`$ErrorActionPreference='Stop'
$global:rk=@()
function Test-Path { param([string]$Path,[string]$LiteralPath,[string]$PathType) if($Path -like 'HKCU:*'){return $true}; if($LiteralPath){Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath -PathType $PathType}else{Microsoft.PowerShell.Management\\Test-Path -Path $Path} }
function Remove-Item { param([string]$Path,[string]$LiteralPath,[switch]$Recurse) if($Path -like 'HKCU:*'){$global:rk+=$Path;return}; if($LiteralPath){Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $LiteralPath -Recurse:$Recurse}else{Microsoft.PowerShell.Management\\Remove-Item -Path $Path} }
$env:APPDATA=${quote(appdata)}
& ${quote(uninstaller)} -InstallDirectory ${quote(install)} -StartMenuDirectory ${quote(menu)} -UninstallRegistryRoot 'HKCU:\\Software\\FixtureNeverWritten' | Out-Null
@{rk=$global:rk}|ConvertTo-Json -Compress`);
    const run=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',harness],{encoding:'utf8',timeout:20000,windowsHide:true});
    assert.equal(run.status,0,run.stderr||run.stdout);
    assert.deepEqual(JSON.parse(run.stdout.trim()).rk,['HKCU:\\Software\\FixtureNeverWritten\\'+conf.identifier]);
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(install),['unrelated.txt']);assert.deepEqual(await readdir(menu),[]);
    assert.equal(await readFile(path.join(data,'state.db'),'utf8'),'keep');
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('RemoveCredentials picks only this app\'s keyring entries and always keeps the wallet key', async () => {
  const body=await readFile(uninstaller,'utf8');
  assert.match(body,/-RemoveCredentials[\s\S]*wallet key \(evm-wallet-key\.jkamma-hub\) is KEPT/);
  const root=await mkdtemp(path.join(tmpdir(),'hub-uninstall-cred-'));
  try{
    const install=path.join(root,'install'),menu=path.join(root,'menu');await mkdir(install);await mkdir(menu);
    const targets=['checkpoint-key-v1.com.jkamma.hub-local-runner','commerce-checkout-key-v1.com.jkamma.hub-local-runner','conn-1.jkamma-hub-ai-connection',
      'device-key-v1.com.jkamma.hub.desktop-account','commerce-order-tokens.jkamma-hub','commerce-seller-session.jkamma-hub','agent-session-key.jkamma-hub',
      'evm-wallet-key.jkamma-hub','EVM-WALLET-KEY.JKAMMA-HUB','other.jkamma-hub-elsewhere','jkamma-hub','.jkamma-hub','git:https://github.com','x.com.jkamma.hub'];
    const harness=path.join(root,'c.ps1');
    await writeFile(harness,`$ErrorActionPreference='Stop'
function Test-Path { param([string]$Path,[string]$LiteralPath,[string]$PathType) if($Path -like 'HKCU:*'){return $false}; if($LiteralPath){Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath -PathType $PathType}else{Microsoft.PowerShell.Management\\Test-Path -Path $Path} }
& ${quote(uninstaller)} -InstallDirectory ${quote(install)} -StartMenuDirectory ${quote(menu)} -UninstallRegistryRoot 'HKCU:\\Software\\FixtureNeverWritten' -RemoveCredentials -CredentialTargets @(${targets.map(quote).join(',')})`);
    const run=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',harness],{encoding:'utf8',timeout:20000,windowsHide:true});
    assert.equal(run.status,0,run.stderr||run.stdout);
    const picked=run.stdout.split(/\r?\n/).filter(line=>line.startsWith('credential ')).map(line=>line.slice(11));
    assert.deepEqual(picked,targets.slice(0,7));
    assert.match(run.stdout,/credentials removed: 7 \(the wallet key is kept\)/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('RemoveUserData removes every Hub data folder and nothing beside it', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'hub-uninstall-data-'));
  try{
    const install=path.join(root,'install'),menu=path.join(root,'menu'),roaming=path.join(root,'roaming'),local=path.join(root,'local');
    const owned=[path.join(roaming,conf.identifier),path.join(local,conf.identifier),path.join(roaming,'jkamma-hub'),path.join(local,'jkamma-hub'),path.join(local,'JKamma','HubLocalRunner')];
    const kept=[path.join(local,'JKamma','OtherApp'),path.join(roaming,'other-app')];
    await mkdir(install);await mkdir(menu);
    for(const d of [...owned,...kept]){await mkdir(d,{recursive:true});await writeFile(path.join(d,'f.json'),'x');}
    const harness=path.join(root,'u.ps1');
    await writeFile(harness,`$ErrorActionPreference='Stop'
function Test-Path { param([string]$Path,[string]$LiteralPath,[string]$PathType) if($Path -like 'HKCU:*'){return $false}; if($LiteralPath){Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath -PathType $PathType}else{Microsoft.PowerShell.Management\\Test-Path -Path $Path} }
$env:APPDATA=${quote(roaming)}
$env:LOCALAPPDATA=${quote(local)}
& ${quote(uninstaller)} -InstallDirectory ${quote(install)} -StartMenuDirectory ${quote(menu)} -UninstallRegistryRoot 'HKCU:\\Software\\FixtureNeverWritten' -RemoveUserData | Out-Null`);
    const run=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',harness],{encoding:'utf8',timeout:20000,windowsHide:true});
    assert.equal(run.status,0,run.stderr||run.stdout);
    const { stat } = await import('node:fs/promises');
    for(const d of owned) await assert.rejects(stat(d),undefined,d);
    for(const d of kept) assert.equal(await readFile(path.join(d,'f.json'),'utf8'),'x');
  } finally { await rm(root,{recursive:true,force:true}); }
});
