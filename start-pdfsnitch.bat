@echo off

cd /d "C:\Users\HR\Documents\Codex\2026-06-20\build-web-apps-plugin-build-web-2"

start "PDFSnitch Backend" powershell -NoExit -Command "python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000"

timeout /t 10 >nul

start "PDFSnitch Frontend" powershell -NoExit -Command "pnpm run dev"