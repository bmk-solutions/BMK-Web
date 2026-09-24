<#
  Dot-sourced by the device scripts. Sets this PC's engine settings for a worker started from a
  deploy folder built by build-device-live.ps1. Prints nothing and holds no secret.
#>
$live = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$deviceFile = Join-Path $live 'device.json'
if (-not (Test-Path -LiteralPath $deviceFile)) { throw "not a deploy folder (no device.json): $live - build it with scripts\device\build-device-live.ps1" }
$device = Get-Content -LiteralPath $deviceFile -Raw | ConvertFrom-Json

# Python + the bundled OpenCV of this repository's runtimes (junctions inside the deploy folder).
$env:IMO3D_PYTHON = $device.python
$env:IMO3D_CV_PATH = Join-Path $live 'work\reconstruction-python-user'
# Plans and photo retouch run on the owner's local Codex (his ChatGPT subscription); Gemini is not injected.
$env:IMO3D_PLAN_PROVIDER = 'codex'
# The newest installed Codex by modification time, re-read at every start so an update is picked up.
$codexBin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
$codex = @(Get-ChildItem -LiteralPath $codexBin -Directory -ErrorAction SilentlyContinue |
  ForEach-Object { Get-Item -LiteralPath (Join-Path $_.FullName 'codex.exe') -ErrorAction SilentlyContinue } |
  Sort-Object LastWriteTimeUtc -Descending)
if ($codex.Count) { $env:IMO3D_CODEX_BIN = $codex[0].FullName } else { Remove-Item Env:\IMO3D_CODEX_BIN -ErrorAction SilentlyContinue }
# The owner's single env file; the supervisor hands it to each worker with --env-file.
$env:IMO3D_ENV_FILE = $device.envFile
$env:PYTHONUTF8 = '1'
$node = $device.node
