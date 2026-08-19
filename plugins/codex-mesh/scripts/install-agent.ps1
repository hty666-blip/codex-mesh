[CmdletBinding()]
param(
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'CodexMesh'),
    [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Node20 {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        throw 'Node.js 20 or newer is required. Install Node.js, then run this script again.'
    }
    $versionText = (& node --version).TrimStart('v')
    $major = [int]($versionText.Split('.')[0])
    if ($major -lt 20) {
        throw "Node.js 20 or newer is required; found $versionText."
    }
}

Assert-Node20
$resolvedSource = (Resolve-Path -LiteralPath $SourceRoot).Path
$resolvedDestination = [System.IO.Path]::GetFullPath($Destination)
if ($resolvedDestination -eq $resolvedSource) {
    throw 'Destination must differ from the source checkout.'
}

$sourceAgent = Join-Path $resolvedSource 'src\agent'
$sourceCli = Join-Path $resolvedSource 'src\cli'
if (-not (Test-Path -LiteralPath $sourceAgent) -or -not (Test-Path -LiteralPath $sourceCli)) {
    throw "Could not find src\agent and src\cli below $resolvedSource."
}

$srcDestination = Join-Path $resolvedDestination 'src'
$binDestination = Join-Path $resolvedDestination 'bin'
$exampleDestination = Join-Path $resolvedDestination 'examples'
New-Item -ItemType Directory -Force -Path $srcDestination, $binDestination, $exampleDestination | Out-Null
Copy-Item -LiteralPath $sourceAgent -Destination $srcDestination -Recurse -Force
Copy-Item -LiteralPath $sourceCli -Destination $srcDestination -Recurse -Force
Copy-Item -Path (Join-Path $resolvedSource 'examples\*.json') -Destination $exampleDestination -Force

$agentLauncher = Join-Path $binDestination 'mesh-agent.cmd'
$cliLauncher = Join-Path $binDestination 'meshctl.cmd'
Set-Content -LiteralPath $agentLauncher -Encoding Ascii -Value '@echo off', 'node "%~dp0..\src\agent\index.mjs" %*'
Set-Content -LiteralPath $cliLauncher -Encoding Ascii -Value '@echo off', 'node "%~dp0..\src\cli\index.mjs" %*'

Write-Host "Codex Mesh files copied to $resolvedDestination"
Write-Host 'No service, scheduled task, firewall rule, or administrator-level change was made.'
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. On the controller, run: meshctl pair --name worker-win11'
Write-Host "  2. Back on this machine, enroll it: $agentLauncher enroll --hub http://TAILSCALE-IP:7337 --pairing-code CODE --name worker-win11 --workspace project/example=D:\Projects\example"
Write-Host "  3. Test in the foreground: $agentLauncher run"
Write-Host '  4. If desired, customize scripts\windows\codex-mesh-agent-task.xml.template from the checkout and import it manually in Task Scheduler.'
