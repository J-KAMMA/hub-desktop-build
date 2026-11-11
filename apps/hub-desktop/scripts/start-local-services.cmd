@echo off
rem Starts the local Hub (port 3020) and the Account service (port 8791) that Hub Desktop needs.
rem Double-click this file. Two windows open; close them to stop the services.
rem The Account state lives in the main checkout; set HUB_ACCOUNT_DIR to use another folder.
setlocal
set "HUB_DIR=%~dp0..\..\hub"
if "%HUB_ACCOUNT_DIR%"=="" set "HUB_ACCOUNT_DIR=C:\jkamma-platform\services\account"
if not exist "%HUB_DIR%\package.json" ( echo Hub folder not found: %HUB_DIR% & pause & exit /b 1 )
if not exist "%HUB_ACCOUNT_DIR%\wrangler.jsonc" ( echo Account folder not found: %HUB_ACCOUNT_DIR% & pause & exit /b 1 )
start "Hub 3020" cmd /k "cd /d "%HUB_DIR%" && npm run dev -- -p 3020"
start "Account 8791" cmd /k "cd /d "%HUB_ACCOUNT_DIR%" && npx wrangler dev --port 8791"
endlocal
