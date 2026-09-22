param(
  [Parameter(Mandatory=$true)][ValidateSet('plans','photos')][string]$Role,
  [Parameter(Mandatory=$true)][string]$NodePath
)
$ErrorActionPreference='Stop'
$projectRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodeExecutable=(Resolve-Path -LiteralPath $NodePath).Path
$hashAlgorithm=[Security.Cryptography.SHA256]::Create()
try {$rootHash=[BitConverter]::ToString($hashAlgorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant()))).Replace('-','').Substring(0,16)} finally {$hashAlgorithm.Dispose()}
$mutex=[Threading.Mutex]::new($false,"Local\IMO3D-$rootHash-$Role")
$acquired=$false
try {
  try {$acquired=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$acquired=$true}
  if(-not $acquired){exit 0}
  $supervisor=Join-Path $PSScriptRoot 'imo3d-device-supervisor.mjs'
  $worker=Start-Process -FilePath $nodeExecutable -ArgumentList @(('"'+$supervisor+'"'),$Role) -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait -PassThru
  exit $worker.ExitCode
} finally {
  if($acquired){$mutex.ReleaseMutex()}
  $mutex.Dispose()
}
