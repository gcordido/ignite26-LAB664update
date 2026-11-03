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
$state.resources = @(
    @{id=$state.outputs.searchServiceResourceId.value; name='test-search'; type='Microsoft.Search/searchServices'},
    @{id=$state.outputs.storageAccountResourceId.value; name='teststorage'; type='Microsoft.Storage/storageAccounts'},
    @{id=$state.outputs.accountResourceId.value; name='test-foundry'; type='Microsoft.CognitiveServices/accounts'; kind='AIServices'}
)
$state.models = @(
    @{name='test-model'; properties=@{provisioningState='Succeeded'; model=@{name='gpt-5.2'}}},
    @{name='embeddings'; properties=@{provisioningState='Succeeded'; model=@{name='text-embedding-3-large'}}}
)
$state.failDiscovery = $false
function az {
    $state.cliCalls.Add(@($args))
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'resource') {
        if ($state.failDiscovery) { $global:LASTEXITCODE = 1; return }
        ConvertTo-Json -InputObject $state.resources -Depth 6 -Compress
    }
    elseif ($args[0] -eq 'cognitiveservices') {
        ConvertTo-Json -InputObject $state.models -Depth 6 -Compress
    }
    elseif ($args[0] -eq 'deployment') {
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
    Assert ($state.pythonCalls[-1][0] -like '*setup-policy-index.py') 'Default must use Search-managed Standard indexing.'
    Assert ($state.pythonCalls[-1] -notcontains '--index-only') 'Default deploy must prepare and activate the workbench configuration.'
    Assert (-not (Test-Path (Join-Path $root '.tools\policy-deployment.json'))) 'Preflight must not save settings.'

    & $deploy -PythonExecutable Invoke-TestPython -Apply -UseLayout -SourceIndex source-index -IndexName isolated-index
    Assert ($state.pythonCalls[-1][0] -like '*setup-policy-layout.py') 'Legacy Layout must remain explicit.'
    Assert ($state.pythonCalls[-1] -contains '--apply') 'Apply must propagate.'
    Assert ($state.pythonCalls[-1] -contains 'source-index') 'Source must propagate.'
    Assert ($state.pythonCalls[-1] -contains 'isolated-index') 'Target must propagate.'

    $count = $state.pythonCalls.Count
    & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group -DeployResources | Out-Null
    Assert ($state.cliCalls[-1] -contains 'what-if') 'ARM preview must use what-if.'
    Assert ($state.pythonCalls.Count -eq $count) 'ARM preview must not ingest.'

    & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group -Subscription test-sub -DeployResources -Apply
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
    & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group -DeployResources -Apply
    $settings = Get-Content (Join-Path $root '.tools\policy-deployment.json') -Raw | ConvertFrom-Json
    Assert ($settings.layoutIndexName -eq 'previous-target') 'Same-service reruns must retain the target.'
    $state.outputs.searchServiceResourceId.value = "$resourceRoot/Microsoft.Search/searchServices/new-search"
    & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group -DeployResources -Apply
    $settings = Get-Content (Join-Path $root '.tools\policy-deployment.json') -Raw | ConvertFrom-Json
    Assert (-not $settings.layoutSourceIndex) 'A new Search service must not inherit another service source.'
    Assert (-not $settings.layoutIndexName) 'A new Search service must not inherit another service target.'

    $settingsFile = Join-Path $root '.tools\policy-deployment.json'
    $before = Get-Content -LiteralPath $settingsFile -Raw
    $state.cliCalls.Clear()
    & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group -Subscription test-sub
    Assert ($state.cliCalls.Count -eq 3) 'Discovery must only read account, resources and models.'
    foreach ($call in $state.cliCalls) {
        Assert ($call -contains 'test-sub') 'Subscription must propagate to every discovery read.'
        Assert ($call -notcontains 'create') 'Discovery must never deploy ARM.'
    }
    Assert ((Get-Content -LiteralPath $settingsFile -Raw) -eq $before) 'Discovery preview must not save settings.'
    Assert ($state.pythonCalls[-1] -contains '--search-resource-id') 'Discovered targets must override previous configuration.'
    Assert ($state.pythonCalls[-1] -contains 'test-model') 'Discovery must select the policy model, not embeddings.'
    Assert ($state.pythonCalls[-1] -contains '--cu-model-name') 'Actual CU model name must propagate.'
    Assert ($state.pythonCalls[-1] -contains '--create-claim-analyzer') 'Discovery must prepare the default claim analyzer.'
    Assert ($state.pythonCalls[-1] -notcontains '--index-only') 'Discovery must activate the workbench after verification.'
    Assert ($state.pythonCalls[-1] -notcontains '--apply') 'Discovery preview must not apply.'
    Assert ($state.pythonCalls[-1] -notcontains 'previous-source') 'A different Search service must not reuse old index names.'

    & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group -Apply
    $settings = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
    Assert ($settings.searchResourceId -eq $state.resources[0].id) 'Discovery must save actual resource IDs after apply.'
    Assert ($settings.claimAnalyzerId -eq 'lab664_policy_checks_claim_summary') 'Default claim schema must use the lab analyzer ID.'

    & $deploy -PythonExecutable Invoke-TestPython -Apply
    Assert ($state.pythonCalls[-1] -notcontains '--index-only') 'Saved-settings deploy must activate runtime configuration.'
    Assert ($state.pythonCalls[-1] -contains '--create-claim-analyzer') 'Saved default analyzer must be prepared automatically.'
    $settings.claimAnalyzerId = 'custom_existing_claims'
    $settings | ConvertTo-Json | Set-Content -LiteralPath $settingsFile
    & $deploy -PythonExecutable Invoke-TestPython -Apply
    Assert ($state.pythonCalls[-1] -notcontains '--index-only') 'Custom saved analyzer must still activate runtime configuration.'
    Assert ($state.pythonCalls[-1] -notcontains '--create-claim-analyzer') 'A custom saved analyzer must be used unchanged by default.'
    $settings.claimAnalyzerId = 'lab664_policy_checks_claim_summary'
    $settings | ConvertTo-Json | Set-Content -LiteralPath $settingsFile
    $count = $state.pythonCalls.Count
    $failed = $false
    try { & $deploy -PythonExecutable Invoke-TestPython -IndexName legacy-index } catch {
        $failed = $_.Exception.Message -like '*require -UseLayout*'
    }
    Assert $failed 'Legacy index options must not be silently used for Standard indexing.'
    Assert ($state.pythonCalls.Count -eq $count) 'Invalid Standard options must not invoke indexing.'

    $count = $state.pythonCalls.Count
    $state.resources += @{id="$resourceRoot/Microsoft.Search/searchServices/other"; name='other'; type='Microsoft.Search/searchServices'}
    $failed = $false
    try { & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group -Apply } catch {
        $failed = $_.Exception.Message -like '*SearchResourceId*'
    }
    Assert $failed 'Ambiguous services must stop with an actionable override.'
    Assert ($state.pythonCalls.Count -eq $count) 'Ambiguous discovery must not ingest.'
    & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group -SearchResourceId $state.resources[0].id
    Assert ($state.pythonCalls.Count -eq ($count + 1)) 'An explicit resource ID must resolve ambiguity.'
    $state.resources = @($state.resources | Where-Object { $_.name -ne 'other' })

    $state.models += @{name='second-policy'; properties=@{provisioningState='Succeeded'; model=@{name='gpt-5.2'}}}
    $failed = $false
    try { & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group } catch {
        $failed = $_.Exception.Message -like '*ModelDeployment*'
    }
    Assert $failed 'Ambiguous policy models must require an override.'
    & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group -ModelDeployment second-policy -ClaimAnalyzerId existing_claims
    Assert ($state.pythonCalls[-1] -contains 'second-policy') 'Explicit model must propagate.'
    Assert ($state.pythonCalls[-1] -contains 'existing_claims') 'Explicit analyzer must propagate.'
    Assert ($state.pythonCalls[-1] -notcontains '--create-claim-analyzer') 'An explicit existing analyzer must not be recreated.'

    $state.models = @($state.models | Where-Object { $_.name -eq 'embeddings' })
    $failed = $false
    try { & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group } catch {
        $failed = $_.Exception.Message -like '*ModelDeployment*'
    }
    Assert $failed 'Missing policy models must not fall back to embeddings.'
    $failed = $false
    try { & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group -ModelDeployment embeddings } catch {
        $failed = $_.Exception.Message -like '*not embeddings*'
    }
    Assert $failed 'An embedding override must not be accepted as a chat model.'
    $state.models = @(@{name='test-model'; properties=@{provisioningState='Succeeded'; model=@{name='gpt-5.2'}}})

    $state.failDiscovery = $true
    $count = $state.pythonCalls.Count
    $failed = $false
    try { & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup missing-group -Apply } catch {
        $failed = $_.Exception.Message -like '*Azure discovery failed*'
    }
    Assert $failed 'Missing groups and denied reads must fail discovery explicitly.'
    Assert ($state.pythonCalls.Count -eq $count) 'Discovery failure must not ingest.'
    $state.failDiscovery = $false

    $state.resources = @($state.resources | Where-Object { $_.type -ne 'Microsoft.Search/searchServices' })
    $failed = $false
    try { & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group -Apply } catch {
        $failed = $_.Exception.Message -like '*found 0*'
    }
    Assert $failed 'Missing resources must not trigger ARM deployment.'

    $state.failPython = $true
    $before = Get-Content -LiteralPath $settingsFile -Raw
    $state.resources += @{id=$state.outputs.searchServiceResourceId.value; name='new-search'; type='Microsoft.Search/searchServices'}
    $failed = $false
    try { & $deploy -PythonExecutable Invoke-TestPython -ResourceGroup test-group -Apply } catch { $failed = $true }
    Assert $failed 'Index errors must fail deployment.'
    Assert ((Get-Content -LiteralPath $settingsFile -Raw) -eq $before) 'Failed ingestion must not save new deployment settings.'
    Write-Output 'Deployment entrypoint regressions passed.'
    $global:LASTEXITCODE = 0
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force
}
