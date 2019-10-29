ECHO OFF

ECHO.
ECHO ----------------------------------------
ECHO Start Download Visual Studio Build Tools
ECHO ----------------------------------------

powershell -Command "(New-Object Net.WebClient).DownloadFile('https://download.visualstudio.microsoft.com/download/pr/11503713/e64d79b40219aea618ce2fe10ebd5f0d/vs_BuildTools.exe', 'vs_BuildTools.exe')"

ECHO.
ECHO ----------------------------------------
ECHO End Download Visual Studio Build Tools
ECHO ----------------------------------------
ECHO.
ECHO ----------------------------------------
ECHO Start Install Visual Studio Build Tools
ECHO ----------------------------------------

vs_buildtools.exe --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet --wait

ECHO.
ECHO ----------------------------------------
ECHO End Install Visual Studio Build Tools
ECHO ----------------------------------------

DEL "vs_buildtools.exe"

PAUSE
