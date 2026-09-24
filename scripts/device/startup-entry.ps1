<#
  Adds (or with -Remove, removes) the Startup-folder entry that starts the device workers hidden at
  Windows sign-in. No administrator rights and no scheduled task. Run it from the deploy folder:
  the entry points at that folder's device-workers-hidden.vbs.
#>
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$live = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path -LiteralPath (Join-Path $live 'device.json'))) { throw "run this from a deploy folder, not the repository: $live" }
$entry = Join-Path ([Environment]::GetFolderPath('Startup')) 'BMK Tour 360 Workers.lnk'
if ($Remove) {
  if (Test-Path -LiteralPath $entry) { Remove-Item -LiteralPath $entry -Force; 'startup entry removed' } else { 'no startup entry' }
  return
}
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($entry)
$link.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$link.Arguments = '"' + (Join-Path $PSScriptRoot 'device-workers-hidden.vbs') + '"'
$link.WorkingDirectory = $live
$link.WindowStyle = 7
$link.Description = 'BMK Tour 360 device workers (hidden)'
$link.Save()
"startup entry written: $entry"
