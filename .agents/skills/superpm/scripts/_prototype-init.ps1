#Requires -Version 5.1
# 原型项目初始化的共享实现，由 prototype-init.ps1 与 start-services.ps1 复用。
# 只允许在目标缺失或为空时 Clone；不 Pull、不 reset、不 clean、不覆盖已有目录。

function New-PrototypeInitLogPath {
  param([string]$RepoRoot)
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  return (Join-Path (Get-SkillLogDir -RepoRoot $RepoRoot) "prototype-init-$stamp.log")
}

function Write-PrototypeInitLog {
  param([string]$Path, [string]$Text)
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  try {
    [System.IO.File]::AppendAllText($Path, $Text + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

function New-PrototypeInitResult {
  param(
    [bool]$Ok,
    [int]$ExitCode,
    [string]$Action,
    [string]$Message,
    [object]$Status = $null,
    [string]$Repository = '',
    [bool]$Installed = $false,
    [string]$LogPath = ''
  )
  $path = $null
  $projectState = $null
  $templateVersion = $null
  $packageManager = $null
  if ($Status) {
    $path = $Status.Path
    $projectState = $Status.State
    $templateVersion = $Status.TemplateVersion
    $packageManager = $Status.PackageManager
  }
  return [pscustomobject]@{
    Ok              = $Ok
    ExitCode        = $ExitCode
    Action          = $Action
    State           = $projectState
    Path            = $path
    TemplateVersion = $templateVersion
    PackageManager  = $packageManager
    Repository      = $Repository
    Installed       = $Installed
    Message         = $Message
    LogPath         = $LogPath
    Status          = $Status
  }
}

function Test-PrototypeRepositoryUrl {
  param([string]$Repository)
  if ([string]::IsNullOrWhiteSpace($Repository)) { return $false }
  if ($Repository.StartsWith('-')) { return $false }
  return ($Repository -match '^(https?://|ssh://|git@[A-Za-z0-9._-]+:|file://)')
}

function Test-PrototypeCloneResult {
  param([object]$Status)
  $problems = New-Object System.Collections.ArrayList

  if ($Status.State -ne 'Valid') {
    if ($Status.Missing -and $Status.Missing.Count -gt 0) {
      $null = $problems.Add("缺少文件：$($Status.Missing -join '、')")
    }
    foreach ($note in @($Status.Notes)) {
      if ($note -and $note -ne '缺少 node_modules') { $null = $problems.Add($note) }
    }
    if ($problems.Count -eq 0) { $null = $problems.Add("项目状态为 $($Status.State)") }
  }
  if ([string]::IsNullOrWhiteSpace([string]$Status.TemplateVersion)) {
    $null = $problems.Add('TEMPLATE_VERSION 缺失或格式无效')
  }

  return [pscustomobject]@{
    Ok       = ($problems.Count -eq 0)
    Problems = @($problems)
  }
}

function Write-PrototypeLocalConfig {
  param(
    [string]$PrototypePath,
    [string]$Repository,
    [string]$TemplateVersion
  )
  $config = [ordered]@{
    template = [ordered]@{
      repository    = $Repository
      version       = $TemplateVersion
      initializedAt = ([DateTimeOffset]::Now).ToString('o')
    }
    autoPull = $false
  }
  $json = $config | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText(
    (Join-Path $PrototypePath 'prototype.config.json'),
    $json,
    (New-Object System.Text.UTF8Encoding($false))
  )
}

function Get-PrototypeInstallPlan {
  param([object]$Status)
  $manager = 'npm'
  $lockFile = $null
  if ($Status) {
    if ($Status.PackageManager) { $manager = [string]$Status.PackageManager }
    if ($Status.LockFile) { $lockFile = [string]$Status.LockFile }
  }

  $executableName = 'npm.cmd'
  if ($manager -eq 'pnpm') { $executableName = 'pnpm.cmd' }
  elseif ($manager -eq 'yarn') { $executableName = 'yarn.cmd' }
  $command = Get-Command $executableName -ErrorAction SilentlyContinue
  if (-not $command) {
    return [pscustomobject]@{
      Ok          = $false
      Manager     = $manager
      Command     = $null
      Arguments   = @()
      Description = "$manager install"
      Error       = "未找到 $executableName，请确认 $manager 已安装并在 PATH 中。"
    }
  }

  $arguments = @('install')
  if ($lockFile) {
    if ($manager -eq 'npm') {
      $arguments = @('ci')
    } else {
      $arguments = @('install', '--frozen-lockfile')
    }
  }
  return [pscustomobject]@{
    Ok          = $true
    Manager     = $manager
    Command     = $command
    Arguments   = $arguments
    Description = "$manager $($arguments -join ' ')"
    Error       = $null
  }
}

function Invoke-PrototypeDependencyInstall {
  param(
    [string]$PrototypePath,
    [object]$Status,
    [string]$LogPath
  )
  $plan = Get-PrototypeInstallPlan -Status $Status
  if (-not $plan.Ok) {
    return [pscustomobject]@{
      Ok          = $false
      Description = $plan.Description
      Output      = ''
      Error       = $plan.Error
    }
  }

  Write-PrototypeInitLog -Path $LogPath -Text "执行依赖安装：$($plan.Description)"
  $output = ''
  $exitCode = 1
  $previousErrorAction = $ErrorActionPreference
  $pushed = $false
  try {
    Push-Location -LiteralPath $PrototypePath
    $pushed = $true
    $ErrorActionPreference = 'Continue'
    $argumentList = @($plan.Arguments)
    $output = & $plan.Command.Source @argumentList 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
  } catch {
    $output = $_.Exception.Message
    $exitCode = 1
  } finally {
    $ErrorActionPreference = $previousErrorAction
    if ($pushed) { Pop-Location }
  }
  Write-PrototypeInitLog -Path $LogPath -Text $output

  if ($exitCode -ne 0) {
    return [pscustomobject]@{
      Ok          = $false
      Description = $plan.Description
      Output      = $output
      Error       = "依赖安装失败（$($plan.Description)，退出码 $exitCode）"
    }
  }
  return [pscustomobject]@{
    Ok          = $true
    Description = $plan.Description
    Output      = $output
    Error       = $null
  }
}

function Invoke-PrototypeInitialization {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [string]$PrototypePath = '',
    [string]$Repository = '',
    [bool]$InstallDependencies = $true,
    [switch]$Quiet
  )

  $logPath = New-PrototypeInitLogPath -RepoRoot $RepoRoot
  $target = $null
  try {
    $target = Get-PrototypePath -RepoRoot $RepoRoot -Requested $PrototypePath
  } catch {
    $message = "原型项目路径无效：$($_.Exception.Message)"
    Write-PrototypeInitLog -Path $logPath -Text $message
    return New-PrototypeInitResult -Ok $false -ExitCode 4 -Action 'blocked' -Message $message -LogPath $logPath
  }

  if ([string]::IsNullOrWhiteSpace($Repository)) {
    $Repository = Get-PrototypeRepository -RepoRoot $RepoRoot
  }
  $safeRepository = Get-PrototypeRepositoryDisplay -Repository $Repository
  Write-PrototypeInitLog -Path $logPath -Text "检查原型项目：$target"
  Write-PrototypeInitLog -Path $logPath -Text "模板仓库：$safeRepository"

  $status = Get-PrototypeProjectStatus -PrototypePath $target
  switch ($status.State) {
    'Valid' {
      $message = '本地原型项目已存在，使用本地版本；未执行 Pull、重置或覆盖。'
      if (-not $status.HasNodeModules) {
        $message += " 缺少 node_modules，请在该目录执行 $(Get-PrototypeDependencyHint -Status $status)。"
      }
      Write-PrototypeInitLog -Path $logPath -Text $message
      return New-PrototypeInitResult -Ok $true -ExitCode 0 -Action 'reused' -Message $message `
        -Status $status -Repository $safeRepository -LogPath $logPath
    }
    'Incomplete' {
      $detail = New-Object System.Collections.ArrayList
      if ($status.Missing -and $status.Missing.Count -gt 0) {
        $null = $detail.Add("缺少文件：$($status.Missing -join '、')")
      }
      if ($status.Notes -and $status.Notes.Count -gt 0) {
        $null = $detail.Add(($status.Notes -join '；'))
      }
      $message = "本地原型项目不完整，未覆盖、未重建。$($detail -join '；')"
      Write-PrototypeInitLog -Path $logPath -Text $message
      return New-PrototypeInitResult -Ok $false -ExitCode 6 -Action 'blocked' -Message $message `
        -Status $status -Repository $safeRepository -LogPath $logPath
    }
    'Conflict' {
      $message = "目标路径已被其他内容占用或项目身份不符，未执行 Clone。$($status.Notes -join '；') 请检查路径：$target"
      Write-PrototypeInitLog -Path $logPath -Text $message
      return New-PrototypeInitResult -Ok $false -ExitCode 4 -Action 'blocked' -Message $message `
        -Status $status -Repository $safeRepository -LogPath $logPath
    }
  }

  if (-not (Get-PrototypeAutoClone -RepoRoot $RepoRoot)) {
    $message = "原型项目尚未初始化（$target），且已禁用自动 Clone（SUPERPM_PROTOTYPE_AUTO_CLONE=0）。"
    Write-PrototypeInitLog -Path $logPath -Text $message
    return New-PrototypeInitResult -Ok $false -ExitCode 3 -Action 'blocked' -Message $message `
      -Status $status -Repository $safeRepository -LogPath $logPath
  }
  if (-not (Test-PrototypeRepositoryUrl -Repository $Repository)) {
    $message = "公共模板仓库地址无效：$safeRepository。请检查 SUPERPM_PROTOTYPE_REPOSITORY。"
    Write-PrototypeInitLog -Path $logPath -Text $message
    return New-PrototypeInitResult -Ok $false -ExitCode 3 -Action 'blocked' -Message $message `
      -Status $status -Repository $safeRepository -LogPath $logPath
  }

  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
  if (-not $git) {
    $message = '未找到 Git，无法 Clone 公共模板。请先安装 Git，并确认 git 命令在 PATH 中。'
    Write-PrototypeInitLog -Path $logPath -Text $message
    return New-PrototypeInitResult -Ok $false -ExitCode 2 -Action 'blocked' -Message $message `
      -Status $status -Repository $safeRepository -LogPath $logPath
  }

  try {
    if (Test-Path -LiteralPath $target) {
      if (-not (Test-DirectoryEmpty -Path $target)) {
        $message = "Clone 目标目录非空，已停止：$target。请人工检查该目录或修改 SUPERPM_PROTOTYPE_DIR。"
        Write-PrototypeInitLog -Path $logPath -Text $message
        return New-PrototypeInitResult -Ok $false -ExitCode 4 -Action 'blocked' -Message $message `
          -Status $status -Repository $safeRepository -LogPath $logPath
      }
    }
  } catch {
    $message = "无法检查 Clone 目标目录：$($_.Exception.Message)"
    Write-PrototypeInitLog -Path $logPath -Text $message
    return New-PrototypeInitResult -Ok $false -ExitCode 4 -Action 'blocked' -Message $message `
      -Status $status -Repository $safeRepository -LogPath $logPath
  }

  $parent = Split-Path -Parent $target
  if (-not (Test-Path -LiteralPath $parent)) {
    try {
      $null = New-Item -ItemType Directory -Path $parent -Force
    } catch {
      $message = "无法创建原型项目上级目录 $parent：$($_.Exception.Message)"
      Write-PrototypeInitLog -Path $logPath -Text $message
      return New-PrototypeInitResult -Ok $false -ExitCode 4 -Action 'blocked' -Message $message `
        -Status $status -Repository $safeRepository -LogPath $logPath
    }
  }

  if (-not $Quiet) {
    Write-Host '原型项目尚未初始化，正在从公共模板 Clone…' -ForegroundColor Cyan
    Write-Host "  仓库：$safeRepository" -ForegroundColor DarkGray
    Write-Host "  目标：$target" -ForegroundColor DarkGray
  }
  Write-PrototypeInitLog -Path $logPath -Text "开始 Clone：$safeRepository -> $target"

  $cloneArguments = @('clone', '--', $Repository, $target)
  $cloneOutput = ''
  $cloneExitCode = 1
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $cloneOutput = & $git.Source @cloneArguments 2>&1 | Out-String
    $cloneExitCode = $LASTEXITCODE
  } catch {
    $cloneOutput = $_.Exception.Message
    $cloneExitCode = 1
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  $safeCloneOutput = $cloneOutput
  if ($Repository -ne $safeRepository) {
    $safeCloneOutput = $safeCloneOutput.Replace($Repository, $safeRepository)
  }
  Write-PrototypeInitLog -Path $logPath -Text $safeCloneOutput

  if ($cloneExitCode -ne 0) {
    $tail = ($safeCloneOutput.Trim() -split "`r?`n" | Select-Object -Last 12) -join [Environment]::NewLine
    $message = "Clone 失败（退出码 $cloneExitCode）。已保留目标目录现状，未自动清理或重试。日志：$logPath`n$tail"
    return New-PrototypeInitResult -Ok $false -ExitCode 5 -Action 'clone-failed' -Message $message `
      -Status $status -Repository $safeRepository -LogPath $logPath
  }

  $status = Get-PrototypeProjectStatus -PrototypePath $target
  $validation = Test-PrototypeCloneResult -Status $status
  if (-not $validation.Ok) {
    $message = "Clone 完成但项目校验未通过，已保留目录，请人工检查：$($validation.Problems -join '；')"
    Write-PrototypeInitLog -Path $logPath -Text $message
    return New-PrototypeInitResult -Ok $false -ExitCode 6 -Action 'validation-failed' -Message $message `
      -Status $status -Repository $safeRepository -LogPath $logPath
  }

  try {
    Write-PrototypeLocalConfig -PrototypePath $target -Repository $safeRepository -TemplateVersion $status.TemplateVersion
  } catch {
    $message = "Clone 成功，但写入本地初始化信息失败：$($_.Exception.Message)。项目目录已保留。"
    Write-PrototypeInitLog -Path $logPath -Text $message
    return New-PrototypeInitResult -Ok $false -ExitCode 8 -Action 'config-failed' -Message $message `
      -Status $status -Repository $safeRepository -LogPath $logPath
  }

  $installed = $false
  if ($InstallDependencies) {
    if (-not $Quiet) {
      $hint = Get-PrototypeDependencyHint -Status $status
      Write-Host "安装依赖（$hint），可能需要几分钟…" -ForegroundColor Cyan
    }
    $install = Invoke-PrototypeDependencyInstall -PrototypePath $target -Status $status -LogPath $logPath
    if (-not $install.Ok) {
      $tail = ($install.Output.Trim() -split "`r?`n" | Select-Object -Last 12) -join [Environment]::NewLine
      $message = "$($install.Error)。项目已保留，修复后可重试启动。日志：$logPath`n$tail"
      return New-PrototypeInitResult -Ok $false -ExitCode 7 -Action 'install-failed' -Message $message `
        -Status $status -Repository $safeRepository -LogPath $logPath
    }
    $installed = $true
    $status = Get-PrototypeProjectStatus -PrototypePath $target
  }

  $message = "本地原型项目初始化完成，模板版本 $($status.TemplateVersion)。路径：$target"
  if (-not $InstallDependencies) {
    $message += " 依赖未安装，请执行 $(Get-PrototypeDependencyHint -Status $status)。"
  }
  Write-PrototypeInitLog -Path $logPath -Text $message
  return New-PrototypeInitResult -Ok $true -ExitCode 0 -Action 'cloned' -Message $message `
    -Status $status -Repository $safeRepository -Installed $installed -LogPath $logPath
}
