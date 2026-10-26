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
- An existing model deployment and CU claim analyzer. For a fresh clone,
  supply their names in the notebook's `SEED` cell or the script flags below.
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

For a lab machine, first run `.\infra\setup.ps1`. This restores Deep Chat and
the other npm packages and installs the Python agent requirements into
`.tools\policy-venv`. Agent Framework is a Python dependency, not an npm package.
The launcher automatically uses this environment. Stop the app and rerun setup
after pulling dependency updates.

Open the [Python setup notebook](../infra/policy-agent-framework-setup.ipynb)
for a step-by-step walkthrough. The notebook calls the same Python functions
as the automatic script.

From the repository root:

```powershell
.\.tools\policy-venv\Scripts\python.exe .\infra\setup-policy-index.py
```

An existing workbench configuration supplies the current model and analyzer
names. Without it, use explicit existing-resource settings:

```powershell
.\.tools\policy-venv\Scripts\python.exe .\infra\setup-policy-index.py --model-deployment gpt-5 --claim-analyzer-id lab664_policy_checks_claim_summary
```

These names match this lab environment; substitute the names in your
environment. Use `--cu-model-name` when the model name differs from its
deployment name. Repeat these flags with `--apply` on a fresh clone.

The default operation validates inputs and checks prerequisites without
creating or changing Azure resources. Inspect its report before applying.

```powershell
.\.tools\policy-venv\Scripts\python.exe .\infra\setup-policy-index.py --apply
```

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
machine-local and git-ignored. Installing packages alone won't enable **Run
policy checks**. The lab owner must prepare a verified index and configuration
before attendees arrive. An existing Layout configuration on another machine
isn't automatically available on a newly deployed lab VM.

For the shared environment, the last preflight reported that the Search managed
identity lacked **Storage Blob Data Reader** on the policy storage account and
**Cognitive Services User** on the Foundry resource. These are administrator
prerequisites, not attendee setup tasks. Rerun preflight for current status;
until apply succeeds, retain the working Layout index and label it accurately.

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
python .\infra\setup-policy-layout.py --source-index lab664-rental-v2-agent-framework-3428a1feb437 --model-deployment gpt-5 --claim-analyzer-id lab664_policy_checks_claim_summary
```

Repeat with `--apply` to extract new PDFs and activate a separate verified
Layout generation on the same Search service. This can incur CU and Search
charges. The script reuses the existing hash-verified SOP chunks, checks every
registered source page, uploads and reads back the new chunks, and updates the
machine-local configuration only after verification. It never changes or
deletes the source index. New extracted content is labeled CU Layout, not
Standard; diagram text remains OCR evidence, not a guaranteed interpretation.

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
