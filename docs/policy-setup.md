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
- An existing model deployment and CU claim analyzer, or explicit opt-in to
  create the lab's claim extractor on a fresh environment.
  Supply resource IDs and model/analyzer names through the deployment settings below.
  Setup reads the analyzer definition and computes its hash; you don't enter
  hashes or create a runtime configuration manually.
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
It supports existing services or ARM deployment followed by verified CU Layout
ingestion. Layout remains the extraction mode; this path doesn't enable
Search-managed Standard ingestion. The Standard workflow below remains an
explicit alternative with its own prerequisites.

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
names. Resource targets are never hardcoded in the scripts. Provision
`.tools\policy-deployment.json` on each lab machine using its actual ARM
resource IDs and existing model deployment:

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
Settings resolve in this order: previously verified runtime configuration,
deployment settings file, then explicit command-line overrides. Successful
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
.\.tools\policy-venv\Scripts\python.exe .\infra\setup-policy-index.py
```

```powershell
.\.tools\policy-venv\Scripts\python.exe .\infra\setup-policy-index.py --apply
```

For a fresh lab without a claim extractor, first preview and then explicitly
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
waits for ingestion, verifies indexed sources and retrieval, and then activates
the verified index in the workbench configuration. Conflicting resources and
ingestion errors are reported rather than overwritten or treated as success.

If permissions or required service features are missing, the current working
index and configuration remain active. Resolve the reported prerequisites,
then rerun setup. Existing Azure agents, knowledge bases and other indexes
aren't deleted.

On a fresh clone, `.tools\policy-agent-framework.json` is absent because it is
machine-local and git-ignored. After dependencies are provisioned, launch the app
and load the included CU run, then select **Check policies** > **Load cached
results**. The app reads all ten synthetic reviews and their claim fields directly
from `data\policy-demo` when compatible local reviews aren't available. No restore,
Azure configuration, credentials or Azure calls are involved. The **Bundled demo**
label preserves the original index provenance. Existing configuration and caches
aren't overwritten, and live-compatible cached results take precedence.
Bundled results are read-only; follow-up chat isn't available.

The optional `.\infra\policy-demo-cache.ps1` command still restores a local copy
for cache-maintenance workflows. It refuses to overwrite different existing
configuration or cache files. It isn't required to view the bundled results.

Live reviews still require access to the configured resources. For a different
lab resource or index, the lab owner must prepare a verified configuration with
the setup workflow before attendees arrive. Installing packages alone doesn't
provision Azure resources. After intentionally refreshing all ten reviews,
export a new bundle with `.\infra\policy-demo-cache.ps1 -Action export -RunId RUN-ID`.
Export rejects missing or earlier-prompt results and includes only the selected
run's claim fields, review files and public configuration, not logs or credentials.

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

This evidence demo currently uses a directly populated CU Layout index.
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
.\infra\deploy.ps1 -SourceIndex YOUR-VERIFIED-LAYOUT-INDEX -IndexName YOUR-NEW-LAYOUT-INDEX
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
