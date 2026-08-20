$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$pluginRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$installer = Join-Path $pluginRoot 'scripts\install-controller-desktop.ps1'
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "Codex Mesh 控制器测试 $([guid]::NewGuid().ToString('N'))"

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

try {
    New-Item -ItemType Directory -Force -Path $temporaryRoot | Out-Null
    $configPath = Join-Path $temporaryRoot 'config.toml'
    $runtimePath = Join-Path $temporaryRoot 'runtime'
    [System.IO.File]::WriteAllText($configPath, "model = 'keep-me'`n")

    & $installer -CodexHome $temporaryRoot -SourceRoot $pluginRoot -Destination $runtimePath
    $firstConfig = [System.IO.File]::ReadAllText($configPath)
    & $installer -CodexHome $temporaryRoot -SourceRoot $pluginRoot -Destination $runtimePath
    $secondConfig = [System.IO.File]::ReadAllText($configPath)

    Assert-True ($firstConfig -ceq $secondConfig) 'The controller installer is not idempotent.'
    Assert-True ($secondConfig.Contains("model = 'keep-me'")) 'Existing Codex configuration was not preserved.'
    Assert-True (([regex]::Matches($secondConfig, '(?m)^\[mcp_servers\.codex_mesh\]\r?$')).Count -eq 1) 'Expected exactly one codex_mesh MCP table.'
    Assert-True ($secondConfig.Contains('server.mjs')) 'The MCP server path was not written.'
    Assert-True (Test-Path -LiteralPath (Join-Path $runtimePath 'src\mcp\server.mjs')) 'The MCP runtime was not copied to the stable destination.'
    Assert-True (Test-Path -LiteralPath (Join-Path $temporaryRoot 'skills\codex-mesh\SKILL.md')) 'The Codex Mesh skill was not installed.'

    $backups = @(Get-ChildItem -LiteralPath $temporaryRoot -Filter 'config.toml.codex-mesh-backup-*')
    Assert-True ($backups.Count -eq 1) 'Expected one backup and no extra backup on an idempotent reinstall.'
    Write-Host 'Controller desktop installer test passed.'
} finally {
    $expectedTempPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $resolvedTarget = [System.IO.Path]::GetFullPath($temporaryRoot)
    if ($resolvedTarget.StartsWith($expectedTempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedTarget).StartsWith('Codex Mesh 控制器测试 ')) {
        Remove-Item -LiteralPath $resolvedTarget -Recurse -Force -ErrorAction SilentlyContinue
    }
}
