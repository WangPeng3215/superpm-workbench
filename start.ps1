﻿﻿﻿#Requires -Version 5.1
<#
  superPM workbench 启动脚本

  用法：
    .\start.ps1            开发模式：API http://127.0.0.1:3001，前端 http://127.0.0.1:5173
    .\start.ps1 -Prod      生产模式：构建后由 http://127.0.0.1:3001 单服务提供前端与 API

  停止：在终端按 Ctrl+C
#>
[CmdletBinding()]
param(
  [switch]$Prod
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Invoke-Npm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$NpmArgs)
  & npm @NpmArgs
  if ($LASTEXITCODE -ne 0) {
    throw "npm $($NpmArgs -join ' ') 执行失败（退出码 $LASTEXITCODE）。"
  }
}

# 1. 校验 Node 版本（package.json engines: >=22.12.0 <25）
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw '未找到 Node.js，请先安装 Node 22 LTS（>=22.12.0）。'
}
$nodeVersion = [version]((node -v).TrimStart('v'))
if ($nodeVersion -lt [version]'22.12.0' -or $nodeVersion -ge [version]'25.0.0') {
  throw "当前 Node 版本为 $nodeVersion，项目要求 >=22.12.0 且 <25。"
}
Write-Host "Node $nodeVersion" -ForegroundColor DarkGray

# 2. 校验依赖
if (-not (Test-Path -LiteralPath 'node_modules')) {
  Write-Host '未找到 node_modules，正在安装依赖…' -ForegroundColor Yellow
  Invoke-Npm install
}

# 3. 启动
if ($Prod) {
  Write-Host '生产模式：构建前端与后端…' -ForegroundColor Cyan
  Invoke-Npm run build
  Write-Host '服务已启动：http://127.0.0.1:3001   （Ctrl+C 停止）' -ForegroundColor Green
  Invoke-Npm start
}
else {
  Write-Host '开发模式启动中…' -ForegroundColor Cyan
  Write-Host '  API   http://127.0.0.1:3001' -ForegroundColor Green
  Write-Host '  前端  http://127.0.0.1:5173   （Ctrl+C 停止）' -ForegroundColor Green
  Invoke-Npm run dev
}
