<#
  Makes sure both device roles run, hidden, from this deploy folder. Idempotent: a role that
  already runs is left alone. Each role is created through WMI (Win32_Process.Create, ShowWindow=0),
  not as a child of the caller, so it outlives the window, logon script or session that started it
  (the studio's ensure-studio.ps1 pattern). No administrator rights are needed.

    powershell -NoProfile -ExecutionPolicy Bypass -File <deploy>\scripts\device\ensure-device-workers.ps1 [-Role photos|plans]
#>
param([ValidateSet('photos', 'plans', 'both')][string]$Role = 'both')
$ErrorActionPreference = 'Stop'
$live = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path -LiteralPath (Join-Path $live 'device.json'))) { throw "not a deploy folder: $live" }
$runner = Join-Path $PSScriptRoot 'run-device-worker.ps1'
$roles = if ($Role -eq 'both') { @('photos', 'plans') } else { @($Role) }
foreach ($name in $roles) {
  $existing = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($runner) -and $_.CommandLine.Contains("-Role $name") })
  if ($existing.Count) { "$name already running (pid $($existing[0].ProcessId))"; continue }
  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  $command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Role $name"
  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command; CurrentDirectory = $live; ProcessStartupInformation = $startup }
  if ($result.ReturnValue -ne 0) { throw "could not start the $name worker (code $($result.ReturnValue))" }
  "$name started (pid $($result.ProcessId))"
}
