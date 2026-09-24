<#
  Stops the device roles that run from this deploy folder (each wrapper with its whole process tree).
  Check the job queue first: a job stopped mid-run is re-claimed after its 30 s lease, up to 3 attempts.
#>
param([ValidateSet('photos', 'plans', 'both')][string]$Role = 'both')
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'run-device-worker.ps1'
$roles = if ($Role -eq 'both') { @('photos', 'plans') } else { @($Role) }
foreach ($name in $roles) {
  $wrappers = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($runner) -and $_.CommandLine.Contains("-Role $name") })
  if (-not $wrappers.Count) { "$name not running"; continue }
  foreach ($wrapper in $wrappers) {
    & taskkill.exe /PID $wrapper.ProcessId /T /F | Out-Null
    "$name stopped (pid $($wrapper.ProcessId))"
  }
}
