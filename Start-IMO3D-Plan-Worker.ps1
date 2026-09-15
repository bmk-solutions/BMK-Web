$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$workerScript = Join-Path $projectDirectory 'scripts\imo3d-subscription-worker.mjs'
$privateEnv = Join-Path $projectDirectory '.env.cloud.local'
$workerDirectory = Join-Path $projectDirectory 'work\subscription-worker-service'
if (!(Test-Path -LiteralPath $privateEnv)) { throw 'Project server settings are missing.' }
New-Item -ItemType Directory -Path $workerDirectory -Force | Out-Null
$pidFile = Join-Path $workerDirectory 'worker.pid'
if (Test-Path -LiteralPath $pidFile) {
    $savedWorkerId = [int](Get-Content -LiteralPath $pidFile -Raw)
    $existingWorker = Get-CimInstance Win32_Process -Filter "ProcessId=$savedWorkerId"
    if ($existingWorker -and $existingWorker.CommandLine.Contains($workerScript)) { Write-Output 'IMO 3D plan worker is already running.'; return }
}
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$env:IMO3D_CODEX_BIN = (Get-Command codex -ErrorAction Stop).Source
$workerProcess = Start-Process -FilePath $nodeExecutable -ArgumentList @('--env-file="' + $privateEnv + '"', '"' + $workerScript + '"') -WorkingDirectory $projectDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $workerDirectory 'worker.log') -RedirectStandardError (Join-Path $workerDirectory 'worker-error.log') -PassThru
Set-Content -LiteralPath $pidFile -Value $workerProcess.Id
Write-Output 'IMO 3D plan worker started. Keep this computer awake and connected during generation.'
