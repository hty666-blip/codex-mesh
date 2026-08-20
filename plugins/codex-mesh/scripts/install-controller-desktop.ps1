[CmdletBinding()]
param(
    [string]$CodexHome = $(
        if ($env:CODEX_HOME) { $env:CODEX_HOME }
        else { Join-Path $env:USERPROFILE '.codex' }
    ),
    [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'CodexMesh\controller')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ManagedBegin = '# BEGIN CODEX MESH CONTROLLER (managed by install-controller-desktop.ps1)'
$ManagedEnd = '# END CODEX MESH CONTROLLER'

function Get-Node20Path {
    $commands = @(Get-Command node -CommandType Application -ErrorAction SilentlyContinue)
    if ($commands.Count -eq 0) {
        throw 'Node.js 20 or newer is required. Install Node.js, reopen PowerShell, and run this script again.'
    }

    $nodePath = $commands[0].Source
    $versionText = (& $nodePath --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v?(\d+)\.') {
        throw "Could not determine the Node.js version from $nodePath."
    }
    if ([int]$Matches[1] -lt 20) {
        throw "Node.js 20 or newer is required; found $versionText."
    }
    return (Resolve-Path -LiteralPath $nodePath).Path
}

function ConvertTo-TomlBasicString([string]$Value) {
    $escaped = $Value.Replace('\', '\\').Replace('"', '\"')
    $escaped = $escaped.Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
    return '"' + $escaped + '"'
}

$nodeExecutable = Get-Node20Path
$resolvedSource = (Resolve-Path -LiteralPath $SourceRoot).Path
$resolvedCodexHome = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($CodexHome)
$resolvedDestination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Destination)
$sourceMcp = Join-Path $resolvedSource 'src\mcp'
$sourceMcpServer = Join-Path $sourceMcp 'server.mjs'
$sourceSkill = Join-Path $resolvedSource 'skills\codex-mesh'

if ($resolvedDestination -eq $resolvedSource) {
    throw 'Destination must differ from the source checkout.'
}
if (-not (Test-Path -LiteralPath $sourceMcpServer -PathType Leaf)) {
    throw "Could not find the Codex Mesh MCP server at $sourceMcpServer."
}
if (-not (Test-Path -LiteralPath (Join-Path $sourceSkill 'SKILL.md') -PathType Leaf)) {
    throw "Could not find the Codex Mesh skill below $sourceSkill."
}

New-Item -ItemType Directory -Force -Path $resolvedDestination | Out-Null
$runtimeSource = Join-Path $resolvedDestination 'src'
New-Item -ItemType Directory -Force -Path $runtimeSource | Out-Null
Copy-Item -LiteralPath $sourceMcp -Destination $runtimeSource -Recurse -Force
$mcpServer = Join-Path $resolvedDestination 'src\mcp\server.mjs'

New-Item -ItemType Directory -Force -Path $resolvedCodexHome | Out-Null
$configPath = Join-Path $resolvedCodexHome 'config.toml'
$currentConfig = if (Test-Path -LiteralPath $configPath) {
    [System.IO.File]::ReadAllText($configPath)
} else {
    ''
}

$managedPattern = '(?ms)^' + [regex]::Escape($ManagedBegin) + '\r?\n.*?^' + [regex]::Escape($ManagedEnd) + '\r?\n?'
$configWithoutManagedBlock = [regex]::Replace($currentConfig, $managedPattern, '')
if ($configWithoutManagedBlock -match '(?m)^\s*\[mcp_servers\.codex_mesh\]\s*(?:#.*)?$') {
    throw "The config already contains [mcp_servers.codex_mesh] outside the installer-managed block. Rename or remove that table before retrying; $configPath was not changed."
}

$nodeToml = ConvertTo-TomlBasicString $nodeExecutable
$serverToml = ConvertTo-TomlBasicString $mcpServer
$stdioToml = ConvertTo-TomlBasicString '--stdio'
$managedBlock = @(
    $ManagedBegin
    '[mcp_servers.codex_mesh]'
    "command = $nodeToml"
    "args = [$serverToml, $stdioToml]"
    $ManagedEnd
) -join [Environment]::NewLine

$baseConfig = $configWithoutManagedBlock.TrimEnd("`r", "`n")
$newConfig = if ($baseConfig.Length -eq 0) {
    $managedBlock + [Environment]::NewLine
} else {
    $baseConfig + [Environment]::NewLine + [Environment]::NewLine + $managedBlock + [Environment]::NewLine
}

$backupPath = $null
if ($newConfig -cne $currentConfig) {
    if (Test-Path -LiteralPath $configPath) {
        $timestamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
        $backupPath = "$configPath.codex-mesh-backup-$timestamp"
        Copy-Item -LiteralPath $configPath -Destination $backupPath
    }

    $temporaryConfig = "$configPath.codex-mesh-$([guid]::NewGuid().ToString('N')).tmp"
    try {
        $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($temporaryConfig, $newConfig, $utf8WithoutBom)
        Move-Item -LiteralPath $temporaryConfig -Destination $configPath -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryConfig) {
            Remove-Item -LiteralPath $temporaryConfig -Force
        }
    }
}

$skillDestination = Join-Path $resolvedCodexHome 'skills\codex-mesh'
New-Item -ItemType Directory -Force -Path $skillDestination | Out-Null
foreach ($item in Get-ChildItem -LiteralPath $sourceSkill -Force) {
    Copy-Item -LiteralPath $item.FullName -Destination $skillDestination -Recurse -Force
}

Write-Host 'Codex Mesh controller integration installed for Codex Desktop.'
Write-Host "Runtime:    $resolvedDestination"
Write-Host "MCP config: $configPath"
Write-Host "Skill:      $skillDestination"
Write-Host "Node.js:    $nodeExecutable"
if ($backupPath) {
    Write-Host "Backup:     $backupPath"
}
Write-Host ''
Write-Host 'Start Codex Desktop again and ask: 列出所有 Codex Mesh 节点。'
Write-Host 'The Hub must be running, and ~/.codex-mesh/controller.json must contain its URL and controller token.'
