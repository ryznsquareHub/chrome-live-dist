' Start the chrome-live daemon (server.js next to this file) with no console window.
' Location-independent: works from any install folder.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "node """ & here & "\server.js""", 0, False
