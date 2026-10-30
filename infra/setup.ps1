[CmdletBinding()]
param(
    [string]$PythonExecutable = 'python',
    [string]$NpmRegistry,
    [string]$PythonIndexUrl,
    [switch]$DeployPolicyIndex
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $repositoryRoot '.tools'
$portableNode = Join-Path $tools 'node'
$policyEnvironment = Join-Path $tools 'policy-venv'
$policyPython = Join-Path $policyEnvironment 'Scripts\python.exe'

function Update-ToolPath {
    $env:Path = "$portableNode;$env:Path;$([Environment]::GetEnvironmentVariable('Path', 'Machine'));$([Environment]::GetEnvironmentVariable('Path', 'User'))"
}

Update-ToolPath
$nodeReady = $false
if (Get-Command node.exe -ErrorAction SilentlyContinue) {
    & node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) > 22 || (Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) >= 12) ? 0 : 1)"
    $nodeReady = $LASTEXITCODE -eq 0 -and [bool](Get-Command npm.cmd -ErrorAction SilentlyContinue)
}
if (-not $nodeReady) {
    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
        throw 'Automatic Node setup supports Windows x64. Install Node 22.12+ with npm for this architecture, then rerun setup.ps1.'
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    New-Item -ItemType Directory -Path $tools -Force | Out-Null
    $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
    $release = $releases |
        Where-Object { $_.version -like 'v24.*' -and $_.lts -and $_.files -contains 'win-x64-zip' } |
        Select-Object -First 1
    if (-not $release) { throw 'No supported Node 24 LTS download was found.' }
    $name = "node-$($release.version)-win-x64"
    $zip = Join-Path $tools "$name.zip"
    $base = "https://nodejs.org/dist/$($release.version)"
    Write-Host "Installing portable Node $($release.version)..."
    Invoke-WebRequest -Uri "$base/$name.zip" -OutFile $zip -UseBasicParsing
    $checksums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
    $line = ($checksums -split "`n") | Where-Object { $_ -match "\s+$([regex]::Escape($name))\.zip\s*$" }
    if (@($line).Count -ne 1) { throw 'The Node download has no unique official SHA-256 checksum.' }
    $expected = ($line.Trim() -split '\s+')[0]
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $expected) {
        throw 'Node download checksum mismatch; the archive was not installed.'
    }
    Expand-Archive -LiteralPath $zip -DestinationPath $tools -Force
    if (Test-Path -LiteralPath $portableNode) {
        Copy-Item -Path (Join-Path $tools "$name\*") -Destination $portableNode -Recurse -Force
    }
    else {
        Move-Item -LiteralPath (Join-Path $tools $name) -Destination $portableNode
    }
    Remove-Item -LiteralPath $zip
    Update-ToolPath
}

if (-not (Get-Command az.cmd -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw 'Azure CLI is missing and winget is unavailable. Install Microsoft App Installer (winget), then rerun setup.ps1.'
    }
    Write-Host 'Installing Azure CLI (approve the Windows installer if prompted)...'
    & winget.exe install --id Microsoft.AzureCLI --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI installation failed (exit $LASTEXITCODE)." }
    Update-ToolPath
    if (-not (Get-Command az.cmd -ErrorAction SilentlyContinue)) {
        throw 'Azure CLI is not on PATH after installation. Open a new PowerShell window and rerun setup.ps1.'
    }
}

if (-not (Get-Command $PythonExecutable -ErrorAction SilentlyContinue)) {
    throw 'Python is missing. Install Python 3.10 or later with pip and venv, then rerun setup.ps1. Use -PythonExecutable with its full python.exe path if needed.'
}
& $PythonExecutable -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"
if ($LASTEXITCODE -ne 0) { throw 'Policy checks require Python 3.10 or later. Set -PythonExecutable to a supported python.exe.' }
if (-not (Test-Path -LiteralPath $policyPython)) {
    Write-Host 'Creating the local policy agent Python environment...'
    & $PythonExecutable -m venv $policyEnvironment
    if ($LASTEXITCODE -ne 0) { throw "Python environment creation failed (exit $LASTEXITCODE). Check that Python includes venv." }
}
$pipArguments = @('-m', 'pip', 'install', '-r', (Join-Path $PSScriptRoot 'requirements-policy-agent-framework.txt'))
if ($PythonIndexUrl) { $pipArguments += @('--index-url', $PythonIndexUrl) }
Write-Host 'Installing Python Agent Framework, Content Understanding and Azure Search dependencies...'
& $policyPython @pipArguments
if ($LASTEXITCODE -ne 0) {
    throw "Python dependency installation failed (exit $LASTEXITCODE). Check the configured pip index and access to the pinned versions. Use -PythonIndexUrl only with an approved package index."
}
& $policyPython -m pip check
if ($LASTEXITCODE -ne 0) { throw "Python dependencies are incompatible (exit $LASTEXITCODE)." }
& $policyPython -c "from agent_framework import Agent, Message, tool; from agent_framework.openai import OpenAIChatClient; from azure.identity import AzureCliCredential; from azure.search.documents import SearchClient; from azure.ai.contentunderstanding import to_llm_input; from azure.ai.contentunderstanding.models import AnalysisResult; from openai import AsyncOpenAI"
if ($LASTEXITCODE -ne 0) { throw "Policy agent imports failed (exit $LASTEXITCODE). Rerun setup after resolving the Python dependency error." }

Push-Location (Join-Path $repositoryRoot 'src\workbench')
try {
    $npmArguments = @('ci', '--no-audit', '--no-fund')
    if ($NpmRegistry) { $npmArguments += @('--registry', $NpmRegistry) }
    & npm.cmd @npmArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Workbench dependency installation failed (exit $LASTEXITCODE). Check the configured npm registry and package-lock.json. Use -NpmRegistry only with an approved registry; do not install individual packages or delete the lockfile."
    }
    & node.exe --input-type=module -e "import { existsSync } from 'node:fs'; for (const p of ['tsx','express','deep-chat','@azure/identity']) { const f = import.meta.resolve(p); if (!existsSync(new URL(f))) throw new Error('Missing package: ' + p); }"
    if ($LASTEXITCODE -ne 0) { throw "Workbench dependency verification failed (exit $LASTEXITCODE)." }
}
finally { Pop-Location }

if ($DeployPolicyIndex) {
    & (Join-Path $PSScriptRoot 'deploy.ps1') -Apply -PythonExecutable $policyPython
}

Write-Host ''
Write-Host 'Setup complete. Open instructions\lab.html and follow steps 1-5.'
Write-Host 'The separate Insurance Workbench App has NOT been launched.'
Write-Host 'Python agent: .tools\policy-venv\Scripts\python.exe (selected automatically by the launcher).'
Write-Host 'Policy checks also need Azure CLI sign-in and a prepared policy index; see docs\policy-setup.md.'
Write-Host 'Launch it yourself from the repository root in step 5: .\infra\launch-workbench.ps1'
