[CmdletBinding()]
param(
    [ValidateSet('export', 'restore')]
    [string]$Action = 'restore',
    [string]$RunId
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$env:Path = "$(Join-Path $repositoryRoot '.tools\node');$env:Path"
$tsx = Join-Path $repositoryRoot 'src\workbench\node_modules\tsx\dist\cli.mjs'
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue) -or -not (Test-Path -LiteralPath $tsx)) {
    throw 'Prepare the existing workbench dependencies with infra\setup.ps1 before restoring the demo cache.'
}
& node.exe $tsx (Join-Path $repositoryRoot 'src\workbench\src\policy-demo-cache.ts') $Action $RunId
if ($LASTEXITCODE -ne 0) { throw "Policy demo cache $Action failed (exit $LASTEXITCODE). See the error above." }
