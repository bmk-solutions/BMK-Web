<#
  Read-only readiness check of a deploy folder, with the same settings the workers get. It claims no
  job and sends nothing to the cloud: the photos check runs scripts\imo3d-runtime-check.py through the
  worker's own secret-scrubbed launcher, the plans check reads the local Codex sign-in mode only.
  Prints one JSON line per check (no paths, no secrets). Exit 0 only when every check passes.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'device-env.ps1')
$failed = 0
function Invoke-Check([string]$Name, [string[]]$Arguments) {
  $output = & $node @Arguments 2>$null
  $code = $LASTEXITCODE
  $line = @($output | Where-Object { $_ -match '^\{' } | Select-Object -Last 1)
  [ordered]@{ check = $Name; exit = $code; result = $(if ($line.Count) { $line[0] | ConvertFrom-Json } else { $null }) } | ConvertTo-Json -Compress -Depth 4
  if ($code -ne 0) { $script:failed++ }
}
Push-Location $live
try {
  [ordered]@{ check = 'deploy-folder'; commit = $device.commit; builtAt = $device.builtAt; codex = [bool]$env:IMO3D_CODEX_BIN; provider = $env:IMO3D_PLAN_PROVIDER } | ConvertTo-Json -Compress
  Invoke-Check 'photos-runtime' @("--env-file=$env:IMO3D_ENV_FILE", 'scripts\imo3d-cloud-worker.mjs', '--check')
  Invoke-Check 'plans-runtime' @("--env-file=$env:IMO3D_ENV_FILE", 'scripts\imo3d-subscription-worker.mjs', '--check')
  Invoke-Check 'plans-credentials' @("--env-file=$env:IMO3D_ENV_FILE", 'scripts\imo3d-subscription-worker.mjs', '--check-credentials')
} finally { Pop-Location }
exit $(if ($failed) { 1 } else { 0 })
