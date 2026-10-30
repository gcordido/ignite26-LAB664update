[CmdletBinding()]
param(
    [string]$ResourceGroup,
    [string]$Subscription,
    [string]$ParametersFile,
    [string]$DeploymentName = 'lab664',
    [string]$PythonExecutable,
    [string]$SourceIndex,
    [string]$IndexName,
    [switch]$Apply,
    [switch]$CreateClaimAnalyzer
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
if (-not $PythonExecutable) {
    $PythonExecutable = Join-Path $repositoryRoot '.tools\policy-venv\Scripts\python.exe'
}
if (-not (Get-Command $PythonExecutable -ErrorAction SilentlyContinue)) {
    throw 'Prepare the runtime with infra\setup.ps1, or pass -PythonExecutable for an existing prepared environment.'
}
& az account show --output none
if ($LASTEXITCODE -ne 0) { throw 'Sign in with az login before deploying infrastructure.' }

if ($ResourceGroup) {
    $arguments = @('deployment', 'group')
    if ($Apply) { $arguments += 'create' } else { $arguments += 'what-if' }
    $arguments += @('--resource-group', $ResourceGroup, '--name', $DeploymentName,
        '--template-file', (Join-Path $PSScriptRoot 'Lab664-arm-template.json'), '--output', 'json')
    if ($Subscription) { $arguments += @('--subscription', $Subscription) }
    if ($ParametersFile) { $arguments += @('--parameters', "@$ParametersFile") }
    Write-Host 'Preparing lab Azure resources...'
    $result = & az @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Azure infrastructure deployment failed; policy configuration was not activated.' }
    if (-not $Apply) {
        $result | Write-Output
        Write-Host 'Preview only. Repeat with -Apply to deploy resources and provision the CU Layout policy index.'
        return
    }
    $outputs = ($result | ConvertFrom-Json).properties.outputs
    $settings = @{
        searchResourceId = $outputs.searchServiceResourceId.value
        storageResourceId = $outputs.storageAccountResourceId.value
        foundryResourceId = $outputs.accountResourceId.value
        modelDeployment = $outputs.policyModelDeployment.value
        cuModelName = $outputs.policyCuModelName.value
        claimAnalyzerId = $outputs.policyClaimAnalyzerId.value
        cuApiVersion = '2026-06-01-preview'
    }
    if ($settings.Values | Where-Object { -not $_ }) {
        throw 'Azure deployment outputs are incomplete; policy configuration was not activated.'
    }
    $tools = Join-Path $repositoryRoot '.tools'
    New-Item -ItemType Directory -Path $tools -Force | Out-Null
    $settingsPath = Join-Path $tools 'policy-deployment.json'
    if (Test-Path -LiteralPath $settingsPath) {
        $previous = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
        if ($previous.searchResourceId -eq $settings.searchResourceId) {
            foreach ($key in @('layoutSourceIndex', 'layoutIndexName')) {
                if ($previous.$key) { $settings[$key] = $previous.$key }
            }
        }
    }
    if ($SourceIndex) { $settings.layoutSourceIndex = $SourceIndex }
    if ($IndexName) { $settings.layoutIndexName = $IndexName }
    $json = $settings | ConvertTo-Json
    [IO.File]::WriteAllText("$settingsPath.tmp", $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath "$settingsPath.tmp" -Destination $settingsPath -Force
    $CreateClaimAnalyzer = $true
}
elseif ($ParametersFile -or $Subscription) {
    throw '-ParametersFile and -Subscription require -ResourceGroup. Existing services use resource IDs in .tools\policy-deployment.json.'
}

$layoutArguments = @((Join-Path $PSScriptRoot 'setup-policy-layout.py'))
if ($SourceIndex) { $layoutArguments += @('--source-index', $SourceIndex) }
if ($IndexName) { $layoutArguments += @('--index-name', $IndexName) }
if ($Apply) { $layoutArguments += '--apply' }
if ($CreateClaimAnalyzer) { $layoutArguments += '--create-claim-analyzer' }
Write-Host 'Preparing the direct Search policy index with CU Layout...'
& $PythonExecutable @layoutArguments
if ($LASTEXITCODE -ne 0) {
    throw 'Policy index deployment failed. The previous verified workbench configuration remains active; resolve the reported error and rerun.'
}
