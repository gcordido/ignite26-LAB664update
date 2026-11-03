# Set up the policy index

Use one managed ingestion pipeline on the existing Azure AI Search service.
Search-managed Standard ingestion combines Content Understanding (CU) layout
extraction and figure understanding, optimized for search. It produces searchable
text, structured tables and model-generated figure descriptions.
The Python Agent Framework agent queries the resulting ordinary index directly.
No knowledge base, hosted agent or new Search service is needed.

```text
Policy PDFs -> Blob Storage -> Search indexer + Content Understanding skill
           -> Policy index -> Agent Framework -> Five checks and chat
```

## Prerequisites

- A Python environment with
  `infra/requirements-policy-agent-framework.txt` installed.
- Azure CLI sign-in for the identity running setup and the local workbench.
- The existing Search, Blob Storage, Content Understanding and model resources.
- An existing chat model deployment for figure descriptions. The claim analyzer
  is required only when preparing live claim reviews, not for policy indexing.
  Supply resource IDs and model names through resource-group discovery or the
  deployment settings below.
- Policy PDFs registered in the
  [corpus manifest](../data/policies/rental/ocr-comparison-v2/manifest.json) and
  [citation map](../data/policies/rental/ocr-comparison-v2/citations.json).

Setup reports exact missing permissions. The Search managed identity needs
read access to the scoped policy blobs and access to the configured CU/model
resource. The caller also needs permission to manage the lab's indexing objects,
upload its source PDFs, and query the index. Setup doesn't assign roles,
change networking, use account keys or weaken access controls.

## Run setup

For the main infrastructure workflow, use
[`infra/deploy.ps1`](../infra/README.md#deploy-infrastructure-and-the-policy-index).
It defaults to Search-managed Standard ingestion on existing services. Python
uploads the source PDFs and configures the pipeline; Search performs extraction,
semantic chunking, figure descriptions and indexing. No local Layout extraction
or manual chunk upload is used. The former direct Layout workflow is available
only with `-UseLayout`.

The [linked Foundry IQ plugin](https://github.com/microsoft/GitHub-Copilot-for-Azure/tree/main/plugins/foundry-iq-skills)
targets knowledge-source and knowledge-base workflows, not this ordinary-index
integration. No plugin installation or additional dependency is required.

For a lab machine, first run `.\infra\setup.ps1`. This restores Deep Chat and
the other npm packages and installs the Python agent requirements into
`.tools\policy-venv`. Agent Framework is a Python dependency, not an npm package.
The pinned Python requirements also include
`azure-ai-contentunderstanding==1.2.0b3` for native fields-only `to_llm_input`
formatting. Provision this version through the same approved Python package
source on lab machines; it does not add an npm dependency or require attendees
to access the npm registry.
The launcher automatically uses this environment. Stop the app and rerun setup
after pulling dependency updates.

The current claim-summary definition includes explicit rental-request/use
answers and their wording (`RentalRequested`, `RentalUsed`,
`RequestTypeEvidence`). An older registered analyzer is not overwritten
automatically. To adopt a schema update, provision the definition under a new
analyzer ID using the documented `--create-claim-analyzer` setup option, activate
that configuration and prepare fresh claim summaries. Their definition hash
isolates earlier extraction/review caches. The Search policy index does not
need different source PDFs for this extraction-only change.

Open the [Python setup notebook](../infra/policy-agent-framework-setup.ipynb)
for a step-by-step walkthrough. The notebook calls the same Python functions
as the automatic script.

An existing workbench configuration supplies the current model and analyzer
names. For a provisioned lab, `deploy.ps1 -ResourceGroup` discovers the actual
resource IDs and model deployment and saves `.tools\policy-deployment.json`
after successful apply; no manually completed file is required. See
[resource-group discovery](#discover-the-provisioned-lab-resources) below.
Alternatively, provision the settings file using actual ARM resource IDs and
an existing model deployment:

```json
{
  "searchResourceId": "/subscriptions/YOUR-SUBSCRIPTION-ID/resourceGroups/YOUR-RESOURCE-GROUP/providers/Microsoft.Search/searchServices/YOUR-SEARCH",
  "storageResourceId": "/subscriptions/YOUR-SUBSCRIPTION-ID/resourceGroups/YOUR-RESOURCE-GROUP/providers/Microsoft.Storage/storageAccounts/YOUR-STORAGE",
  "foundryResourceId": "/subscriptions/YOUR-SUBSCRIPTION-ID/resourceGroups/YOUR-RESOURCE-GROUP/providers/Microsoft.CognitiveServices/accounts/YOUR-FOUNDRY",
  "modelDeployment": "YOUR-EXISTING-MODEL-DEPLOYMENT",
  "cuModelName": "YOUR-MODEL-NAME",
  "claimAnalyzerId": "lab664_policy_checks_claim_summary",
  "cuApiVersion": "2026-06-01-preview"
}
```

This ignored file contains deployment inputs, not verified runtime state or
credentials. Never put tokens or account keys in it. The scripts derive the
public Azure Search, Blob and Foundry endpoints from the resource IDs.
Settings start with the previously verified runtime configuration; deployment
settings override it, and explicit command-line overrides take precedence over
both. Successful
activation saves the resource IDs with the runtime configuration, so subsequent
runs do not require editing scripts. Existing configurations without resource
IDs need the deployment file once.

Both setup scripts accept `--search-resource-id`, `--storage-resource-id` and
`--foundry-resource-id`. The Standard script also accepts `--cu-model-name` when
the model name differs from its deployment name. The notebook reads the same
deployment file; its `SEED` dictionary is only for optional overrides.

The default operation validates inputs and checks prerequisites without
creating or changing Azure resources. Inspect its report before applying.
Run from the repository root:

```powershell
.\.tools\policy-venv\Scripts\python.exe .\infra\setup-policy-index.py --index-only
```

```powershell
.\.tools\policy-venv\Scripts\python.exe .\infra\setup-policy-index.py --index-only --apply
```

`--index-only` is an advanced Python-only mode that skips claim-analyzer
reads/creation and leaves the active app configuration and its snapshot
untouched. It reports the new index and writes a generation-scoped inspection
snapshot. `deploy.ps1` does not use this mode: successful apply always prepares
the review runtime and writes the workbench configuration.

For live reviews on a fresh lab without a claim extractor, first preview and then explicitly
create the provided literal-fact extraction schema:

```powershell
.\.tools\policy-venv\Scripts\python.exe .\infra\setup-policy-index.py --create-claim-analyzer
.\.tools\policy-venv\Scripts\python.exe .\infra\setup-policy-index.py --apply --create-claim-analyzer
```

This option never overwrites an existing analyzer. A conflicting definition is
an error; choose a different analyzer ID, or omit the option to use an existing
ready analyzer unchanged. No roles are assigned by setup.

The explicit apply operation can incur Blob, Search, CU and model charges.
It scopes uploads and ingestion objects to this lab's manifest-listed PDFs,
waits for the Search indexer, and verifies indexed sources and retrieval.
Only full review preparation activates the index in the workbench configuration.
Conflicting resources and
ingestion errors are reported rather than overwritten or treated as success.

If permissions or required service features are missing, the current working
index and configuration remain active. Resolve the reported prerequisites,
then rerun setup. Existing Azure agents, knowledge bases and other indexes
aren't deleted.

On a fresh clone, `.tools\policy-agent-framework.json` is absent because it is
machine-local and git-ignored. After dependencies are provisioned, launch the app
and load the included CU run, then select **Check policies** > **Load cached
results**. The app reads all ten synthetic reviews (30 comparisons) from
`data\policy-demo`, reusing the committed Parse evidence in `data\results`,
when compatible local reviews aren't available. No claim summary, restore,
Azure configuration, credentials or Azure calls are involved. The **Bundled demo**
label preserves the original index provenance. Existing configuration and caches
aren't overwritten, and live-compatible cached results take precedence.
Bundled results are read-only. Follow-up chat requires a compatible live
model/Search configuration and retains the bundled review's source provenance.

The optional `.\infra\policy-demo-cache.ps1` command still restores a local copy
for cache-maintenance workflows. It refuses to overwrite different existing
configuration or cache files. It isn't required to view the bundled results.

Live reviews still require access to the configured resources. For a different
lab resource or index, the lab owner must prepare a verified configuration with
the setup workflow before attendees arrive. Installing packages alone doesn't
provision Azure resources. After intentionally refreshing all ten reviews,
export a new bundle with `.\infra\policy-demo-cache.ps1 -Action export -RunId RUN-ID`.
Export rejects missing or earlier-prompt results and includes only the selected
run's review files, public configuration and hashes of the existing Parse files,
not logs, credentials or duplicate claim extractions. Earlier five-check results
remain history-only; they aren't reinterpreted as the three new comparisons.

## Prepare live policy checks on a lab machine

The lab's Azure services and permissions must already be provisioned. The local
machine can discover those services using only the resource-group name.
Dependency setup, cached-demo viewing, and live policy setup are separate operations.
`setup.ps1` installs dependencies unless its opt-in `-DeployPolicyIndex` switch
is used; `launch-workbench.ps1` only launches the app. Neither ordinary command
creates or verifies the live Search index or model connection.

### Discover the provisioned lab resources

After restoring dependencies through approved lab sources, sign in and pass the
existing resource group. Discovery does not require access to deployment history
or a pre-filled `.tools\policy-deployment.json`:

```powershell
az login
az account set --subscription "YOUR-LAB-SUBSCRIPTION-ID"
powershell -ExecutionPolicy Bypass -File .\infra\deploy.ps1 `
  -ResourceGroup "YOUR-EXISTING-LAB-RESOURCE-GROUP" -Apply
```

Omit `-Apply` for a read-only preview. `-Subscription` optionally selects the
subscription for all discovery reads without changing the CLI default.
The script lists resources in the specified group, requires a single Search
service, Storage account and Foundry `AIServices` account, and reads that account's
model deployments. It selects the single ready `gpt-5.2` deployment used by the
lab template, using its actual deployment name and underlying model name.
It does not assume resource-name suffixes or select the first result.

If a resource or model is missing or ambiguous, the command stops and lists the
candidates. Resolve ambiguity explicitly, for example:

```powershell
.\infra\deploy.ps1 -ResourceGroup "YOUR-EXISTING-LAB-RESOURCE-GROUP" `
  -SearchResourceId "/subscriptions/YOUR-SUBSCRIPTION-ID/resourceGroups/YOUR-EXISTING-LAB-RESOURCE-GROUP/providers/Microsoft.Search/searchServices/YOUR-SEARCH" `
  -ModelDeployment "YOUR-EXISTING-MODEL-DEPLOYMENT" -Apply
```

`-StorageResourceId` and `-FoundryResourceId` work the same way; selected
resources must exist in the supplied group. Deployment also prepares the lab's
`lab664_policy_checks_claim_summary` analyzer and writes the workbench connection
after verification. This analyzer is created only if absent, including on reruns
using saved default settings. `-ClaimAnalyzerId` selects a different existing
analyzer; with a custom ID, add `-CreateClaimAnalyzer` only to explicitly create
a missing analyzer. Existing definitions are never overwritten.

Discovery reuses services and models; it never falls back to ARM deployment,
role assignment or network changes. Azure permissions for resource reads,
Search index management/query and Blob upload are still required. Search's
managed identity needs Blob read and Foundry invoke permissions. Local
CU/model invocation permissions are needed separately for live reviews.
CU and Search usage may be billed.

Successful apply verifies indexed content and retrieval, saves discovered inputs
and the verified snapshot, and writes `.tools\policy-agent-framework.json`.
It reports the index name, `"extractionMode": "standard"`,
`"figureDescriptions": true` and `"runtimeActivated": true`. Figure descriptions
are enabled in the skill definition, not inferred from a successful OCR result.
Failure preserves the previous active configuration. Preview does not save
settings or activate the app.

Subsequent runs can use the saved settings without another discovery:

```powershell
.\infra\deploy.ps1 -Apply
```

This reuses a completed matching indexer run; it does not force policy extraction
again. No separate activation command is needed. Require `"status": "verified"`
and `"runtimeActivated": true`, restart the app, and exercise an uncached live
review and follow-up chat to verify model access. Cached results alone are not
a connectivity test.

### Deploy or update Azure and Search together

Use `infra\deploy.ps1` as the single Azure deployment/update entrypoint.
Full ARM provisioning is an explicit **lab-owner** operation using
`-DeployResources`, not the default resource-group discovery path.
It requires an identity authorized to create role assignments as well as deploy
resources. Search ingestion is included; do not run a separate Search setup
afterward. First prepare dependencies and sign in with that provisioning identity:

```powershell
az login
az account set --subscription "YOUR-LAB-SUBSCRIPTION-ID"
az account show --query "{subscription:name, subscriptionId:id, tenantId:tenantId}" --output table

# Preview the Azure changes; this does not ingest policies.
powershell -ExecutionPolicy Bypass -File .\infra\deploy.ps1 `
  -ResourceGroup "YOUR-EXISTING-LAB-RESOURCE-GROUP" -DeployResources

# After reviewing the preview, deploy/update Azure and populate Search.
powershell -ExecutionPolicy Bypass -File .\infra\deploy.ps1 `
  -ResourceGroup "YOUR-EXISTING-LAB-RESOURCE-GROUP" -DeployResources -Apply
```

For an existing deployment, reuse its original resource group and ARM parameters,
including any custom `uniqueSuffix`. Pass the same `-ParametersFile` to both
commands when one was used. Otherwise, a different resource name can create
another set of services rather than update the intended ones. This operation
deploys the template's billable services and models; it is not Search-only.

The apply operation deploys the ARM template, takes the actual Search, Storage,
Foundry and model settings from deployment outputs, and runs Search-managed
Standard ingestion, prepares the claim analyzer and activates the app's
configuration after verification.
There is no hosted agent to deploy separately. Missing permissions or ingestion
errors fail the command; they are not a successful combined deployment.
The deployment does not grant the attendee identity's Azure permissions.

Require the final `"status": "verified"` report, not just ARM deployment
success. Restart the workbench and verify an uncached live review and chat under
the intended attendee identity. Keep ARM provisioning separate from
attendee resource-group discovery and index preparation.

### Reuse previously saved settings

After discovery has saved `.tools\policy-deployment.json`, subsequent runs can
omit `-ResourceGroup` to reuse it. This path also supports manually prepared
settings for advanced provisioning; it does not deploy ARM.

1. Provision the existing locked npm dependencies and pinned Python requirements
   through approved lab sources before attendees arrive. Follow
   [package mirror guidance](../infra/README.md#lab-machines-with-package-mirrors).
   Attendees must not need public npm access or additional npm packages.
2. Sign in with `az login`, select the actual lab subscription with
   `az account set --subscription "YOUR-LAB-SUBSCRIPTION-ID"`, and confirm the
   tenant and subscription with `az account show`. The identity running the app
   needs Search index query access and permission to invoke the configured CU
   analyzer and model deployment. The provisioning identity additionally needs
   Search management/query and Blob upload permissions for managed ingestion.
   Subscription selection alone does not redirect resource IDs in configuration.
3. Use the settings saved by resource-group discovery, or prepare
   `.tools\policy-deployment.json` using the example above. Do not copy
   `data\policy-demo\policy-agent-framework.json` into the runtime location:
   it records the original demo resources, not this machine's verified setup.
   An earlier demo restore can have placed that configuration there already;
   preserve it and use deployment settings to override its resource and model
   targets rather than deleting files or hand-authoring hashes.
4. For existing approved services, preview the Standard workflow from
   the repository root:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\infra\deploy.ps1
   ```

   This is a read-only preparation check, not a complete model/Search
   connectivity test. Review the resolved targets and any errors. Preview checks
   the claim analyzer as well; the default analyzer can be created on apply.
5. After reviewing the targets and approving Azure usage, apply:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\infra\deploy.ps1 -Apply
   ```

   Standard uses generation-scoped names. The old `-IndexName` and `-SourceIndex`
   options require `-UseLayout` and never apply to Standard ingestion.
   Without `-ResourceGroup`, these commands reuse configured services instead
   of deploying the ARM template. Apply can incur CU and Search charges.
6. Require `"status": "verified"` and `"runtimeActivated": true`.
   Successful deployment activates `.tools\policy-agent-framework.json` with no
   second preparation command. The existing claim analyzer is never overwritten;
   a different definition requires choosing a separate ID.
   A preview is not successful activation.
7. After activation, restart the app and reload the browser. Under the intended attendee identity,
   load the CU results and explicitly confirm a live **FoundryIQ** review.
   Verify that uncached checks complete with policy citations; then send a
   follow-up question to verify chat. These operations invoke Azure services
   and incur charges. Cached reviews alone do not verify model invocation or
   current Azure permissions.

### Troubleshoot live policy setup

Stop the app before changing local configuration, then restart it and reload
the browser. Preserve the exact error, failing service and correlation ID
when asking the lab administrator for help. Do not share tokens, account keys,
or credential-bearing package configuration.

| Symptom | What to check or fix |
|---|---|
| Dependency setup fails or Python imports are missing | Have the lab owner restore the lockfile and pinned Python requirements from approved sources. The launcher normally selects `.tools\policy-venv\Scripts\python.exe`; check any custom `POLICY_PYTHON` override. Do not install individual packages or change registries as a workaround. |
| Policy setup is required, or configuration is invalid | Rerun `deploy.ps1 -Apply` using saved settings or pass the lab resource group to discover them. Successful deployment now activates the app automatically; then restart it and reload the browser. A corpus/hash mismatch needs setup against current policy sources, not manually edited hashes. Check any custom `POLICY_FRAMEWORK_CONFIG` override as well. |
| The index or endpoint belongs to the original demo | `policy-demo-cache.ps1` can restore the demo's public runtime configuration. Discover the actual resources and activate the workbench with `deploy.ps1 -ResourceGroup YOUR-LAB-RESOURCE-GROUP -Apply`. Do not delete a conflicting local configuration or cache. |
| ARM fails with `Microsoft.Authorization/roleAssignments/write` | Resource-group discovery does not assign roles. Use `-ResourceGroup` without `-DeployResources` for a provisioned lab. Only an authorized provisioning identity should run full ARM deployment. Discovery still requires the separate data-plane permissions for index preparation. |
| Azure CLI authentication fails, or the tenant/account is wrong | Run `az login` for the approved lab account and confirm `az account show`. Studio/browser login is separate. Resource IDs still determine deployment targets, regardless of the default CLI subscription. |
| Search returns 403 | Have the administrator check data-plane query permissions for the app's signed-in identity, typically **Search Index Data Reader**. Direct Layout provisioning also needs index management and upload permissions, typically **Search Service Contributor** and **Search Index Data Contributor**. Resource-management access alone does not grant document query access. |
| Search returns 404 or evidence does not match the corpus | Confirm the configured Search endpoint and index name. Re-run verified setup for the intended corpus; do not point at an arbitrary existing index or relabel Layout content as Standard. |
| CU or the model returns 403/404 | Confirm the configured Foundry resource, ready claim analyzer, existing model deployment name, and the identity's service-specific invoke permissions. An app launch with `-Endpoint` changes CU routing, not the policy agent's Search/model configuration. |
| A service is unreachable or times out | Ask the administrator to check lab network access, service firewall/private endpoint settings, and service availability. Do not weaken network rules or bypass TLS. |
| Bundled reviews load but chat is unavailable | This is expected for the read-only historical demo. Complete live setup and obtain a live-compatible review before using follow-up chat. |

The app's configured status validates local configuration and corpus files; it
does not probe Search or the model. Standard setup checks required roles and a
successful apply verifies indexer completion and retrieval. A live uncached review is still needed to
exercise the model under the app identity. Use the actual service error to
identify missing access rather than treating a cached result as a connection test.

Missing **Storage Blob Data Reader** on Storage or **Cognitive Services User**
on Foundry for the Search identity are administrator prerequisites, not attendee
setup tasks. Rerun preflight in the configured environment for current status;
until apply succeeds, retain any working index and label it accurately.

## Understand Standard extraction

Standard isn't a separate document understanding product: it combines CU layout
extraction with figure understanding in a search-oriented ingestion pipeline.
The pipeline uses the Search-managed
[Content Understanding skill](https://learn.microsoft.com/azure/search/cognitive-search-skill-content-understanding)
for OCR, structured Markdown, tables and model-generated figure descriptions.
The notebook exposes the actual skill, model and API settings.

`contentExtractionMode: standard` is a knowledge-source setting, not an index
property. This ordinary-index workflow configures the corresponding CU
extraction capabilities explicitly through its skillset. Semantic chunking and
figure descriptions require the documented preview API and a supported model;
layout-only OCR doesn't include the figure understanding and search-oriented
processing provided by this pipeline.

The Arizona figure, Texas table with blanks and scanned Washington SOP are
verification cases. Model-generated descriptions can still be wrong or
incomplete. Review missing or ambiguous evidence rather than reconstructing
policy rules from general knowledge.

## Add or update policies

1. Add the policy PDF to the corpus folder.
2. Register its document ID, version, applicable states, rule IDs and SHA-256
   in the manifest. Update the citation map using the actual printed sections
   and page numbers. Don't register answer guides or duplicate DOCX/control files.
3. Run setup's read-only preflight, then `--apply`. Source changes create a
   separate generation automatically. Use `--apply --refresh` only to
   reprocess the same generation explicitly.
4. Confirm that ingestion and source checks succeed before using the new index.
5. Run policy checks again; previous review results aren't evidence for the
   updated source generation.

There is no fixed document-count requirement. Changed PDF bytes require fresh
ingestion and invalidate the corresponding extraction caches. Scope or version
conflicts are errors, not permission to mix policy generations.

### Extend an existing CU Layout index

The bundled historical demo used a directly populated CU Layout index.
New setup defaults to Search-managed Standard ingestion; the following is an
explicit legacy option for maintaining a Layout generation.
Search-managed Standard ingestion builds on CU layout extraction with figure
understanding optimized for search; the current Layout-only path doesn't add
those figure descriptions. The declarations, rental terms/diagram,
and issued amendment are registered alongside the existing SOPs. They apply
only when both the CU policy ID and insured VIN match their `policyScope`.
Missing or contradictory identifiers exclude these contract documents, not
the state SOP or shared standard.

Use the existing signed-in Azure CLI identity, model deployment and claim
analyzer. First run the read-only check:

```powershell
.\infra\deploy.ps1 -UseLayout -SourceIndex YOUR-VERIFIED-LAYOUT-INDEX -IndexName YOUR-NEW-LAYOUT-INDEX
```

Repeat with `-Apply` to extract new PDFs and activate a separate verified
Layout generation on the same Search service. This can incur CU and Search
charges. The script reuses the existing hash-verified SOP chunks, checks every
registered source page, uploads and reads back the new chunks, and updates the
machine-local configuration only after verification. It never changes or
deletes the source index. New extracted content is labeled CU Layout, not
Standard; diagram text remains OCR evidence, not a guaranteed interpretation.

For Texas and Washington, the matching rental-terms PDF explicitly makes Figure
R-1 controlling for eligibility timing; the prompt applies this only to the
exact policy and VIN. Other state diagrams remain illustrative. Limits, charges
and other written terms remain governed by their own clauses.

The Layout extraction cache under `.tools/policy-layout-cache/` is keyed by
source bytes, endpoint, API version and analyzer. A changed PDF cannot reuse an
old extraction. Don't index the local scenario HTML or its expected answers.
The SOP generator preserves separately registered `policy_contract` documents
and their citation maps when regenerating its state/shared sources.

For claim-extractor authoring, `claim_evidence_analyzer_definition()` in
`infra/setup-policy-index.py` defines a flat, literal fact schema for this
review. It retains verbatim drivability and authorization evidence as strings
instead of generating false defaults from missing booleans. The runtime accepts
both this flat schema and the existing nested schema for routing, policy ID and
insured VIN; contradictory identifiers exclude policy-specific retrieval.
Use an isolated analyzer version when changing extraction descriptions, then
pass its existing ID to Layout setup only after checking the returned fields
against the packet. The setup scripts read analyzer definitions and hashes;
they do not overwrite shared analyzers.

See [Policy checks in the workbench](policy-checks.md) for the customer workflow.
