#Requires -Version 5.1
<#
  只读检查 superPM 与 prototype-workbench 的运行状态。

  用法：
    .\check-services.ps1
    .\check-services.ps1 -Target superpm
    .\check-services.ps1 -Target prototype -PrototypePort 5199
    .\check-services.ps1 -Target all -Json

  退出码：全部目标健康为 0，否则为 1。
#>
[CmdletBinding()]
param(
  [ValidateSet('all', 'superpm', 'prototype')]
  [string]$Target = 'all',
  [int]$PrototypePort = 0,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

$repoRoot = Assert-SuperpmRepo -ScriptRoot $PSScriptRoot
$rows = New-Object System.Collections.ArrayList

function Get-SuperpmCheck {
  $apiPort = Get-SuperpmApiPort -RepoRoot $repoRoot
  $webPort = Get-SuperpmWebPort -RepoRoot $repoRoot
  $proxyPort = Get-SuperpmProxyPort -RepoRoot $repoRoot
  $health = Get-SuperpmHealth -Port $apiPort
  $web = Invoke-WebProbe -Url "http://127.0.0.1:$webPort/"
  $webPid = Get-ListenerPid -Port $webPort
  $webOwned = ($webPid -and (Test-SuperpmWebProcess -ProcessId $webPid -RepoRoot $repoRoot))
  $runtime = Read-SuperpmRuntime -RepoRoot $repoRoot
  $runtimeMatches = ($health -and $runtime -and [string]$runtime.pid -eq [string]$health.pid)

  $state = 'stopped'
  if ($health -and $health.status -eq 'ok' -and $web.Ok -and $webOwned) {
    $state = 'running'
  } elseif ($health -or $web.Ok) {
    $state = 'partial'
  }

  $notes = New-Object System.Collections.ArrayList
  if ($health) {
    $null = $notes.Add("API $apiPort · v$($health.version) · schema $($health.schemaVersion)")
  } else {
    $null = $notes.Add("API $apiPort 无响应")
  }
  if (-not $web.Ok) {
    $null = $notes.Add("Web $webPort 无响应")
  } elseif (-not $webOwned) {
    $null = $notes.Add("Web $webPort 进程身份不匹配")
  }
  if ($proxyPort -and $proxyPort -ne $apiPort) {
    $null = $notes.Add("代理端口 $proxyPort 与 API $apiPort 不一致")
  }
  if ($health -and -not $runtime) {
    $null = $notes.Add('缺少 runtime/server.json，停止可能需 -Force')
  } elseif ($health -and -not $runtimeMatches) {
    $null = $notes.Add('runtime/server.json 与健康 PID 不一致')
  }

  return [pscustomobject]@{
    service      = 'superPM'
    state        = $state
    url          = "http://127.0.0.1:$webPort"
    port         = $webPort
    pid          = if ($health) { $health.pid } else { $webPid }
    apiPort      = $apiPort
    apiStatus    = if ($health) { $health.status } else { 'down' }
    version      = if ($health) { $health.version } else { $null }
    schema       = if ($health) { $health.schemaVersion } else { $null }
    web          = $web.Ok
    webOwned     = [bool]$webOwned
    runtimeReady = [bool]$runtimeMatches
    detail       = ($notes -join '；')
  }
}

function Get-PrototypeCheck {
  $port = Resolve-PrototypePort -RepoRoot $repoRoot -Requested $PrototypePort
  $prototypePath = $null
  $project = $null
  $pathError = $null
  try {
    $prototypePath = Get-PrototypePath -RepoRoot $repoRoot
    $project = Get-PrototypeProjectStatus -PrototypePath $prototypePath
  } catch {
    $pathError = $_.Exception.Message
  }

  $page = Test-PrototypePage -Port $port
  $listener = Get-ListenerPid -Port $port
  $owned = $false
  if ($prototypePath -and $listener) {
    $owned = [bool](Test-PrototypeProcess -ProcessId $listener -PrototypePath $prototypePath)
  }
  $stateFile = Read-SkillState -RepoRoot $repoRoot -Service 'prototype'

  $state = 'stopped'
  if ($pathError) {
    $state = 'invalid'
  } elseif ($project -and ($project.State -eq 'Incomplete' -or $project.State -eq 'Conflict')) {
    $state = 'invalid'
  } elseif ($project -and ($project.State -eq 'Missing' -or $project.State -eq 'Empty')) {
    $state = 'missing'
  }
  if ($page.Ok -and $owned) {
    $state = 'running'
  } elseif (($page.Ok -or $listener) -and $state -eq 'stopped') {
    $state = 'partial'
  }

  $notes = New-Object System.Collections.ArrayList
  if ($pathError) {
    $null = $notes.Add("原型路径配置无效：$pathError")
  } elseif ($project) {
    switch ($project.State) {
      'Missing' {
        $null = $notes.Add("原型项目未初始化（$prototypePath）")
        if (Get-PrototypeAutoClone -RepoRoot $repoRoot) {
          $null = $notes.Add('启动时将从公共模板初始化')
        } else {
          $null = $notes.Add('自动初始化已关闭')
        }
      }
      'Empty' {
        $null = $notes.Add("原型项目目录为空（$prototypePath）")
        if (Get-PrototypeAutoClone -RepoRoot $repoRoot) {
          $null = $notes.Add('启动时将从公共模板初始化')
        } else {
          $null = $notes.Add('自动初始化已关闭')
        }
      }
      'Incomplete' {
        $detail = @($project.Missing) + @($project.Notes) | Where-Object { $_ }
        $null = $notes.Add("原型项目不完整：$($detail -join '；')；未自动修复")
      }
      'Conflict' {
        $null = $notes.Add("路径冲突：$($project.Notes -join '；')；未覆盖")
      }
      'Valid' {
        $versionText = '模板版本未记录'
        if ($project.TemplateVersion) { $versionText = "模板 $($project.TemplateVersion)" }
        $null = $notes.Add("$versionText · $prototypePath")
        if (-not $project.HasNodeModules) {
          $null = $notes.Add("缺少 node_modules，请执行 $(Get-PrototypeDependencyHint -Status $project)")
        }
        foreach ($note in @($project.Notes)) {
          if ($note -and $note -ne '缺少 node_modules' -and $note -ne '缺少 TEMPLATE_VERSION（可能是旧版本地项目）') {
            $null = $notes.Add($note)
          }
        }
      }
    }
  }

  if ($page.Ok) {
    $null = $notes.Add("页面可访问（$($page.Url)）")
  } else {
    $null = $notes.Add("http://localhost:$port 无响应")
  }
  if (-not $listener) {
    $null = $notes.Add('无监听进程')
  } elseif (-not $owned) {
    $null = $notes.Add("监听进程 $listener 不属于原型项目")
  }
  if ($stateFile) {
    $null = $notes.Add("Skill 记录状态 $($stateFile.status)")
  }

  $projectState = $null
  $templateVersion = $null
  if ($project) {
    $projectState = $project.State.ToLowerInvariant()
    $templateVersion = $project.TemplateVersion
  }

  return [pscustomobject]@{
    service  = 'prototype-workbench'
    state    = $state
    url      = if ($page.Ok) { $page.Url } else { "http://localhost:$port" }
    port     = $port
    pid      = $listener
    apiPort  = $null
    apiStatus = $null
    version  = $null
    schema   = $null
    web      = $page.Ok
    webOwned = [bool]$owned
    runtimeReady = $null
    project  = $projectState
    projectPath = $prototypePath
    templateVersion = $templateVersion
    detail   = ($notes -join '；')
  }
}

if ($Target -eq 'all' -or $Target -eq 'superpm') {
  $null = $rows.Add((Get-SuperpmCheck))
}
if ($Target -eq 'all' -or $Target -eq 'prototype') {
  $null = $rows.Add((Get-PrototypeCheck))
}

if ($Json) {
  ConvertTo-Json -InputObject @($rows) -Depth 6
} else {
  $rows | Format-Table service, state, url, port, pid, detail -AutoSize | Out-String | Write-Host
  $rows | ForEach-Object {
    $color = if ($_.state -eq 'running') { 'Green' } else { 'Yellow' }
    Write-Host "$($_.service)：$($_.state)" -ForegroundColor $color
  }
}

$unhealthy = @($rows | Where-Object { $_.state -ne 'running' })
if ($unhealthy.Count -gt 0) { exit 1 }
exit 0
