ECHO OFF

ECHO.
ECHO ----------------------------------------
ECHO check Node.js version
ECHO ----------------------------------------

FOR /F "tokens=*" %%a IN ('node -v') DO (SET NODEJS_V=%%a)
ECHO Installed Node.js version %NODEJS_V%
FOR /F "tokens=1 delims=." %%a IN ("%NODEJS_V%") DO (SET NODEJS_V=%%a)
SET NODEJS_V=%NODEJS_V:~1,2%
SET NODEJS_V_MIN=8

if %NODEJS_V_MIN% GTR %NODEJS_V% (
	ECHO ERROR Node.js version! %NODEJS_V_MIN% more than %NODEJS_V%. Min version Node.js 8.x
	goto ERROR
)

ECHO.
ECHO ----------------------------------------
ECHO restart RabbitMQ node to prevent "Erl.exe high CPU usage every Monday morning on Windows" https://groups.google.com/forum/#!topic/rabbitmq-users/myl74gsYyYg
ECHO ----------------------------------------

call restart-rabbit.bat

ECHO.
ECHO ----------------------------------------
ECHO copy file to converter
ECHO ----------------------------------------

call update-core.bat

mkdir "%~dp0\App_Data"

mkdir "%~dp0\SpellChecker\dictionaries"
cd /D "%~dp0\SpellChecker" || goto ERROR
xcopy /s/e/k/c/y/q "..\..\dictionaries" ".\dictionaries"

ECHO.
ECHO ----------------------------------------
ECHO Start build skd-all.js
ECHO ----------------------------------------
CD /D %~dp0\..\sdkjs\build
call npm install -g grunt-cli
call npm install
call grunt --src="./configs" --level=WHITESPACE_ONLY --formatting=PRETTY_PRINT

ECHO.
ECHO ----------------------------------------
ECHO Start build web-apps
ECHO ----------------------------------------
CD /D %~dp0\..\web-apps\build
call npm install
CD /D %~dp0\..\web-apps\build\sprites
call npm install
call grunt

ECHO.
ECHO ----------------------------------------
ECHO Start build themes.js
ECHO ----------------------------------------
CD /D %~dp0\FileConverter\Bin
reg Query "HKLM\Hardware\Description\System\CentralProcessor\0" | find /i "x86" > NUL && set OS=32&&set OS2=x86||set OS=64&& set OS2=x64
"core\build\bin\win_%OS%\allthemesgen.exe" --converter-dir="%~dp0\FileConverter\Bin" --src="%~dp0\..\sdkjs\slide\themes" --output="%~dp0\..\sdkjs\common\Images"

ECHO.
ECHO ----------------------------------------
ECHO Install node.js modules 
ECHO ----------------------------------------

CD /D %~dp0\DocService || goto ERROR
call npm install

cd /D ..\Common || goto ERROR
call npm install

cd /D ..\FileConverter || goto ERROR
call npm install

cd /D ..\SpellChecker || goto ERROR
call npm install

SET RUN_DIR=%~dp0
SET NODE_ENV=development-windows
SET NODE_CONFIG_DIR=%RUN_DIR%\Common\config

cd "%RUN_DIR%\DocService\sources"
start /min /b node server.js
start /min /b node gc.js

cd "%RUN_DIR%\FileConverter\sources"
start /min /b node convertermaster.js

cd "%RUN_DIR%\SpellChecker\sources"
start /min /b node server.js

:ERROR
:SUCCESS
pause
