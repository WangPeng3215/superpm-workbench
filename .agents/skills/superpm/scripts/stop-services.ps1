#Requires -Version 5.1
<#
  停止 superPM 开发服务与 prototype-workbench 原型服务。

  用法：
    .\stop-services.ps1                     # 两个项目
    .\stop-services.ps1 -Target superpm
    .\stop-services.ps1 -Target prototype -PrototypePort 5199
    .\stop-services.ps1 -Target superpm -Force   # 优雅停止失败时，校验进程身份后强制结束

  安全边界：
    - superPM 优先走 /api/shutdown 一次性令牌；PID 不一致时默认拒绝。
    - 只有确认属于本仓库的进程才会被结束，不按进程名批量清理。
    - 不处理安装版；安装版请使用安装目录 Stop.cmd / Stop.ps1。
#>
[CmdletBinding()]
param(
  [ValidateSet('all', 'superpm', 'prototype')]
  [string]$Target = 'all',
  [int]$PrototypePort = 0,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

$repoRoot = Assert-SuperpmRepo -ScriptRoot $PSScriptRoot
$results = New-Object System.Collections.ArrayList
$failures = New-Object System.Collections.ArrayList

function Stop-SuperpmService {
  $apiPort = Get-SuperpmApiPort -RepoRoot $repoRoot
  $webPort = Get-SuperpmWebPort -RepoRoot $repoRoot
  $webUrl = "http://127.0.0.1:$webPort/"
  $health = Get-SuperpmHealth -Port $apiPort
  $runtime = Read-SuperpmRuntime -RepoRoot $repoRoot
  $notes = New-Object System.Collections.ArrayList
  $didStop = $false

  if ($health) {
    if (-not $runtime) {
      if (-not $Force) {
        throw "API 健康但找不到 $(Get-SuperpmRuntimePath $repoRoot)；无法发送停止令牌。确认实例属于本仓库后可加 -Force。"
      }
      if (-not (Test-SuperpmServerProcess -ProcessId $health.pid -RepoRoot $repoRoot)) {
        throw "API PID $($health.pid) 不是本仓库开发态进程；未停止。安装版请使用 Stop.cmd。"
      }
      Stop-ProcessTree -ProcessId $health.pid
      $null = $notes.Add("已强制结束 API 进程树 $($health.pid)")
      $didStop = $true
    } elseif ([string]$runtime.pid -ne [string]$health.pid) {
      if (-not $Force) {
        throw "健康 PID $($health.pid) 与 runtime/server.json 的 PID $($runtime.pid) 不一致；未停止。确认后可加 -Force。"
      }
      if (-not (Test-SuperpmServerProcess -ProcessId $health.pid -RepoRoot $repoRoot)) {
        throw "API PID $($health.pid) 不是本仓库开发态进程；未停止。"
      }
      Stop-ProcessTree -ProcessId $health.pid
      $null = $notes.Add("已强制结束 API 进程树 $($health.pid)")
      $didStop = $true
    } else {
      $token = [string]$runtime.shutdownToken
      if ([string]::IsNullOrWhiteSpace($token)) {
        throw 'runtime/server.json 缺少停止令牌；未发送停止请求。'
      }
      $gracefulError = $null
      $stopScript = Join-Path (Join-Path (Join-Path $repoRoot 'scripts') 'install') 'Stop.ps1'
      if (Test-Path -LiteralPath $stopScript) {
        $dataRoot = Get-SuperpmDataRoot -RepoRoot $repoRoot
        $stopOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript -Home $dataRoot 2>&1 | Out-String
        if ($stopOutput.Trim()) { Write-Host $stopOutput.Trim() -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) {
          $gracefulError = "Stop.ps1 退出码 $LASTEXITCODE"
        }
      } else {
        try {
          $null = Invoke-WebRequest -Uri "http://127.0.0.1:$apiPort/api/shutdown" -Method Post `
            -Headers @{ 'x-superpm-shutdown-token' = $token } `
            -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 5
        } catch {
          $gracefulError = $_.Exception.Message
        }
      }

      $deadline = (Get-Date).AddSeconds(15)
      while ((Get-Date) -lt $deadline) {
        if (-not (Get-SuperpmHealth -Port $apiPort)) { break }
        Start-Sleep -Milliseconds 400
      }
      if (Get-SuperpmHealth -Port $apiPort) {
        if (-not $Force) {
          $suffix = if ($gracefulError) { "（$gracefulError）" } else { '' }
          throw "优雅停止未完成$suffix；确认后可加 -Force。"
        }
        if (-not (Test-SuperpmServerProcess -ProcessId $health.pid -RepoRoot $repoRoot)) {
          throw "API PID $($health.pid) 不是本仓库开发态进程；未停止。"
        }
        Stop-ProcessTree -ProcessId $health.pid
        $null = $notes.Add("已强制结束 API 进程树 $($health.pid)")
      } else {
        $null = $notes.Add('API 已优雅停止')
      }
      $didStop = $true
    }
  } else {
    $null = $notes.Add('API 原本未运行')
  }

  $webWasUp = (Invoke-WebProbe -Url $webUrl).Ok
  if ($webWasUp) {
    $deadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $deadline) {
      if (-not (Invoke-WebProbe -Url $webUrl).Ok) { break }
      Start-Sleep -Milliseconds 400
    }
  }
  if ((Invoke-WebProbe -Url $webUrl).Ok) {
    $webPid = Get-ListenerPid -Port $webPort
    if (-not $webPid -or -not (Test-SuperpmWebProcess -ProcessId $webPid -RepoRoot $repoRoot)) {
      throw "Web $webPort 仍可访问，但监听进程不属于本仓库；未停止。"
    }
    Stop-ProcessTree -ProcessId $webPid
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
      if (-not (Invoke-WebProbe -Url $webUrl).Ok) { break }
      Start-Sleep -Milliseconds 300
    }
    if ((Invoke-WebProbe -Url $webUrl).Ok) {
      throw "无法停止 Web 进程 $webPid；请手动检查。"
    }
    $null = $notes.Add("已结束 Web 进程树 $webPid")
    $didStop = $true
  } elseif ($webWasUp) {
    $null = $notes.Add('Web 已随开发进程退出')
  }

  $state = Read-SkillState -RepoRoot $repoRoot -Service 'superpm'
  if ($state -and $state.pid -and (Test-ProcessAlive -ProcessId ([int]$state.pid))) {
    if (Test-SuperpmLauncherProcess -ProcessId ([int]$state.pid) -RepoRoot $repoRoot) {
      Stop-ProcessTree -ProcessId ([int]$state.pid)
      $null = $notes.Add("已清理启动器 $($state.pid)")
    }
  }
  Remove-SkillState -RepoRoot $repoRoot -Service 'superpm'

  if (-not $didStop) { $null = $notes.Add('原本未运行') }
  return [pscustomobject]@{
    Service = 'superPM'
    State   = 'stopped'
    Url     = "http://127.0.0.1:$webPort"
    Port    = $webPort
    Pid     = $null
    Detail  = ($notes -join '；')
  }
}

function Stop-PrototypeService {
  $prototypePath = Get-PrototypePath -RepoRoot $repoRoot
  $port = Resolve-PrototypePort -RepoRoot $repoRoot -Requested $PrototypePort
  $page = Test-PrototypePage -Port $port
  $listener = Get-ListenerPid -Port $port
  $state = Read-SkillState -RepoRoot $repoRoot -Service 'prototype'
  $notes = New-Object System.Collections.ArrayList

  if (-not $listener -and -not $page.Ok) {
    Remove-SkillState -RepoRoot $repoRoot -Service 'prototype'
    return [pscustomobject]@{
      Service = 'prototype-workbench'
      State   = 'stopped'
      Url     = "http://localhost:$port"
      Port    = $port
      Pid     = $null
      Detail  = '原本未运行'
    }
  }

  if (-not $listener) {
    throw "端口 $port 有页面响应但没有可识别的监听进程；未停止。"
  }
  if (-not (Test-PrototypeProcess -ProcessId $listener -PrototypePath $prototypePath)) {
    throw "端口 $port 的监听进程 $listener 不属于 prototype-workbench；未停止。"
  }

  Stop-ProcessTree -ProcessId $listener
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-ListenerPid -Port $port)) { break }
    Start-Sleep -Milliseconds 300
  }
  $remaining = Get-ListenerPid -Port $port
  if ($remaining) {
    if ($remaining -eq $listener) {
      throw "原型进程 $listener 未能结束；请手动检查。"
    }
    throw "端口 $port 已被新进程 $remaining 占用；已停止旧实例，未处理新进程。"
  }
  $null = $notes.Add("已结束 Vite 进程树 $listener")

  if ($state -and $state.pid -and (Test-ProcessAlive -ProcessId ([int]$state.pid))) {
    $detail = Get-ProcessDetail -ProcessId ([int]$state.pid)
    if ($detail -and $detail.CommandLine -and
      $detail.CommandLine -match 'npm' -and $detail.CommandLine -match "--port\s+$port") {
      Stop-ProcessTree -ProcessId ([int]$state.pid)
      $null = $notes.Add("已清理启动器 $($state.pid)")
    }
  }
  Remove-SkillState -RepoRoot $repoRoot -Service 'prototype'

  return [pscustomobject]@{
    Service = 'prototype-workbench'
    State   = 'stopped'
    Url     = "http://localhost:$port"
    Port    = $port
    Pid     = $null
    Detail  = ($notes -join '；')
  }
}

Write-Host "仓库根：$repoRoot" -ForegroundColor DarkGray

if ($Target -eq 'all' -or $Target -eq 'superpm') {
  try {
    $null = $results.Add((Stop-SuperpmService))
  } catch {
    $null = $failures.Add("superPM：$($_.Exception.Message)")
    Write-Host "superPM 停止失败：$($_.Exception.Message)" -ForegroundColor Red
  }
}

if ($Target -eq 'all' -or $Target -eq 'prototype') {
  try {
    $null = $results.Add((Stop-PrototypeService))
  } catch {
    $null = $failures.Add("prototype-workbench：$($_.Exception.Message)")
    Write-Host "prototype-workbench 停止失败：$($_.Exception.Message)" -ForegroundColor Red
  }
}

Write-Host ''
if ($results.Count -gt 0) {
  $results | Format-Table Service, State, Url, Port, Pid, Detail -AutoSize | Out-String | Write-Host
}
if ($failures.Count -gt 0) {
  Write-Host '停止未全部完成：' -ForegroundColor Red
  foreach ($failure in $failures) { Write-Host " - $failure" -ForegroundColor Red }
  exit 1
}
Write-Host '停止完成。' -ForegroundColor Green
exit 0
