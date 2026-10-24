# superPM Workbench 停止脚本（Windows PowerShell 5.1+）
# 用法：Stop.cmd [-Home <数据根>] [-Force]
[CmdletBinding()]
param(
  [Alias('Home')]
  [string]$DataRoot,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {
  # 无控制台句柄时保持默认编码
}

function Stop-Fail([string]$message) {
  Write-Host "[superpm] $message"
  exit 1
}

function Test-Alive([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  try {
    Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Read-JsonFile([string]$path) {
  return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Resolve-AbsolutePath([string]$path, [string]$label) {
  $trimmed = $path.Trim()
  if (-not [IO.Path]::IsPathRooted($trimmed)) {
    Stop-Fail "$label 必须是绝对路径：$trimmed"
  }
  try {
    return [IO.Path]::GetFullPath($trimmed)
  } catch {
    Stop-Fail "$label 路径无效：$trimmed"
  }
}

function Resolve-ConfigDir {
  if ($env:SUPERPM_CONFIG_DIR -and $env:SUPERPM_CONFIG_DIR.Trim()) {
    return Resolve-AbsolutePath $env:SUPERPM_CONFIG_DIR '环境变量 SUPERPM_CONFIG_DIR'
  }
  $appData = $env:APPDATA
  if (-not $appData) {
    $appData = [Environment]::GetFolderPath('ApplicationData')
  }
  return Join-Path $appData 'superPM'
}

function Resolve-DataRoot {
  $configDir = Resolve-ConfigDir
  if ($DataRoot -and $DataRoot.Trim()) {
    return @{
      Home = Resolve-AbsolutePath $DataRoot '参数 -Home'
      ConfigDir = $configDir
    }
  }
  if ($env:SUPERPM_HOME -and $env:SUPERPM_HOME.Trim()) {
    return @{
      Home = Resolve-AbsolutePath $env:SUPERPM_HOME '环境变量 SUPERPM_HOME'
      ConfigDir = $configDir
    }
  }
  $configPath = Join-Path $configDir 'config.json'
  if (Test-Path -LiteralPath $configPath) {
    try {
      $config = Read-JsonFile $configPath
    } catch {
      Stop-Fail "配置文件无法读取：$configPath（$($_.Exception.Message)）"
    }
    $configured = ([string]$config.home).Trim()
    if (-not $configured) {
      Stop-Fail "配置文件缺少 home 字段：$configPath。请修正文件内容，或将其改名以恢复默认数据根。"
    }
    return @{
      Home = Resolve-AbsolutePath $configured "配置文件 $configPath 中的 home"
      ConfigDir = $configDir
    }
  }
  $localAppData = $env:LOCALAPPDATA
  if (-not $localAppData) {
    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  }
  return @{
    Home = Join-Path $localAppData 'superPM'
    ConfigDir = $configDir
  }
}

function Test-UpdateLock([string]$homePath) {
  $path = Join-Path $homePath 'runtime\update.lock'
  if (-not (Test-Path -LiteralPath $path)) { return }
  $parsed = $false
  $lockPid = 0
  $active = $false
  try {
    $lock = Read-JsonFile $path
    $parsed = $true
    if ($lock.pid) {
      $lockPid = [int]$lock.pid
      $active = Test-Alive $lockPid
    }
  } catch {
    # 无法解析的锁按文件时间判断，避免更新中途被停止
  }
  if (-not $parsed -or $lockPid -eq 0) {
    try {
      $age = (Get-Date) - (Get-Item -LiteralPath $path).LastWriteTime
      $active = $age.TotalMinutes -lt 30
    } catch {
      $active = $false
    }
  }
  if ($active) {
    if ($lockPid -gt 0) {
      Stop-Fail "正在更新（PID $lockPid），请等待更新完成后再停止服务。"
    }
    Stop-Fail "正在更新，请等待更新完成后再停止服务。"
  }
  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
}

function Test-OperationLock([string]$configDir) {
  $path = Join-Path $configDir 'operation.lock'
  if (-not (Test-Path -LiteralPath $path)) { return }
  $active = $false
  $lockPid = 0
  $jobId = ''
  try {
    $lock = Read-JsonFile $path
    $lockPid = [int]$lock.pid
    $jobId = [string]$lock.jobId
    if (Test-Alive $lockPid) {
      $active = $true
      $heartbeat = [string]$lock.heartbeatAt
      if (-not $heartbeat) { $heartbeat = [string]$lock.startedAt }
      if ($heartbeat) {
        try {
          $age = [DateTimeOffset]::Now - [DateTimeOffset]::Parse($heartbeat)
          if ($age.TotalMinutes -gt 30) { $active = $false }
        } catch {
          # 心跳时间不可解析时按活跃处理，宁可拒绝停止
        }
      }
    }
  } catch {
    # 无法解析的锁视为陈旧锁
  }
  if ($active) {
    if ($jobId) {
      Stop-Fail "正在迁移数据目录（任务 $jobId，PID $lockPid），请等待迁移完成后再停止服务。"
    }
    Stop-Fail "正在迁移数据目录（PID $lockPid），请等待迁移完成后再停止服务。"
  }
  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
}

$resolution = Resolve-DataRoot
$homePath = $resolution.Home
$configDir = $resolution.ConfigDir

Test-UpdateLock $homePath
Test-OperationLock $configDir

$statePath = Join-Path $homePath 'runtime\server.json'
if (-not (Test-Path -LiteralPath $statePath)) {
  Write-Host "[superpm] 服务未运行：没有找到运行时状态（数据根 $homePath）。"
  exit 0
}

try {
  $state = Read-JsonFile $statePath
} catch {
  Stop-Fail "运行时状态文件无法解析：$statePath。请确认服务是否仍在运行；确认服务已退出后可删除该文件。"
}

$serverPid = 0
$port = 0
try {
  $serverPid = [int]$state.pid
  $port = [int]$state.port
} catch {
  $serverPid = 0
  $port = 0
}
$token = [string]$state.shutdownToken
if ($serverPid -le 0 -or $port -le 0 -or -not $token) {
  Stop-Fail "运行时状态文件不完整：$statePath。请确认服务是否仍在运行；确认服务已退出后可删除该文件。"
}

if (-not (Test-Alive $serverPid)) {
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  Write-Host "[superpm] 服务未运行（已清理残留状态 PID $serverPid，数据根 $homePath）。"
  exit 0
}

$baseUrl = "http://127.0.0.1:$port"
$health = $null
try {
  $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -Method Get -TimeoutSec 2 -ErrorAction Stop
} catch {
  $health = $null
}

$failure = $null
if ($health -and ([int]$health.pid -eq $serverPid)) {
  $requestError = $null
  try {
    $response = Invoke-WebRequest -Uri "$baseUrl/api/shutdown" -Method Post `
      -Headers @{ 'x-superpm-shutdown-token' = $token } `
      -ContentType 'application/json' -Body '{}' `
      -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    if ([int]$response.StatusCode -ne 202) {
      $requestError = "停止请求返回 HTTP $($response.StatusCode)。"
    }
  } catch {
    $requestError = "停止请求未正常完成：$($_.Exception.Message)"
  }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-Alive $serverPid) -and -not (Test-Path -LiteralPath $statePath)) { break }
    Start-Sleep -Milliseconds 200
  }
  if (-not (Test-Alive $serverPid) -and -not (Test-Path -LiteralPath $statePath)) {
    Write-Host "[superpm] 服务已停止（PID $serverPid，端口 $port，数据根 $homePath）。"
    Write-Host "[superpm] 已连接的 MCP 客户端进程不会被结束，如不再需要请自行关闭。"
    exit 0
  }
  if ($requestError) {
    $failure = "$requestError 服务未在 10 秒内退出（PID $serverPid）。"
  } else {
    $failure = "已发送停止请求，但服务未在 10 秒内退出（PID $serverPid）。"
  }
} else {
  $failure = "服务进程 PID $serverPid 仍在运行，但健康检查没有响应（端口 $port）。"
}

Write-Host "[superpm] $failure"
if (-not $Force) {
  Write-Host "[superpm] 如服务已无响应，可执行 Stop.cmd -Force 强制结束该服务进程树。"
  Write-Host "[superpm] 本脚本不会结束 MCP 客户端进程；执行前请先关闭已连接的 MCP 客户端。"
  exit 1
}

if (-not (Test-Alive $serverPid)) {
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  Write-Host "[superpm] 服务已停止（PID $serverPid，数据根 $homePath）。"
  exit 0
}

$looksLikeServer = $false
try {
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid" -ErrorAction Stop
  $commandLine = ''
  if ($processInfo) { $commandLine = [string]$processInfo.CommandLine }
  if ($commandLine -match 'apps[\\/]server[\\/]dist[\\/]index\.js') {
    $looksLikeServer = $true
  }
} catch {
  $looksLikeServer = $false
}

if (-not $looksLikeServer) {
  Write-Host "[superpm] 无法确认 PID $serverPid 是 superPM 服务进程，已跳过强制结束，避免误杀其他程序。"
  Write-Host "[superpm] 请手动检查该进程；确认服务已退出后，可删除状态文件 $statePath。"
  exit 1
}

Write-Host "[superpm] 正在强制结束服务进程树（PID $serverPid）…"
& taskkill.exe /PID $serverPid /T /F | Out-Null
$taskkillCode = $LASTEXITCODE
$deadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $deadline) {
  if (-not (Test-Alive $serverPid)) { break }
  Start-Sleep -Milliseconds 200
}
if (Test-Alive $serverPid) {
  Stop-Fail "强制结束失败（taskkill 退出码 $taskkillCode）。请尝试以管理员身份运行 Stop.cmd -Force。"
}

Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
Write-Host "[superpm] 服务已强制停止（PID $serverPid，数据根 $homePath）。"
exit 0
