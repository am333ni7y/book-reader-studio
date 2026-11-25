@echo off
setlocal
cd /d "%~dp0"
node "%~dp0bin\ketabkhan.mjs" start --open %*
