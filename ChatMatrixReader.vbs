' Starts ChatMatrix Reader without any console window.
' First time (no .venv yet) it runs run.bat once so the setup is visible.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
py = dir & "\.venv\Scripts\pythonw.exe"
' requirements.txt changed since the last install (a new package): run.bat installs what is missing first
Function Current()
    Current = False
    If Not fso.FileExists(dir & "\.venv\requirements.done") Then Exit Function
    Current = (fso.OpenTextFile(dir & "\requirements.txt").ReadAll() = fso.OpenTextFile(dir & "\.venv\requirements.done").ReadAll())
End Function

If fso.FileExists(dir & "\.venv\.ready") And fso.FileExists(py) And Current() Then
    sh.Run """" & py & """ """ & dir & "\app\app.py""", 0, False
Else
    sh.Run """" & dir & "\run.bat""", 1, False
End If
