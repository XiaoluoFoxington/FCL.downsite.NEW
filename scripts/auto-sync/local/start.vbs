' start.vbs - fdn-autosync-tray: windowless launcher
'
' Runs tray.ps1 through powershell.exe with a hidden window, so double-clicking
' this file never flashes a console. The tray itself has no window: after launch
' you only see one icon in the notification area.
'
' Usage: double-click this file. The "start at logon" shortcut created by
' tray.ps1 -Install (or by the tray menu) also points here.
'
' NOTE: keep this file ASCII-only. Windows Script Host reads .vbs as ANSI, so
' non-ASCII characters would be garbled (or break parsing) on non-English
' Windows.

Option Explicit

Dim fso, shell, here, ps1, cmd, extraArgs, i

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(here, "tray.ps1")

If Not fso.FileExists(ps1) Then
  MsgBox "tray.ps1 not found:" & vbCrLf & ps1, 16, "fdn-autosync-tray"
  WScript.Quit 1
End If

extraArgs = ""
For i = 0 To WScript.Arguments.Count - 1
  If LCase(WScript.Arguments(i)) = "/from-restart" Then
    extraArgs = extraArgs & " -FromRestart"
  End If
Next

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """" & extraArgs

' 0 = hidden window; False = do not wait for it to exit
shell.Run cmd, 0, False

WScript.Quit 0