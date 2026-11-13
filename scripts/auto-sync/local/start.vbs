' start.vbs - Route1 auto-sync: windowless launcher
'
' Runs tray.ps1 through wscript.exe with a hidden window (SW_HIDE), so double-clicking
' this file never flashes a PowerShell console. The tray itself has no window; after
' launch you only see one download icon in the notification area.
'
' Usage: double-click this file. The "start at logon" entry created by the tray menu
' also points here.
'
' NOTE: keep this file ASCII-only. Windows Script Host reads .vbs as ANSI, so non-ASCII
' characters would be garbled (or break parsing) on non-English Windows.

Option Explicit
Dim fso, shell, here, ps1
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(here, "tray.ps1")

If Not fso.FileExists(ps1) Then
  MsgBox "tray.ps1 not found: " & ps1, 16, "Auto Sync"
  WScript.Quit 1
End If

shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
