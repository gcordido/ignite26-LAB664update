[CmdletBinding()]
param(
    [string]$Endpoint = $env:CU_ENDPOINT,
    [ValidateSet('2025-11-01', '2026-06-01-preview')]
    [string]$ApiVersion = '2026-06-01-preview',
    [ValidateRange(1, 65535)]
    [int]$Port = 8791
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$env:Path = "$(Join-Path $repositoryRoot '.tools\node');$env:Path;$([Environment]::GetEnvironmentVariable('Path', 'Machine'));$([Environment]::GetEnvironmentVariable('Path', 'User'))"
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue) -or
    -not (Test-Path -LiteralPath (Join-Path $repositoryRoot 'src\workbench\node_modules\tsx\dist\cli.mjs'))) {
    throw 'Run .\infra\setup.ps1 from the repository root first to install the workbench dependencies.'
}
if ($Endpoint) {
    $uri = $null
    if (-not [Uri]::TryCreate($Endpoint, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or
        $uri.Host -notmatch '\.(services\.ai|cognitiveservices)\.azure\.com$' -or
        $uri.AbsolutePath -ne '/' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw 'Endpoint must be an HTTPS Azure CU resource root, not a Studio/project URL.'
    }
}
$env:CU_ENDPOINT = $Endpoint
$env:CU_API_VERSION = $ApiVersion
$env:PORT = [string]$Port
Write-Host "Starting the separate Insurance Workbench App at http://127.0.0.1:$Port/"
if (-not $Endpoint) {
    Write-Host 'Cache-only mode: no Azure endpoint configured. Load the included completed results.'
}
Write-Host 'Keep this terminal open. Press Ctrl+C to stop. No document analysis is submitted on launch.'
Push-Location (Join-Path $repositoryRoot 'src\workbench')
try {
    & node.exe .\node_modules\tsx\dist\cli.mjs .\src\server.ts
    if ($LASTEXITCODE -ne 0) { throw "Insurance Workbench stopped with exit $LASTEXITCODE." }
}
finally { Pop-Location }
