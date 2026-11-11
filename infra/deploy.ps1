[CmdletBinding()]
param(
    [string]$ResourceGroup,
    [string]$Subscription,
    [string]$ParametersFile,
    [string]$DeploymentName = 'lab664',
    [string]$PythonExecutable,
    [string]$SourceIndex,
    [string]$IndexName,
    [string]$SearchResourceId,
    [string]$StorageResourceId,
    [string]$FoundryResourceId,
    [string]$ModelDeployment,
    [string]$ClaimAnalyzerId,
    [switch]$DeployResources,
    [switch]$UseLayout,
    [switch]$Apply,
    [switch]$CreateClaimAnalyzer
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
if (($SourceIndex -or $IndexName) -and -not $UseLayout) {
    throw '-SourceIndex and -IndexName are legacy Layout options and require -UseLayout. Standard ingestion uses generation-scoped names.'
}
if ($DeployResources -and -not $ResourceGroup) {
    throw '-DeployResources requires -ResourceGroup.'
}
if ($ParametersFile -and -not $DeployResources) {
    throw '-ParametersFile is only used with -DeployResources. Resource-group discovery does not deploy ARM.'
}
if (($SearchResourceId -or $StorageResourceId -or $FoundryResourceId -or $ModelDeployment -or $ClaimAnalyzerId) -and
    (-not $ResourceGroup -or $DeployResources)) {
    throw 'Resource/model/analyzer overrides require -ResourceGroup without -DeployResources.'
}
if (-not $PythonExecutable) {
    $PythonExecutable = Join-Path $repositoryRoot '.tools\policy-venv\Scripts\python.exe'
}
if (-not (Get-Command $PythonExecutable -ErrorAction SilentlyContinue)) {
    throw 'Prepare the runtime with infra\setup.ps1, or pass -PythonExecutable for an existing prepared environment.'
}
$subscriptionArguments = @()
if ($Subscription) { $subscriptionArguments = @('--subscription', $Subscription) }
& az account show @subscriptionArguments --output none
if ($LASTEXITCODE -ne 0) { throw 'Sign in with az login before deploying infrastructure.' }

function Read-AzureJson {
    param([string[]]$Arguments)
    $result = & az @Arguments @subscriptionArguments --output json
    if ($LASTEXITCODE -ne 0) {
        throw "Azure discovery failed (az $($Arguments -join ' ')). No ARM deployment was attempted; check the subscription, resource group and read permissions."
    }
    if (-not $result) { throw 'Azure CLI returned no discovery data.' }
    return ($result | ConvertFrom-Json)
}

function Select-LabResource {
    param([object[]]$Resources, [string]$Type, [string]$Id, [string]$Option)
    $candidates = @($Resources | Where-Object { $_.type -eq $Type })
    if ($Type -eq 'Microsoft.CognitiveServices/accounts') {
        $candidates = @($candidates | Where-Object { $_.kind -eq 'AIServices' })
    }
    if ($Id) { $candidates = @($candidates | Where-Object { $_.id -eq $Id }) }
    if ($candidates.Count -ne 1) {
        $available = @($Resources | Where-Object { $_.type -eq $Type } | ForEach-Object { $_.id }) -join ', '
        throw "Expected one $Type resource in '$ResourceGroup', found $($candidates.Count). Pass -$Option with an exact resource ID from this group. Available: $available"
    }
    if (-not $candidates[0].id) { throw "Azure returned a $Type resource without an ID." }
    return $candidates[0]
}

$settings = $null
if ($DeployResources) {
    $arguments = @('deployment', 'group')
    if ($Apply) { $arguments += 'create' } else { $arguments += 'what-if' }
    $arguments += @('--resource-group', $ResourceGroup, '--name', $DeploymentName,
        '--template-file', (Join-Path $PSScriptRoot 'Lab664-arm-template.json'), '--output', 'json')
    $arguments += $subscriptionArguments
    if ($ParametersFile) { $arguments += @('--parameters', "@$ParametersFile") }
    Write-Host 'Preparing lab Azure resources...'
    $result = & az @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Azure infrastructure deployment failed; policy configuration was not activated.' }
    if (-not $Apply) {
        $result | Write-Output
        Write-Host 'Preview only. Repeat with -DeployResources -Apply to deploy resources and run Search-managed policy indexing.'
        return
    }
    $outputs = ($result | ConvertFrom-Json).properties.outputs
    $settings = @{
        searchResourceId = $outputs.searchServiceResourceId.value
        storageResourceId = $outputs.storageAccountResourceId.value
        foundryResourceId = $outputs.accountResourceId.value
        modelDeployment = $outputs.policyModelDeployment.value
        cuModelName = $outputs.policyCuModelName.value
        indexModelDeployment = $outputs.policyIndexModelDeployment.value
        indexCuModelName = $outputs.policyIndexCuModelName.value
        cuApiVersion = '2026-06-01-preview'
    }
    if ($settings.Values | Where-Object { -not $_ }) {
        throw 'Azure deployment outputs are incomplete; policy configuration was not activated.'
    }
    if ($CreateClaimAnalyzer) {
        $ClaimAnalyzerId = $outputs.policyClaimAnalyzerId.value
        if (-not $ClaimAnalyzerId) { throw 'Explicit legacy analyzer creation requires the policyClaimAnalyzerId ARM output.' }
    }
}
elseif ($ResourceGroup) {
    Write-Host "Discovering existing lab resources in '$ResourceGroup' (no ARM deployment or role assignments)..."
    $resources = @(Read-AzureJson -Arguments @('resource', 'list', '--resource-group', $ResourceGroup))
    $search = Select-LabResource $resources 'Microsoft.Search/searchServices' $SearchResourceId 'SearchResourceId'
    $storage = Select-LabResource $resources 'Microsoft.Storage/storageAccounts' $StorageResourceId 'StorageResourceId'
    $foundry = Select-LabResource $resources 'Microsoft.CognitiveServices/accounts' $FoundryResourceId 'FoundryResourceId'
    $deployments = @(Read-AzureJson -Arguments @('cognitiveservices', 'account', 'deployment', 'list',
        '--resource-group', $ResourceGroup, '--name', $foundry.name))
    $ready = @($deployments | Where-Object { $_.properties.provisioningState -eq 'Succeeded' })
    if ($ModelDeployment) {
        $models = @($ready | Where-Object { $_.name -eq $ModelDeployment })
    }
    else {
        # Match the policy model used by the lab template, not the first deployed model.
        $models = @($ready | Where-Object { $_.properties.model.name -eq 'gpt-5.2' })
    }
    if ($models.Count -ne 1) {
        $available = @($deployments | ForEach-Object {
            "$($_.name) [$($_.properties.model.name), $($_.properties.provisioningState)]"
        }) -join ', '
        throw "Cannot select one ready policy model deployment. Pass -ModelDeployment with its exact deployment name. Without an override, one ready gpt-5.2 deployment is required. Available: $available"
    }
    $model = $models[0]
    if (-not $model.name -or -not $model.properties.model.name -or
        $model.properties.model.name -match 'embedding') {
        throw 'The selected deployment must have a model name and support policy chat, not embeddings.'
    }
    if ($CreateClaimAnalyzer -and -not $ClaimAnalyzerId) {
        $ClaimAnalyzerId = 'lab664_policy_checks_claim_summary'
    }
    $settings = @{
        searchResourceId = $search.id
        storageResourceId = $storage.id
        foundryResourceId = $foundry.id
        modelDeployment = $model.name
        cuModelName = $model.properties.model.name
        cuApiVersion = '2026-06-01-preview'
    }
    # The Search-managed CU skill uses gpt-5.5 when exactly one ready deployment exists.
    $indexModels = @($ready | Where-Object { $_.properties.model.name -eq 'gpt-5.5' })
    if ($indexModels.Count -eq 1) {
        $settings.indexModelDeployment = $indexModels[0].name
        $settings.indexCuModelName = $indexModels[0].properties.model.name
    }
    else {
        Write-Warning "Expected one ready gpt-5.5 deployment for policy indexing, found $($indexModels.Count); indexing uses '$($model.name)'."
    }
    Write-Host ($settings | ConvertTo-Json)
}
elseif ($Subscription) {
    throw '-Subscription requires -ResourceGroup. Without discovery, existing settings contain the target resource IDs.'
}

$settingsPath = Join-Path $repositoryRoot '.tools\policy-deployment.json'
if ($settings) {
    if ($ClaimAnalyzerId) { $settings.claimAnalyzerId = $ClaimAnalyzerId }
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
}

$scriptName = if ($UseLayout) { 'setup-policy-layout.py' } else { 'setup-policy-index.py' }
$policyArguments = @((Join-Path $PSScriptRoot $scriptName))
if ($settings) {
    foreach ($pair in @(
        @('--search-resource-id', 'searchResourceId'),
        @('--storage-resource-id', 'storageResourceId'),
        @('--foundry-resource-id', 'foundryResourceId'),
        @('--model-deployment', 'modelDeployment'),
        @('--cu-model-name', 'cuModelName'),
        @('--cu-api-version', 'cuApiVersion')
    )) {
        $policyArguments += @($pair[0], $settings[$pair[1]])
    }
    if (-not $UseLayout) {
        foreach ($pair in @(
            @('--index-model-deployment', 'indexModelDeployment'),
            @('--index-cu-model-name', 'indexCuModelName')
        )) {
            if ($settings[$pair[1]]) { $policyArguments += @($pair[0], $settings[$pair[1]]) }
        }
    }
    if ($ClaimAnalyzerId) { $policyArguments += @('--claim-analyzer-id', $ClaimAnalyzerId) }
    if ($UseLayout) {
        if (-not $SourceIndex) { $SourceIndex = $settings.layoutSourceIndex }
        if (-not $IndexName) { $IndexName = $settings.layoutIndexName }
    }
}
if ($SourceIndex) { $policyArguments += @('--source-index', $SourceIndex) }
if ($IndexName) { $policyArguments += @('--index-name', $IndexName) }
if ($Apply) { $policyArguments += '--apply' }
if ($CreateClaimAnalyzer) { $policyArguments += '--create-claim-analyzer' }
if ($UseLayout) {
    Write-Host 'Preparing the legacy direct CU Layout index...'
}
else {
    Write-Host 'Preparing Search-managed Standard extraction with semantic chunks and AI figure descriptions...'
}
if ($CreateClaimAnalyzer -or $ClaimAnalyzerId) { Write-Host 'Preparing the explicitly requested legacy claim-summary analyzer...' }
Write-Host 'Preparing the workbench connection; configuration activates only after verification.'
& $PythonExecutable @policyArguments
if ($LASTEXITCODE -ne 0) {
    throw 'Policy index deployment failed. The previous verified workbench configuration remains active; resolve the reported error and rerun.'
}
if ($settings -and $Apply) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $settingsPath) -Force | Out-Null
    $json = $settings | ConvertTo-Json
    [IO.File]::WriteAllText("$settingsPath.tmp", $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath "$settingsPath.tmp" -Destination $settingsPath -Force
    Write-Host 'Saved discovered deployment settings to .tools\policy-deployment.json.'
}
if ($Apply) {
    Write-Host 'Workbench configuration activated: .tools\policy-agent-framework.json. Restart the app and reload the browser.'
}
