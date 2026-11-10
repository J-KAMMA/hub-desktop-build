# hub-local-runner と、その配下の msedgewebview2 の「専用メモリ(Private Working Set)」を役割別に合計する。
# 読むだけ。アプリは止めない・触らない。同じ3サイトで、休止の前後に1回ずつ実行して比べる。
#   powershell -File measure-browser-memory.ps1 [-Label before]
param([string]$Label = '')

$ErrorActionPreference = 'Stop'
$all = Get-CimInstance Win32_Process -Filter "Name='hub-local-runner.exe' OR Name='msedgewebview2.exe'"
$byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }

function Root([int]$id) {
  $seen = @{}
  while ($byId.ContainsKey($id) -and -not $seen.ContainsKey($id)) {
    $seen[$id] = 1
    $p = $byId[$id]
    if ($p.Name -eq 'hub-local-runner.exe') { return $id }
    $id = [int]$p.ParentProcessId
  }
  return $null
}

$perf = @{}
Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "Name LIKE 'msedgewebview2%' OR Name LIKE 'hub-local-runner%'" |
  ForEach-Object { $perf[[int]$_.IDProcess] = [double]$_.WorkingSetPrivate }

$rows = foreach ($p in $all) {
  $id = [int]$p.ProcessId
  if ($p.Name -ne 'hub-local-runner.exe' -and $null -eq (Root $id)) { continue }
  $role = 'app'
  if ($p.Name -eq 'msedgewebview2.exe') {
    $cmd = [string]$p.CommandLine
    if ($cmd -match '--type=gpu-process') { $role = 'gpu' }
    elseif ($cmd -match '--type=renderer') { $role = 'renderer' }
    elseif ($cmd -match '--type=utility') { $role = 'utility' }
    elseif ($cmd -notmatch '--type=') { $role = 'browser' }
    else { $role = 'other' }
  }
  [pscustomobject]@{ Role = $role; Pid = $id; MB = [math]::Round(($perf[$id] / 1MB), 1) }
}

if (-not $rows) { Write-Output 'hub-local-runner is not running.'; exit 1 }
if ($Label) { Write-Output "[$Label] $(Get-Date -Format 's')" }
$rows | Group-Object Role | ForEach-Object {
  [pscustomobject]@{ Role = $_.Name; Processes = $_.Count; MB = [math]::Round(($_.Group | Measure-Object MB -Sum).Sum, 1) }
} | Sort-Object Role | Format-Table -AutoSize
$total = [math]::Round(($rows | Measure-Object MB -Sum).Sum, 1)
Write-Output "TOTAL private working set: $total MB ($($rows.Count) processes)"
