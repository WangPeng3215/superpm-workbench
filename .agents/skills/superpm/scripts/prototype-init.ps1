#Requires -Version 5.1
<#
  初始化本地 prototype-workbench。

  用法：
    .\prototype-init.ps1
    .\prototype-init.ps1 -PrototypePath D:\project\prototype-workbench
    .\prototype-init.ps1 -SkipInstall
    .\prototype-init.ps1 -Json

  行为：
    - 目标不存在或为空：从配置的公共模板仓库 Clone，并校验、记录模板版本、安装依赖。
    - 目标已是有效项目：保留本地内容，不 Pull、不重置、不覆盖。
    - 目标非空但不是 prototype-workbench：停止并提示，不自动清理或重建。
    - 依赖安装失败：保留项目，输出错误和日志路径。

  退出码：
    0 已初始化或本地项目有效
    1 未预期错误
    2 未安装 Git
    3 初始化被配置禁用或仓库地址无效
    4 路径冲突或目标非空
    5 Clone 失败
    6 项目校验失败
    7 依赖安装失败
    8 本地初始化信息写入失败

  配置（环境变量或仓库根 .env）：
    SUPERPM_PROTOTYPE_DIR
    SUPERPM_PROTOTYPE_REPOSITORY
    SUPERPM_PROTOTYPE_AUTO_CLONE
    SUPERPM_PROTOTYPE_AUTO_INSTALL
#>
[CmdletBinding()]
param(
  [string]$PrototypePath = '',
  [string]$Repository = '',
  [switch]$SkipInstall,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
. (Join-Path $PSScriptRoot '_prototype-init.ps1')

$repoRoot = Assert-SuperpmRepo -ScriptRoot $PSScriptRoot
$installDependencies = (-not $SkipInstall) -and (Get-PrototypeAutoInstall -RepoRoot $repoRoot)

try {
  $result = Invoke-PrototypeInitialization -RepoRoot $repoRoot -PrototypePath $PrototypePath `
    -Repository $Repository -InstallDependencies $installDependencies -Quiet:$Json
} catch {
  $message = "原型项目初始化出现未预期错误：$($_.Exception.Message)"
  $safeRepository = Get-PrototypeRepositoryDisplay -Repository $Repository
  $result = New-PrototypeInitResult -Ok $false -ExitCode 1 -Action 'error' -Message $message -Repository $safeRepository
}

if ($Json) {
  ConvertTo-Json -InputObject $result -Depth 8
} else {
  $color = if ($result.Ok) { 'Green' } else { 'Red' }
  Write-Host $result.Message -ForegroundColor $color
  if ($result.Path) { Write-Host "路径：$($result.Path)" }
  if ($result.TemplateVersion) { Write-Host "模板版本：$($result.TemplateVersion)" }
  if ($result.Repository) { Write-Host "模板仓库：$($result.Repository)" }
  if ($result.PackageManager) { Write-Host "包管理器：$($result.PackageManager)" }
  if ($result.LogPath) { Write-Host "日志：$($result.LogPath)" }
}

exit $result.ExitCode
