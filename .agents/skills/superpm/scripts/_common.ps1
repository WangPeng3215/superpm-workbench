#Requires -Version 5.1
# 供 start-services.ps1 / check-services.ps1 / stop-services.ps1 共用。
# 只做路径、端口、状态、HTTP 与进程身份辅助，不包含启动或停止决策。

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Assert-SuperpmRepo {
  param([string]$ScriptRoot)
  $root = [System.IO.Path]::GetFullPath((Join-Path $ScriptRoot '..\..\..\..'))
  $manifestPath = Join-Path $root 'package.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "找不到仓库根 package.json：$manifestPath"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.name -ne 'superpm-workbench') {
    throw "当前目录不是 superPM 仓库根：$root"
  }
  return $root
}

function Get-DotEnvValue {
  param([string]$Path, [string]$Key)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  foreach ($line in Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) { continue }
    if ($trimmed -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      if ($Matches[1] -eq $Key) {
        $value = $Matches[2].Trim()
        if ($value.Length -ge 2) {
          $first = $value.Substring(0, 1)
          $last = $value.Substring($value.Length - 1, 1)
          if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
            $value = $value.Substring(1, $value.Length - 2)
          }
        }
        return $value
      }
    }
  }
  return $null
}

function Get-PrototypeSetting {
  param([string]$RepoRoot, [string]$Key)
  $value = [Environment]::GetEnvironmentVariable($Key, 'Process')
  if ([string]::IsNullOrWhiteSpace($value)) {
    $value = Get-DotEnvValue -Path (Join-Path $RepoRoot '.env') -Key $Key
  }
  if ([string]::IsNullOrWhiteSpace($value)) { return $null }
  return $value.Trim()
}

function Test-PrototypeBooleanSetting {
  param([string]$RepoRoot, [string]$Key, [bool]$Default)
  $value = Get-PrototypeSetting -RepoRoot $RepoRoot -Key $Key
  if ($null -eq $value) { return $Default }
  if ($value -match '^(0|false|no|off)$') { return $false }
  if ($value -match '^(1|true|yes|on)$') { return $true }
  return $Default
}

function Get-PrototypeRepository {
  param([string]$RepoRoot)
  $value = Get-PrototypeSetting -RepoRoot $RepoRoot -Key 'SUPERPM_PROTOTYPE_REPOSITORY'
  if ([string]::IsNullOrWhiteSpace($value)) {
    return 'https://github.com/WangPeng3215/prototype-workbench-template.git'
  }
  return $value
}

function Get-PrototypeRepositoryDisplay {
  param([string]$Repository)
  if ([string]::IsNullOrWhiteSpace($Repository)) { return $Repository }
  try {
    $uri = [System.Uri]$Repository
    if (-not [string]::IsNullOrEmpty($uri.UserInfo)) {
      $builder = New-Object System.UriBuilder($uri)
      $builder.UserName = ''
      $builder.Password = ''
      return $builder.Uri.AbsoluteUri
    }
  } catch { }
  return $Repository
}

function Get-PrototypeAutoClone {
  param([string]$RepoRoot)
  return (Test-PrototypeBooleanSetting -RepoRoot $RepoRoot -Key 'SUPERPM_PROTOTYPE_AUTO_CLONE' -Default $true)
}

function Get-PrototypeAutoInstall {
  param([string]$RepoRoot)
  return (Test-PrototypeBooleanSetting -RepoRoot $RepoRoot -Key 'SUPERPM_PROTOTYPE_AUTO_INSTALL' -Default $true)
}

function Get-PrototypePath {
  param([string]$RepoRoot, [string]$Requested)
  $raw = $Requested
  if ([string]::IsNullOrWhiteSpace($raw)) {
    $raw = Get-PrototypeSetting -RepoRoot $RepoRoot -Key 'SUPERPM_PROTOTYPE_DIR'
  }
  if ([string]::IsNullOrWhiteSpace($raw)) {
    $raw = Join-Path (Join-Path $RepoRoot 'workspace') 'prototype-workbench'
  }
  if (-not [System.IO.Path]::IsPathRooted($raw)) {
    $raw = Join-Path $RepoRoot $raw
  }

  $full = [System.IO.Path]::GetFullPath($raw)
  $target = $full.TrimEnd([char[]]@('\', '/'))
  $root = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd([char[]]@('\', '/'))
  $pathRoot = [System.IO.Path]::GetPathRoot($full).TrimEnd([char[]]@('\', '/'))

  if ([string]::IsNullOrWhiteSpace($target) -or $target -eq $pathRoot) {
    throw "原型项目路径不能是磁盘根目录：$raw"
  }
  if ($target -eq $root) {
    throw '原型项目路径不能指向 superPM 仓库根目录。'
  }

  $separator = [System.IO.Path]::DirectorySeparatorChar
  $targetPrefix = $target + $separator
  $rootPrefix = $root + $separator
  if ($rootPrefix.StartsWith($targetPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "原型项目路径不能是 superPM 仓库的上级目录：$target"
  }
  if ($targetPrefix.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    $workspace = [System.IO.Path]::GetFullPath((Join-Path $root 'workspace')).TrimEnd([char[]]@('\', '/'))
    $workspacePrefix = $workspace + $separator
    if ($target -eq $workspace -or -not $targetPrefix.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "仓库内的原型项目只能放在 workspace/ 下：$target"
    }
  }
  return $target
}

function Test-DirectoryEmpty {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
  $items = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop)
  return ($items.Count -eq 0)
}

function Get-PrototypeDependencyHint {
  param([object]$Status)
  $manager = 'npm'
  $lockFile = $null
  if ($Status) {
    if ($Status.PSObject.Properties['PackageManager'] -and $Status.PackageManager) {
      $manager = [string]$Status.PackageManager
    }
    if ($Status.PSObject.Properties['LockFile']) {
      $lockFile = $Status.LockFile
    }
  }
  if ($manager -eq 'pnpm') {
    if ($lockFile) { return 'pnpm install --frozen-lockfile' }
    return 'pnpm install'
  }
  if ($manager -eq 'yarn') {
    if ($lockFile) { return 'yarn install --frozen-lockfile' }
    return 'yarn install'
  }
  if ($lockFile) { return 'npm ci' }
  return 'npm install'
}

function Get-PrototypeProjectStatus {
  param([string]$PrototypePath)

  $missing = New-Object System.Collections.ArrayList
  $notes = New-Object System.Collections.ArrayList
  $result = [pscustomobject]@{
    State           = 'Missing'
    Path            = $PrototypePath
    Exists          = $false
    PackageName     = $null
    TemplateVersion = $null
    HasNodeModules  = $false
    PackageManager  = 'npm'
    LockFile        = $null
    Missing         = @()
    Notes           = @()
  }

  if (-not (Test-Path -LiteralPath $PrototypePath)) {
    $null = $notes.Add('目录不存在')
    $result.Notes = @($notes)
    return $result
  }

  $result.Exists = $true
  if (-not (Test-Path -LiteralPath $PrototypePath -PathType Container)) {
    $result.State = 'Conflict'
    $null = $notes.Add('目标路径不是目录')
    $result.Notes = @($notes)
    return $result
  }

  if (Test-DirectoryEmpty -Path $PrototypePath) {
    $result.State = 'Empty'
    $null = $notes.Add('目录为空')
    $result.Notes = @($notes)
    return $result
  }

  $manifestPath = Join-Path $PrototypePath 'package.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    $result.State = 'Conflict'
    $null = $notes.Add('目录非空但缺少 package.json，无法确认是 prototype-workbench')
    $result.Notes = @($notes)
    return $result
  }

  $manifest = $null
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  } catch {
    $result.State = 'Incomplete'
    $null = $notes.Add('package.json 无法解析')
    $result.Notes = @($notes)
    return $result
  }

  if ($manifest.PSObject.Properties['name']) {
    $result.PackageName = [string]$manifest.name
  }

  $required = @(
    'index.html',
    'vite.config.ts',
    'tsconfig.json',
    'src\main.ts',
    'src\App.vue',
    'src\prototypes\registry.ts',
    '.agents\skills\prototype-management\SKILL.md'
  )
  foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $PrototypePath $relative))) {
      $null = $missing.Add($relative)
    }
  }

  $hasMarkers = (Test-Path -LiteralPath (Join-Path $PrototypePath 'src\prototypes\registry.ts')) -and
    (Test-Path -LiteralPath (Join-Path $PrototypePath '.agents\skills\prototype-management\SKILL.md'))
  if ($result.PackageName -ne 'prototype-workbench' -and -not $hasMarkers) {
    $result.State = 'Conflict'
    $nameHint = 'package.json 缺少 name'
    if ($result.PackageName) { $nameHint = "package.json 名称是「$($result.PackageName)」" }
    $null = $notes.Add("$nameHint，且缺少 prototype-workbench 标识文件")
    $result.Notes = @($notes)
    return $result
  }

  $versionPath = Join-Path $PrototypePath 'TEMPLATE_VERSION'
  if (Test-Path -LiteralPath $versionPath) {
    $version = (Get-Content -LiteralPath $versionPath -Raw).Trim()
    if ($version -match '^\d+\.\d+\.\d+$') {
      $result.TemplateVersion = $version
    } else {
      $null = $notes.Add("TEMPLATE_VERSION 格式无效：$version")
    }
  } else {
    $null = $notes.Add('缺少 TEMPLATE_VERSION（可能是旧版本地项目）')
  }

  $localConfigPath = Join-Path $PrototypePath 'prototype.config.json'
  if (Test-Path -LiteralPath $localConfigPath) {
    try {
      $localConfig = Get-Content -LiteralPath $localConfigPath -Raw | ConvertFrom-Json
      if ($localConfig.PSObject.Properties['template'] -and
        $localConfig.template.PSObject.Properties['version']) {
        $localVersion = [string]$localConfig.template.version
        if ($result.TemplateVersion -and $localVersion -ne $result.TemplateVersion) {
          $null = $notes.Add("本地配置模板版本 $localVersion 与 TEMPLATE_VERSION $($result.TemplateVersion) 不一致")
        }
      }
    } catch {
      $null = $notes.Add('prototype.config.json 无法解析')
    }
  }

  if (Test-Path -LiteralPath (Join-Path $PrototypePath 'pnpm-lock.yaml')) {
    $result.PackageManager = 'pnpm'
    $result.LockFile = 'pnpm-lock.yaml'
  } elseif (Test-Path -LiteralPath (Join-Path $PrototypePath 'yarn.lock')) {
    $result.PackageManager = 'yarn'
    $result.LockFile = 'yarn.lock'
  } elseif (Test-Path -LiteralPath (Join-Path $PrototypePath 'package-lock.json')) {
    $result.PackageManager = 'npm'
    $result.LockFile = 'package-lock.json'
  } elseif ($manifest.PSObject.Properties['packageManager']) {
    $packageManager = [string]$manifest.packageManager
    $name = ($packageManager -split '@')[0]
    if ($name -in @('npm', 'pnpm', 'yarn')) { $result.PackageManager = $name }
  }

  $result.HasNodeModules = (Test-Path -LiteralPath (Join-Path $PrototypePath 'node_modules') -PathType Container)
  if (-not $result.HasNodeModules) { $null = $notes.Add('缺少 node_modules') }

  $result.Missing = @($missing)
  $result.Notes = @($notes)
  if ($missing.Count -gt 0) {
    $result.State = 'Incomplete'
  } else {
    $result.State = 'Valid'
  }
  return $result
}

function Get-SuperpmDataRoot {
  param([string]$RepoRoot)
  $homePath = $env:SUPERPM_HOME
  if ([string]::IsNullOrWhiteSpace($homePath)) {
    $homePath = Get-DotEnvValue -Path (Join-Path $RepoRoot '.env') -Key 'SUPERPM_HOME'
  }
  if ([string]::IsNullOrWhiteSpace($homePath)) { return $RepoRoot }
  if (-not [System.IO.Path]::IsPathRooted($homePath)) { $homePath = Join-Path $RepoRoot $homePath }
  return [System.IO.Path]::GetFullPath($homePath)
}

function Get-SuperpmApiPort {
  param([string]$RepoRoot)
  $value = $env:PORT
  if ([string]::IsNullOrWhiteSpace($value)) {
    $value = Get-DotEnvValue -Path (Join-Path $RepoRoot '.env') -Key 'PORT'
  }
  if ($value -match '^\d+$') {
    $port = [int]$value
    if ($port -ge 1 -and $port -le 65535) { return $port }
  }
  return 3001
}

function Get-SuperpmWebPort {
  param([string]$RepoRoot)
  $configPath = Join-Path (Join-Path (Join-Path $RepoRoot 'apps') 'web') 'vite.config.ts'
  if (Test-Path -LiteralPath $configPath) {
    $content = Get-Content -LiteralPath $configPath -Raw
    $match = [regex]::Match($content, 'port\s*:\s*(\d+)')
    if ($match.Success) { return [int]$match.Groups[1].Value }
  }
  return 5173
}

function Get-SuperpmProxyPort {
  param([string]$RepoRoot)
  $configPath = Join-Path (Join-Path (Join-Path $RepoRoot 'apps') 'web') 'vite.config.ts'
  if (-not (Test-Path -LiteralPath $configPath)) { return $null }
  $content = Get-Content -LiteralPath $configPath -Raw
  $match = [regex]::Match($content, '"/api"\s*:\s*"http://127\.0\.0\.1:(\d+)"')
  if ($match.Success) { return [int]$match.Groups[1].Value }
  return $null
}

function Get-SkillDir {
  param([string]$RepoRoot)
  return (Join-Path (Join-Path $RepoRoot 'runtime') 'skill')
}

function Ensure-SkillDir {
  param([string]$RepoRoot)
  $dir = Get-SkillDir $RepoRoot
  $null = New-Item -ItemType Directory -Path $dir -Force
  return $dir
}

function Get-SkillLogDir {
  param([string]$RepoRoot)
  $dir = Join-Path (Get-SkillDir $RepoRoot) 'logs'
  $null = New-Item -ItemType Directory -Path $dir -Force
  return $dir
}

function Get-SkillStatePath {
  param([string]$RepoRoot, [string]$Service)
  return (Join-Path (Get-SkillDir $RepoRoot) "$Service.json")
}

function Read-SkillState {
  param([string]$RepoRoot, [string]$Service)
  $path = Get-SkillStatePath $RepoRoot $Service
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try { return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-SkillState {
  param([string]$RepoRoot, [string]$Service, [object]$State)
  $dir = Ensure-SkillDir $RepoRoot
  $path = Join-Path $dir "$Service.json"
  $json = $State | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Remove-SkillState {
  param([string]$RepoRoot, [string]$Service)
  $path = Get-SkillStatePath $RepoRoot $Service
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}

function Resolve-PrototypePort {
  param([string]$RepoRoot, [int]$Requested)
  if ($Requested -gt 0) { return $Requested }
  $state = Read-SkillState -RepoRoot $RepoRoot -Service 'prototype'
  if ($state -and $state.PSObject.Properties['port']) {
    $value = [string]$state.port
    if ($value -match '^\d+$') { return [int]$value }
  }
  return 5199
}

function Invoke-WebProbe {
  param([string]$Url, [int]$TimeoutSec = 3)
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -Method Get
    return [pscustomobject]@{
      Ok         = $true
      StatusCode = [int]$response.StatusCode
      Content    = [string]$response.Content
    }
  } catch {
    $status = 0
    try {
      if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
        $status = [int]$_.Exception.Response.StatusCode
      }
    } catch { }
    return [pscustomobject]@{ Ok = $false; StatusCode = $status; Content = '' }
  }
}

function Get-SuperpmHealth {
  param([int]$Port, [int]$TimeoutSec = 3)
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec $TimeoutSec -Method Get
  } catch {
    return $null
  }
}

function Get-ListenerPid {
  param([int]$Port)
  try {
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1
    if ($connection) { return [int]$connection.OwningProcess }
  } catch { }
  try {
    $lines = & netstat.exe -ano 2>$null
    foreach ($line in $lines) {
      if ($line -match "LISTENING\s+(\d+)\s*$" -and $line -match ":$Port\s") {
        return [int]$Matches[1]
      }
    }
  } catch { }
  return $null
}

function Get-ProcessDetail {
  param([int]$ProcessId)
  try {
    return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop |
      Select-Object ProcessId, ParentProcessId, Name, CommandLine
  } catch {
    return $null
  }
}

function Test-ProcessAlive {
  param([int]$ProcessId)
  try {
    $null = Get-Process -Id $ProcessId -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Test-SuperpmWebProcess {
  param([int]$ProcessId, [string]$RepoRoot)
  $detail = Get-ProcessDetail $ProcessId
  if (-not $detail -or [string]::IsNullOrWhiteSpace($detail.CommandLine)) { return $false }
  $command = $detail.CommandLine.Replace('/', '\')
  $root = $RepoRoot.Replace('/', '\')
  return ($command.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -and ($command -match 'vite')
}

function Test-SuperpmServerProcess {
  param([int]$ProcessId, [string]$RepoRoot)
  $detail = Get-ProcessDetail $ProcessId
  if (-not $detail -or [string]::IsNullOrWhiteSpace($detail.CommandLine)) { return $false }
  $command = $detail.CommandLine.Replace('/', '\')
  $root = $RepoRoot.Replace('/', '\')
  return ($command.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -and
    ($command -match 'src[\\/]index\.ts|dist[\\/]index\.js')
}

function Test-SuperpmLauncherProcess {
  param([int]$ProcessId, [string]$RepoRoot)
  $detail = Get-ProcessDetail $ProcessId
  if (-not $detail -or [string]::IsNullOrWhiteSpace($detail.CommandLine)) { return $false }
  $command = $detail.CommandLine.Replace('/', '\')
  $root = $RepoRoot.Replace('/', '\')
  return ($command.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -and ($command -match 'start\.ps1')
}

function Test-PrototypeProcess {
  param([int]$ProcessId, [string]$PrototypePath)
  $detail = Get-ProcessDetail $ProcessId
  if (-not $detail -or [string]::IsNullOrWhiteSpace($detail.CommandLine)) { return $false }
  $command = $detail.CommandLine.Replace('/', '\')
  $path = $PrototypePath.Replace('/', '\')
  return ($command.IndexOf($path, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -and ($command -match 'vite')
}

function Test-PrototypePage {
  param([int]$Port, [int]$TimeoutSec = 3)
  foreach ($hostName in @('localhost', '127.0.0.1')) {
    $url = "http://${hostName}:$Port/"
    $probe = Invoke-WebProbe -Url $url -TimeoutSec $TimeoutSec
    if ($probe.Ok -and $probe.Content -match 'Prototype Workbench' -and $probe.Content -match 'id="app"') {
      return [pscustomobject]@{ Ok = $true; Url = $url; Probe = $probe }
    }
  }
  return [pscustomobject]@{ Ok = $false; Url = $null; Probe = $null }
}

function Wait-ForCondition {
  param([scriptblock]$Condition, [int]$TimeoutSeconds, [int]$IntervalMilliseconds = 500)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $result = & $Condition
    if ($result) { return $result }
    Start-Sleep -Milliseconds $IntervalMilliseconds
  }
  return $null
}

function Stop-ProcessTree {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return }
  try { & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null } catch { }
}

function Get-SuperpmRuntimePath {
  param([string]$RepoRoot)
  $dataRoot = Get-SuperpmDataRoot $RepoRoot
  return (Join-Path (Join-Path $dataRoot 'runtime') 'server.json')
}

function Read-SuperpmRuntime {
  param([string]$RepoRoot)
  $path = Get-SuperpmRuntimePath $RepoRoot
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try { return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } catch { return $null }
}
