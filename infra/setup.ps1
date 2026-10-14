[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $repositoryRoot '.tools'
$portableNode = Join-Path $tools 'node'

function Update-ToolPath {
    $env:Path = "$portableNode;$env:Path;$([Environment]::GetEnvironmentVariable('Path', 'Machine'));$([Environment]::GetEnvironmentVariable('Path', 'User'))"
}

Update-ToolPath
$nodeReady = $false
if (Get-Command node.exe -ErrorAction SilentlyContinue) {
    & node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) > 22 || (Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) >= 12) ? 0 : 1)"
    $nodeReady = $LASTEXITCODE -eq 0
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
    Move-Item -LiteralPath (Join-Path $tools $name) -Destination $portableNode
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

Push-Location (Join-Path $repositoryRoot 'src\workbench')
try {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "Workbench dependency installation failed (exit $LASTEXITCODE)." }
}
finally { Pop-Location }

Write-Host ''
Write-Host 'Setup complete. Open instructions\lab.html and follow steps 1-5.'
Write-Host 'The separate Insurance Workbench App has NOT been launched.'
Write-Host 'Launch it yourself from the repository root in step 5: .\infra\launch-workbench.ps1'
