<#
  Builds the PC device-worker folder from a COMMIT, never from the working tree (the studio's
  studio-live pattern): in-progress edits can never reach a running worker.

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\device\build-device-live.ps1 [-Commit <ref>]

  The folder holds the committed scripts\ and src\, plus JUNCTIONS (no copies) to this repository's
  node_modules and bundled Python/model runtimes under work\. It holds no secret: the workers read the
  owner's single env file (.env.cloud.local in this repository) through IMO3D_ENV_FILE.
  Nothing is started. Rebuilding refuses while a worker runs from the folder.
#>
param(
  [string]$Commit = 'HEAD',
  [string]$Target = 'D:\BMK\tour360\device-live',
  [string]$Python = (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe')
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$sha = (& git -C $repo rev-parse --verify "$Commit^{commit}").Trim()
if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[0-9a-f]{40}$') { throw "not a commit: $Commit" }
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) { throw "Python not found: $Python" }
$node = (Get-Command node -ErrorAction Stop).Source
$envFile = Join-Path $repo '.env.cloud.local'

# A worker runs a script from inside the folder; this build's own command line only names the folder.
$inside = (Join-Path $Target 'scripts')
$running = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($inside, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
if ($running.Count) { throw "a worker runs from $Target (pid $(($running | ForEach-Object ProcessId) -join ', ')); stop it first with stop-device-workers.ps1" }

# Junctions are unlinked one by one before any folder is removed: a recursive delete must never
# walk into the repository's runtimes or node_modules.
function Remove-DeviceFolder([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $links = @(Join-Path $Path 'node_modules')
  $work = Join-Path $Path 'work'
  if (Test-Path -LiteralPath $work) { $links += @(Get-ChildItem -LiteralPath $work -Force | ForEach-Object FullName) }
  foreach ($link in $links) {
    $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { [IO.Directory]::Delete($item.FullName) }
  }
  foreach ($link in $links) {
    $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "could not unlink $link; nothing was deleted" }
  }
  [IO.Directory]::Delete($Path, $true)
}

$parent = Split-Path -Parent $Target
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$staging = "$Target.new"
Remove-DeviceFolder $staging
New-Item -ItemType Directory -Path $staging | Out-Null

$tar = Join-Path $env:TEMP ("tour360-device-" + $sha.Substring(0, 12) + ".tar")
try {
  & git -C $repo archive --format=tar -o $tar $sha scripts src package.json tsconfig.json
  if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
  & tar -xf $tar -C $staging
  if ($LASTEXITCODE -ne 0) { throw 'tar extract failed' }
} finally { Remove-Item -LiteralPath $tar -Force -ErrorAction SilentlyContinue }

New-Item -ItemType Junction -Path (Join-Path $staging 'node_modules') -Target (Join-Path $repo 'node_modules') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $staging 'work') | Out-Null
# Read-only runtimes the workers resolve under <root>\work (Python packages, model weights).
$runtimes = 'gpu-python','reconstruction-python','reconstruction-python-user','reconstruction-python-verified',
  'registration-learned-python','registration-models','registration-recovery','layout-python-verified','layout-model',
  'da3-model','da3-python','depth-model','room-vision-python-verified','vlm-python-verified','room-vision-models'
$linked = @()
foreach ($name in $runtimes) {
  $source = Join-Path $repo "work\$name"
  $item = Get-Item -LiteralPath $source -Force -ErrorAction SilentlyContinue
  if ($item -and $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    New-Item -ItemType Junction -Path (Join-Path $staging "work\$name") -Target $source | Out-Null
    $linked += $name
  }
}

$utf8 = New-Object Text.UTF8Encoding $false
$runtime = [ordered]@{ python = $Python; cvPath = (Join-Path $Target 'work\reconstruction-python-user') }
[IO.File]::WriteAllText((Join-Path $staging 'work\reconstruction-runtime.json'), ($runtime | ConvertTo-Json), $utf8)
$device = [ordered]@{
  commit = $sha; builtAt = (Get-Date).ToUniversalTime().ToString('o'); repository = $repo
  envFile = $envFile; python = $Python; node = $node; runtimes = $linked
}
[IO.File]::WriteAllText((Join-Path $staging 'device.json'), ($device | ConvertTo-Json), $utf8)

$previous = "$Target.old"
if (Test-Path -LiteralPath $Target) {
  Remove-DeviceFolder $previous
  Rename-Item -LiteralPath $Target -NewName (Split-Path -Leaf $previous)
}
Rename-Item -LiteralPath $staging -NewName (Split-Path -Leaf $Target)
[ordered]@{ built = $Target; commit = $sha; runtimes = $linked.Count; previous = (Test-Path -LiteralPath $previous) } | ConvertTo-Json -Compress
