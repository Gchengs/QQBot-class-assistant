@echo off
chcp 65001 >nul
title QQ 群待办机器人
cd /d "%~dp0"

echo ============================================
echo   QQ 群待办机器人
echo   目录：%CD%
echo ============================================
echo.

if not exist node_modules (
  echo 首次运行，正在安装依赖……
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo 提示：这个窗口要一直开着，关掉机器人就停了。
echo 按 Ctrl+C 可以彻底停止。
echo.

:loop
echo [%date% %time%] 启动
node src/index.js
rem 退出码 78 = 数据版本比程序新，重启多少次都没用，只会刷屏
if errorlevel 78 (
  echo.
  echo 数据版本与当前程序不匹配，已停止。请更新程序后再启动，data 目录没有被改动。
  pause
  exit /b 78
)
echo.
echo 机器人已退出（退出码 %errorlevel%），5 秒后自动重启……
timeout /t 5 /nobreak >nul
goto loop
