<#
  One device role (photos or plans) from the deploy folder, with this PC's engine settings.
  Started hidden by ensure-device-workers.ps1; the repository's own wrapper keeps one supervisor
  per role (named mutex) and the supervisor restarts its worker with a 2-60 s backoff.
#>
param([Parameter(Mandatory = $true)][ValidateSet('photos', 'plans')][string]$Role)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'device-env.ps1')
if (-not (Test-Path -LiteralPath $env:IMO3D_ENV_FILE -PathType Leaf)) { throw 'the env file named in device.json is missing' }
& (Join-Path $live 'scripts\start-imo3d-device-worker.ps1') -Role $Role -NodePath $node
exit $LASTEXITCODE
