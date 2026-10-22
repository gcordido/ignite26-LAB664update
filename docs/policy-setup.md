# Set up the policy index

Use one managed ingestion pipeline on the existing Azure AI Search service.
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

Open the [Python setup notebook](../infra/policy-agent-framework-setup.ipynb)
for a step-by-step walkthrough. The notebook calls the same Python functions
as the automatic script.

From the repository root:

```powershell
python -m pip install --pre -r .\infra\requirements-policy-agent-framework.txt
python .\infra\setup-policy-index.py
```

An existing workbench configuration supplies the current model and analyzer
names. Without it, use explicit existing-resource settings:

```powershell
python .\infra\setup-policy-index.py --model-deployment gpt-5 --claim-analyzer-id lab664_policy_checks_claim_summary
```

These names match this lab environment; substitute the names in your
environment. Use `--cu-model-name` when the model name differs from its
deployment name. Repeat these flags with `--apply` on a fresh clone.

The default operation validates inputs and checks prerequisites without
creating or changing Azure resources. Inspect its report before applying.

```powershell
python .\infra\setup-policy-index.py --apply
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

## Understand Standard extraction

The pipeline uses the Search-managed
[Content Understanding skill](https://learn.microsoft.com/azure/search/cognitive-search-skill-content-understanding)
for OCR, structured Markdown, tables and model-generated figure descriptions.
The notebook exposes the actual skill, model and API settings.

`contentExtractionMode: standard` is a knowledge-source setting, not an index
property. This ordinary-index workflow configures the corresponding CU
extraction capabilities explicitly through its skillset. Semantic chunking and
figure descriptions require the documented preview API and a supported model;
plain Layout output must not be relabeled as Standard.

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

See [Policy checks in the workbench](policy-checks.md) for the customer workflow.
