#Requires -Version 5.1
<#
  统一启动 superPM 开发服务与 prototype-workbench 原型服务。

  用法：
    .\start-services.ps1                    # 两个项目，默认 all
    .\start-services.ps1 -Target superpm
    .\start-services.ps1 -Target prototype -PrototypePort 5199
    .\start-services.ps1 -Target all -TimeoutSeconds 180

  行为：
    - 已健康运行的本仓库实例直接复用，不重启、不杀进程。
    - 端口被其他进程占用时失败，不自动清理。
    - 启动的进程在后台运行，日志写入 runtime/skill/logs/。
    - 原型项目缺失或为空时，按配置从公共模板 Clone 并安装依赖。
    - 已存在的原型项目只校验和复用，不 Pull、不重置、不覆盖。
    - 原型服务失败不影响 superPM 主服务。
#>
[CmdletBinding()]
param(
  [ValidateSet('all', 'superpm', 'prototype')]
  [string]$Target = 'all',
  [int]$PrototypePort = 0,
  [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
. (Join-Path $PSScriptRoot '_prototype-init.ps1')

$repoRoot = Assert-SuperpmRepo -ScriptRoot $PSScriptRoot
$results = New-Object System.Collections.ArrayList
$failures = New-Object System.Collections.ArrayList

function Write-Tail {
  param([string]$Path, [int]$Lines = 20)
  if (Test-Path -LiteralPath $Path) {
    Write-Host "---- $Path（最后 $Lines 行）----" -ForegroundColor DarkGray
    Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction SilentlyContinue | ForEach-Object {
      Write-Host "  $_" -ForegroundColor DarkGray
    }
  }
}

function Start-SuperpmService {
  $apiPort = Get-SuperpmApiPort -RepoRoot $repoRoot
  $webPort = Get-SuperpmWebPort -RepoRoot $repoRoot
  $proxyPort = Get-SuperpmProxyPort -RepoRoot $repoRoot
  $apiUrl = "http://127.0.0.1:$apiPort/api/health"
  $webUrl = "http://127.0.0.1:$webPort/"

  if ($proxyPort -and $proxyPort -ne $apiPort) {
    throw "Web 代理端口 $proxyPort 与 API 端口 $apiPort 不一致；请先同步 apps/web/vite.config.ts 或 .env。"
  }

  $health = Get-SuperpmHealth -Port $apiPort
  $web = Invoke-WebProbe -Url $webUrl
  if ($health -and $health.status -eq 'ok' -and $web.Ok) {
    $webPid = Get-ListenerPid -Port $webPort
    if (-not $webPid -or -not (Test-SuperpmWebProcess -ProcessId $webPid -RepoRoot $repoRoot)) {
      throw "superPM API 健康，但 $webPort 的 Web 实例不属于本仓库；请检查端口占用。"
    }
    Write-Host "superPM 已在运行，复用现有实例。" -ForegroundColor DarkGray
    return [pscustomobject]@{
      Service = 'superPM'
      State   = 'running'
      Url     = "http://127.0.0.1:$webPort"
      Port    = $webPort
      Pid     = $health.pid
      Detail  = "复用 · API $apiPort · v$($health.version)"
    }
  }
  if ($health -or $web.Ok) {
    throw "superPM 处于部分运行状态（API=$([bool]$health)，Web=$($web.Ok)）；请先运行 stop-services.ps1 -Target superpm 再整体启动。"
  }

  foreach ($port in @($apiPort, $webPort)) {
    $listener = Get-ListenerPid -Port $port
    if ($listener) {
      $detail = Get-ProcessDetail -ProcessId $listener
      $name = if ($detail) { $detail.Name } else { 'unknown' }
      throw "端口 $port 已被进程 $listener（$name）占用；未自动清理。"
    }
  }

  $startScript = Join-Path $repoRoot 'start.ps1'
  if (-not (Test-Path -LiteralPath $startScript)) {
    throw "找不到现有启动脚本：$startScript"
  }

  $logDir = Get-SkillLogDir -RepoRoot $repoRoot
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdoutLog = Join-Path $logDir "superpm-$stamp.out.log"
  $stderrLog = Join-Path $logDir "superpm-$stamp.err.log"
  $arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $startScript

  Write-Host "启动 superPM 开发服务（API $apiPort，Web $webPort）…" -ForegroundColor Cyan
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $repoRoot `
    -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru

  $state = [pscustomobject]@{
    service    = 'superpm'
    status     = 'starting'
    pid        = $process.Id
    apiPort    = $apiPort
    webPort    = $webPort
    startedAt  = (Get-Date).ToString('o')
    log        = $stdoutLog
    errorLog   = $stderrLog
    managed    = $true
  }
  Write-SkillState -RepoRoot $repoRoot -Service 'superpm' -State $state

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $health = $null
  $web = $null
  while ((Get-Date) -lt $deadline) {
    $health = Get-SuperpmHealth -Port $apiPort
    $web = Invoke-WebProbe -Url $webUrl
    if ($health -and $health.status -eq 'ok' -and $web.Ok) { break }
    Start-Sleep -Milliseconds 800
  }

  $ready = ($health -and $health.status -eq 'ok' -and $web.Ok)
  if (-not $ready) {
    $state.status = 'failed'
    Write-SkillState -RepoRoot $repoRoot -Service 'superpm' -State $state
    Write-Tail -Path $stdoutLog
    Write-Tail -Path $stderrLog
    throw "superPM 启动超时（${TimeoutSeconds}s）。日志：$stdoutLog；停止：stop-services.ps1 -Target superpm"
  }

  $webPid = Get-ListenerPid -Port $webPort
  if (-not $webPid -or -not (Test-SuperpmWebProcess -ProcessId $webPid -RepoRoot $repoRoot)) {
    $state.status = 'failed'
    Write-SkillState -RepoRoot $repoRoot -Service 'superpm' -State $state
    throw "superPM Web 已响应，但 $webPort 的监听进程不属于本仓库；请检查日志与端口占用。"
  }

  $state.status = 'running'
  Write-SkillState -RepoRoot $repoRoot -Service 'superpm' -State $state
  return [pscustomobject]@{
    Service = 'superPM'
    State   = 'running'
    Url     = "http://127.0.0.1:$webPort"
    Port    = $webPort
    Pid     = $health.pid
    Detail  = "新启动 · API $apiPort · v$($health.version)"
  }
}

function Start-PrototypeService {
  $prototypePath = Get-PrototypePath -RepoRoot $repoRoot
  $port = Resolve-PrototypePort -RepoRoot $repoRoot -Requested $PrototypePort
  $project = Get-PrototypeProjectStatus -PrototypePath $prototypePath

  if ($project.State -eq 'Missing' -or $project.State -eq 'Empty') {
    if (-not (Get-PrototypeAutoClone -RepoRoot $repoRoot)) {
      throw "原型项目尚未初始化（$prototypePath），且已禁用自动 Clone（SUPERPM_PROTOTYPE_AUTO_CLONE=0）。"
    }
    Write-Host "原型项目尚未初始化，开始从公共模板初始化：$prototypePath" -ForegroundColor Cyan
    $init = Invoke-PrototypeInitialization -RepoRoot $repoRoot -PrototypePath $prototypePath `
      -InstallDependencies (Get-PrototypeAutoInstall -RepoRoot $repoRoot)
    if (-not $init.Ok) {
      throw "原型项目初始化失败（$($init.State)）：$($init.Message)"
    }
    $prototypePath = $init.Path
    $project = Get-PrototypeProjectStatus -PrototypePath $prototypePath
  } elseif ($project.State -eq 'Incomplete' -or $project.State -eq 'Conflict') {
    $detail = @($project.Missing) + @($project.Notes) | Where-Object { $_ }
    throw "本地原型项目异常（$($project.State)：$prototypePath），未覆盖、未重建。$($detail -join '；')"
  }

  if (-not $project.HasNodeModules) {
    throw "原型项目缺少 node_modules；请在 $prototypePath 执行 $(Get-PrototypeDependencyHint -Status $project)。"
  }

  $page = Test-PrototypePage -Port $port
  $listener = Get-ListenerPid -Port $port
  if ($page.Ok) {
    if (-not $listener -or -not (Test-PrototypeProcess -ProcessId $listener -PrototypePath $prototypePath)) {
      throw "端口 $port 的页面响应但监听进程身份不匹配；未启动新实例。"
    }
    Write-Host "prototype-workbench 已在 http://localhost:$port 运行，复用现有实例。" -ForegroundColor DarkGray
    return [pscustomobject]@{
      Service = 'prototype-workbench'
      State   = 'running'
      Url     = $page.Url
      Port    = $port
      Pid     = $listener
      Detail  = '复用 · Vite'
    }
  }

  if ($listener) {
    $detail = Get-ProcessDetail -ProcessId $listener
    $name = if ($detail) { $detail.Name } else { 'unknown' }
    throw "端口 $port 已被进程 $listener（$name）占用；换 -PrototypePort 或先确认占用者。"
  }

  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) { throw '未找到 npm.cmd，请确认 Node.js/npm 已安装并在 PATH 中。' }

  $logDir = Get-SkillLogDir -RepoRoot $repoRoot
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdoutLog = Join-Path $logDir "prototype-$stamp.out.log"
  $stderrLog = Join-Path $logDir "prototype-$stamp.err.log"

  Write-Host "启动 prototype-workbench（端口 $port）…" -ForegroundColor Cyan
  $process = Start-Process -FilePath $npm.Source -ArgumentList @('run', 'dev', '--', '--port', "$port", '--strictPort') `
    -WorkingDirectory $prototypePath -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru

  $state = [pscustomobject]@{
    service    = 'prototype'
    status     = 'starting'
    pid        = $process.Id
    port       = $port
    startedAt  = (Get-Date).ToString('o')
    log        = $stdoutLog
    errorLog   = $stderrLog
    managed    = $true
  }
  Write-SkillState -RepoRoot $repoRoot -Service 'prototype' -State $state

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $page = $null
  $listener = $null
  while ((Get-Date) -lt $deadline) {
    $page = Test-PrototypePage -Port $port
    $listener = Get-ListenerPid -Port $port
    if ($page.Ok -and $listener -and (Test-PrototypeProcess -ProcessId $listener -PrototypePath $prototypePath)) {
      break
    }
    Start-Sleep -Milliseconds 800
  }

  $ready = $page -and $page.Ok -and $listener -and (Test-PrototypeProcess -ProcessId $listener -PrototypePath $prototypePath)
  if (-not $ready) {
    $state.status = 'failed'
    Write-SkillState -RepoRoot $repoRoot -Service 'prototype' -State $state
    Write-Tail -Path $stdoutLog
    Write-Tail -Path $stderrLog
    throw "prototype-workbench 启动超时或身份校验失败（${TimeoutSeconds}s）。日志：$stdoutLog；停止：stop-services.ps1 -Target prototype"
  }

  $state.status = 'running'
  Write-SkillState -RepoRoot $repoRoot -Service 'prototype' -State $state
  return [pscustomobject]@{
    Service = 'prototype-workbench'
    State   = 'running'
    Url     = $page.Url
    Port    = $port
    Pid     = $listener
    Detail  = '新启动 · Vite'
  }
}

Write-Host "仓库根：$repoRoot" -ForegroundColor DarkGray

if ($Target -eq 'all' -or $Target -eq 'superpm') {
  try {
    $null = $results.Add((Start-SuperpmService))
  } catch {
    $null = $failures.Add("superPM：$($_.Exception.Message)")
    Write-Host "superPM 启动失败：$($_.Exception.Message)" -ForegroundColor Red
  }
}

if ($Target -eq 'all' -or $Target -eq 'prototype') {
  try {
    $null = $results.Add((Start-PrototypeService))
  } catch {
    $null = $failures.Add("prototype-workbench：$($_.Exception.Message)")
    Write-Host "prototype-workbench 启动失败：$($_.Exception.Message)" -ForegroundColor Red
  }
}

Write-Host ''
if ($results.Count -gt 0) {
  $results | Format-Table Service, State, Url, Port, Pid, Detail -AutoSize | Out-String | Write-Host
}
if ($failures.Count -gt 0) {
  Write-Host '启动未全部完成：' -ForegroundColor Red
  foreach ($failure in $failures) { Write-Host " - $failure" -ForegroundColor Red }
  exit 1
}
Write-Host "启动完成。日志目录：$(Get-SkillLogDir -RepoRoot $repoRoot)" -ForegroundColor Green
exit 0
