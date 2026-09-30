@echo off
rem Starts the Model Cockpit. Double-click this file, or run it in a terminal.
cd /d "%~dp0"
where node >NUL 2>NUL || (echo Node.js is not installed. Install Node.js 22.13 or newer from https://nodejs.org & pause & exit /b 1)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" || (echo Node.js 22.13 or newer is necessary. & node -v & pause & exit /b 1)
if not exist node_modules\.bin\vite.cmd (echo Installing packages... & call npm install || (pause & exit /b 1))
call npm start
pause
