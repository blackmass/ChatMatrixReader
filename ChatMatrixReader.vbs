' Starts ChatMatrix Reader without any console window.
' First time (no .venv yet) it runs run.bat once so the setup is visible.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
py = dir & "\.venv\Scripts\pythonw.exe"
If fso.FileExists(dir & "\.venv\.ready") And fso.FileExists(py) Then
    sh.Run """" & py & """ """ & dir & "\app.py""", 0, False
Else
    sh.Run """" & dir & "\run.bat""", 1, False
End If
