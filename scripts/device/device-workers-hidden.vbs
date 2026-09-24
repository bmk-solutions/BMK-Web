' BMK TOUR 360 - start the device workers with no window at all (used by the Windows startup entry).
' wscript runs PowerShell with window style 0 (hidden) and does not wait, so logon is never held up.
Dim shell, folder
Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & folder & "\ensure-device-workers.ps1""", 0, False
