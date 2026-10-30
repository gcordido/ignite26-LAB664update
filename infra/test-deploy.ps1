$ErrorActionPreference = 'Stop'
$root = Join-Path (Split-Path -Parent $PSScriptRoot) ".tools\deploy-tests-$([guid]::NewGuid().ToString('N'))"
$infra = Join-Path $root 'infra'
New-Item -ItemType Directory -Path $infra -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'deploy.ps1') -Destination $infra
$state = @{
    cliCalls = [Collections.Generic.List[object]]::new()
    pythonCalls = [Collections.Generic.List[object]]::new()
    failPython = $false
}
$resourceRoot = '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/test/providers'
$state.outputs = @{
    searchServiceResourceId = @{value="$resourceRoot/Microsoft.Search/searchServices/test-search"}
    storageAccountResourceId = @{value="$resourceRoot/Microsoft.Storage/storageAccounts/teststorage"}
    accountResourceId = @{value="$resourceRoot/Microsoft.CognitiveServices/accounts/test-foundry"}
    policyModelDeployment = @{value='test-model'}
    policyCuModelName = @{value='gpt-5.2'}
    policyClaimAnalyzerId = @{value='test_claims'}
}
function az {
    $state.cliCalls.Add(@($args))
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'deployment') {
        @{properties=@{outputs=$state.outputs}} | ConvertTo-Json -Depth 5 -Compress
    }
}
function Invoke-TestPython {
    $state.pythonCalls.Add(@($args))
    $global:LASTEXITCODE = [int]$state.failPython
}
function Assert($condition, $message) {
    if (-not $condition) { throw $message }
}
try {
    $deploy = Join-Path $infra 'deploy.ps1'
    & $deploy -PythonExecutable Invoke-TestPython
    Assert ($state.pythonCalls.Count -eq 1) 'Existing resources must run policy preflight.'
    Assert ($state.pythonCalls[-1] -notcontains '--apply') 'Default must not apply.'
    Assert (-not (Test-Path (Join-Path $root '.tools\policy-deployment.json'))) 'Preflight must not save settings.'

    & $deploy -PythonExecutable Invoke-TestPython -Apply -SourceIndex source-index -IndexName isolated-index
    Assert ($state.pythonCalls[-1] -contains '--apply') 'Apply must propagate.'
    Assert ($state.pythonCalls[-1] -contains 'source-index') 'Source must propagate.'
    Assert ($state.pythonCalls[-1] -contains 'isolated-index') 'Target must propagate.'

    $count = $state.pythonCalls.Count
    & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group | Out-Null
    Assert ($state.cliCalls[-1] -contains 'what-if') 'ARM preview must use what-if.'
    Assert ($state.pythonCalls.Count -eq $count) 'ARM preview must not ingest.'

    & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group -Subscription test-sub -Apply
    Assert ($state.cliCalls[-1] -contains 'create') 'ARM apply must deploy.'
    Assert ($state.cliCalls[-1] -contains 'test-sub') 'Subscription must propagate.'
    Assert ($state.pythonCalls[-1] -contains '--create-claim-analyzer') 'Fresh ARM must bootstrap the claim analyzer.'
    $settings = Get-Content (Join-Path $root '.tools\policy-deployment.json') -Raw | ConvertFrom-Json
    Assert ($settings.searchResourceId -eq $state.outputs.searchServiceResourceId.value) 'Search resource ID must propagate.'
    Assert ($settings.modelDeployment -eq 'test-model') 'Actual deployment name must propagate.'
    Assert ($settings.cuModelName -eq 'gpt-5.2') 'CU model name must propagate.'

    $settings | Add-Member layoutSourceIndex 'previous-source'
    $settings | Add-Member layoutIndexName 'previous-target'
    $settings | ConvertTo-Json | Set-Content (Join-Path $root '.tools\policy-deployment.json')
    & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group -Apply
    $settings = Get-Content (Join-Path $root '.tools\policy-deployment.json') -Raw | ConvertFrom-Json
    Assert ($settings.layoutIndexName -eq 'previous-target') 'Same-service reruns must retain the target.'
    $state.outputs.searchServiceResourceId.value = "$resourceRoot/Microsoft.Search/searchServices/new-search"
    & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group -Apply
    $settings = Get-Content (Join-Path $root '.tools\policy-deployment.json') -Raw | ConvertFrom-Json
    Assert (-not $settings.layoutSourceIndex) 'A new Search service must not inherit another service source.'
    Assert (-not $settings.layoutIndexName) 'A new Search service must not inherit another service target.'

    $state.failPython = $true
    $failed = $false
    try { & $deploy -PythonExecutable Invoke-TestPython -Apply } catch { $failed = $true }
    Assert $failed 'Index errors must fail deployment.'
    Write-Output 'Deployment entrypoint regressions passed.'
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force
}
