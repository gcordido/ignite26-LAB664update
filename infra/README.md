# Infrastructure

Use this folder for deployment or runtime infrastructure, including Skillable-specific files when needed.

## Preview lab images locally

[`lab-image-paths.py`](lab-image-paths.py) maps all 22 VM image references in
`instructions\lab.md` to the matching screenshots under `img`. It uses only
Python's standard library; no packages or setup are required.

From the repository root, switch to Markdown images for local editing:

```powershell
python .\infra\lab-image-paths.py local
```

Before committing, restore the original VM paths and `!IMAGE[...]` syntax:

```powershell
python .\infra\lab-image-paths.py vm
```

Local mode adds marked HTML `<br>` tags around each image so it appears below
the preceding text, including inside numbered lists and tip callouts. VM mode
removes those exact tags along with restoring the original image references.
Keep the generated image markup intact while editing the surrounding instructions.
Local previews must support inline HTML, as GitHub and VS Code previews do.

Only the mapped image markup changes. Other instruction edits, whitespace,
encoding and line endings are preserved. Repeating either command is safe.
Running `local` again also upgrades images converted by the earlier, paths-only
script. The guide is located relative to the script, so the script also works
from another directory. The filename mapping is recorded in `IMAGE_MAP` in the
script; images themselves are not modified.

## Workbench setup and launch

- [`setup.ps1`](setup.ps1) installs the existing workbench runtime requirements
  and restores its locked npm dependencies, including Deep Chat. It also creates
  `.tools\policy-venv` and installs the Python Agent Framework, OpenAI and Azure
  Search packages. Downloads and the Python environment stay in the ignored
  `.tools/` folder at the repository root.
- [`launch-workbench.ps1`](launch-workbench.ps1) starts the separate Insurance
  Workbench App. It does not create cloud resources or submit document analysis
  on launch.
- [`policy-demo-cache.ps1`](policy-demo-cache.ps1) optionally restores the included synthetic
  policy reviews and public resource configuration alongside the saved Parse run. It uses
  the existing workbench dependencies and makes no Azure calls. The app reads
  the bundled results directly without this command or Azure setup; use it only
  when a local cache copy is needed for maintenance. Different local configuration
  or cache files aren't overwritten.

Run these scripts from the repository root as described in
[step 7 of the attendee guide](../instructions/lab.md#step-7-evaluate-results-with-the-insurance-workbench-app).

Install Python 3.10 or later with pip and venv before running setup. Setup uses
the existing Python installation; it doesn't install Agent Framework with npm.
Core and provider packages have independent version numbers: this lab pins
`agent-framework-core==1.21.0` and `agent-framework-openai==1.16.0`.

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\setup.ps1
# Sign in only when running live Azure work, not to load saved results.
# az login
powershell -ExecutionPolicy Bypass -File .\infra\launch-workbench.ps1
```

The launcher selects the local Python environment automatically. For a
separately managed environment, set `POLICY_PYTHON` to its `python.exe`.
Viewing saved results needs the existing Node dependencies, not Python or Azure
credentials. The app automatically loads extraction results and compatible saved
policy reviews. No analyzer listing, document analysis or policy batch is
submitted during startup. Local compatible policy caches take precedence over
the included bundle; no configuration or cache files are overwritten.
With the prepared policy-agent connection, **Ask agent** can start from an
included review without first running a policy batch. It uses the saved claim,
check and original prompt, but sends follow-ups through the current lab's
configured model and Search index, not the bundle's original Azure resources.
Rerun setup after pulling updates to restore both npm and Python dependencies.
Stop the app first, and restart it afterward. No manual `npm install deep-chat`
or global Python package installation is required.

### Developer viewer settings

**Settings** shows the resolved cache root, extraction-results folder and the
folder supplying the loaded policy reviews. The developer-only **Reload saved
results** and **Reload policy reviews** buttons also live here, not in the main
review toolbars; neither requires enabling live calls. **Enable live calls** is
off on every page load. Turning it on reveals the analyzer selector, bulk **Run live**
buttons, policy retries and explicit policy-document generation. Only then does
the app request the live analyzer list. The individual repair **Rerun** and
**Ask agent** chat are independent of this developer option; their existing
explicit actions and Azure charges still apply.

The launcher automatically uses the repository's `data` folder. To select a
different saved-results bundle:

```powershell
.\infra\launch-workbench.ps1 -CacheFolder "D:\LabCache"
```

The selected directory must contain `results\<run-id>\manifest.json` and the
matching native CU JSON files, plus `policy-demo\manifest.json` and its complete
checksum-verified policy bundle. Copy these existing directories without
renaming run IDs or editing manifests. Source PDFs and `packets.json` still come
from the repository's `data` folder, and dataset compatibility checks remain
active. Missing, corrupt or incompatible selected caches fail visibly; the app
does not fall back to another folder. Policy results that belong to a different
run remain labeled stale and cannot seed chat.

For direct Node launches, `WORKBENCH_CACHE_FOLDER` selects the same cache root.
The PowerShell launcher always sets it from `-CacheFolder`, or from the automatic
repository default when the parameter is omitted. Live policy execution caches
remain in `.tools\policy-cache`; settings reports that actual folder if one of
those compatible reviews is loaded. These controls are for lab developers, not
part of the attendee instructions.

## Lab machines with package mirrors

Setup honors the machine's npm and pip settings. If a package version isn't
available, ask the lab administrator to sync the lockfile and requirements
versions to the approved mirrors. The npm lockfile preserves package versions
and integrity hashes without hardcoding a particular registry's download URLs.
Inspect `npm config get registry` and
`python -m pip config debug` locally; don't share output containing credentials.
If the administrator permits another source, pass it explicitly:

```powershell
.\infra\setup.ps1 `
  -PythonExecutable "C:\Path\To\Python\python.exe" `
  -NpmRegistry "https://YOUR-APPROVED-NPM-REGISTRY" `
  -PythonIndexUrl "https://YOUR-APPROVED-PYTHON-INDEX/simple"
```

These options don't change global registry settings, bypass TLS, or silently
fall back to public sources. Don't include credentials in command arguments.
An existing Node installation without npm triggers the portable Node setup.

## Prepare policy retrieval

Installing dependencies alone doesn't deploy or connect a policy index. A prepared
lab machine also needs `.tools\policy-agent-framework.json` for its verified
index, a reachable model deployment and Azure permissions. Follow
[live policy preparation and troubleshooting](../docs/policy-setup.md#prepare-live-policy-checks-on-a-lab-machine)
before the session. Do not use `policy-demo-cache.ps1` as live setup: it restores
the original demo's resource configuration, not verified access to your lab
resources. Setup does not grant roles. Managed indexing checks the Search
identity's Storage and Foundry access; it does not prove that the local app can
invoke its model. The
[policy walkthrough](../docs/policy-checks.md#compare-packets-01-and-02)
then starts with the app, not Azure provisioning.

### Deploy infrastructure and the policy index

Use [`deploy.ps1`](deploy.ps1) as the infrastructure entrypoint. With an existing
`.tools\policy-deployment.json`, preview Search-managed Standard ingestion first,
then apply it:

```powershell
.\infra\deploy.ps1
.\infra\deploy.ps1 -Apply
```

For a provisioned lab, supply only its existing resource group; no hand-filled
deployment settings file is required:

```powershell
.\infra\deploy.ps1 -ResourceGroup YOUR-EXISTING-RESOURCE-GROUP
.\infra\deploy.ps1 -ResourceGroup YOUR-EXISTING-RESOURCE-GROUP -Apply
```

These commands discover existing Search, Storage and Foundry (`AIServices`)
resources, and the ready `gpt-5.2` deployment used by the lab template.
They do **not** deploy ARM, create services/models, assign roles, or change
network rules. Python uploads policy PDFs to a scoped Blob container and creates
the datasource, index, skillset and indexer. Search runs the Content Understanding
skill, semantic chunking and AI figure descriptions, and projects chunks into
the index. Figure descriptions are enabled by `modelName` and `modelDeployment`
on the skill using the `2026-05-01-preview` API; `extractionOptions: ["images"]`
is not required to verbalize figures into searchable Markdown.
The preview displays targets and runs read-only checks without saving settings.
Apply waits for the Search indexer, verifies retrieval, saves a local chunk
snapshot and discovered settings, and reports the index name. It activates
`.tools\policy-agent-framework.json` after
verification, connecting the workbench without a second command.

Console progress includes timestamps for prerequisite checks, authentication,
each source upload/reuse, Search object creation/reuse, indexer polling, and each
state's retrieval check. Indexer polls normally occur every 15 seconds and show
processed/failed counts and elapsed time. HTTP operations show their target,
status and duration; a request can wait up to 120 seconds before returning.
Azure CLI token acquisition has a 30-second timeout. Tokens are cached in memory
per service scope and refreshed five minutes before expiry, rather than launching
Azure CLI for every request. Tokens, request payloads and URL query strings are
not logged. Progress goes to stderr; the final JSON report stays on stdout.
Ctrl+C reports interruption, not success; the remote indexer may continue running.

Discovery requires exactly one matching resource of each type and one matching
ready policy model. Ambiguity or missing resources stops with candidate details;
it never selects the first result or falls back to ARM. Select among existing
resources with `-SearchResourceId`, `-StorageResourceId`, `-FoundryResourceId`,
or `-ModelDeployment`. `-ClaimAnalyzerId` explicitly selects a legacy summary analyzer;
add `-CreateClaimAnalyzer` to explicitly create that ID if absent.
`-Subscription` scopes all Azure CLI discovery reads. Resource overrides must
belong to the supplied group. Required Azure permissions remain administrator
prerequisites. The caller needs Blob upload and Search management/query access;
the Search identity needs Storage Blob Data Reader and Cognitive Services User.

After initial discovery, rerun using the saved settings with:

```powershell
.\infra\deploy.ps1 -Apply
```

This reuses a completed matching indexer run and writes the workbench connection
again after verification. Ordinary deployment neither creates nor validates a
legacy claim-summary analyzer, even when saved settings contain its ID.
The three policy comparisons and follow-up chat use existing Parse fields and
native page text, not that analyzer. `-ClaimAnalyzerId` opts into validating an
existing legacy analyzer; `-CreateClaimAnalyzer` opts into creating it if absent.
Explicit creation uses the saved ID, the discovery default
`lab664_policy_checks_claim_summary`, or the ARM compatibility output as applicable.
Conflicting definitions are never overwritten.
On unchanged runtime targets, valid optional summary metadata from the active
configuration is retained locally to preserve live-review cache identity; it
does not trigger analyzer validation. Fresh or changed targets do not inherit it.
For deliberately indexing without activation, invoke the Python script directly
with `--index-only`; that advanced mode is not used by `deploy.ps1`.

Standard ingestion uses generation-scoped names so changed sources or model
settings cannot overwrite the previous working index. The earlier direct Layout
pipeline is retained only behind **`-UseLayout`**. For that legacy path,
supply `-IndexName YOUR-NEW-INDEX`. Optionally add
`-SourceIndex YOUR-VERIFIED-LAYOUT-INDEX` to reuse verified source chunks without
changing that source index. Without a source, setup extracts every registered
policy PDF with CU Layout. Explicit names are saved after verification so later
reruns use the same target. Choose a new target name when source content changes.
Matching existing chunks aren't uploaded again; conflicting definitions or
changed chunks stop deployment. The runtime configuration changes only after
all sources and indexed content pass verification.

To provision a new lab's Azure resources and then populate its policy index:

```powershell
.\infra\deploy.ps1 -ResourceGroup YOUR-EXISTING-RESOURCE-GROUP -DeployResources
.\infra\deploy.ps1 -ResourceGroup YOUR-EXISTING-RESOURCE-GROUP -DeployResources -Apply
```

The first command previews the ARM deployment only. The apply command deploys
[`Lab664-arm-template.json`](Lab664-arm-template.json), propagates its resource
IDs and model settings, runs Search-managed Standard ingestion, and activates
the app's configuration after verification without a claim-summary analyzer.
Use `-Subscription` and `-ParametersFile` for a specific
subscription and ARM parameters file. Resource groups must already exist.
This provisions the template's billable services and model deployments; use the
existing-resource path to reuse shared services without redeploying them.
For an existing prepared Python environment, pass `-PythonExecutable`.
No roles, network rules, or existing analyzers are changed by policy setup.

Use this explicit `-DeployResources` command when updating the lab's ARM deployment.
Reuse its original ARM parameters (including any custom `uniqueSuffix`) with
`-ParametersFile` on both preview and apply. Search ingestion and verified
workbench configuration follow ARM deployment automatically.
Require the final `"status": "verified"`
report, not just ARM success. Restart the app afterward. See the
[combined Azure and Search walkthrough](../docs/policy-setup.md#deploy-or-update-azure-and-search-together).

Lab provisioning can combine dependency restoration and index deployment with
`.\infra\setup.ps1 -DeployPolicyIndex` after Azure CLI sign-in and deployment
settings are prepared. The switch is opt-in: ordinary setup and app launch
still make no cloud changes. Standard ingestion uses Blob Storage and an ordinary
Search index, not a Foundry IQ knowledge base. CU extraction and live policy/model calls incur
Azure charges.

The **FoundryIQ** UI label is the lab's umbrella name; the three-comparison
review uses scoped evidence prefetched from Azure AI Search, not a Foundry IQ
knowledge base. Each uncached packet interprets rental applicability once, then
runs three parallel comparisons using saved Parse fields and relevant page text.
Policy review and chat do not submit another claim CU extraction.
Matched execution caches skip those calls. Follow-up chat can use the Search tool.

To refresh the synthetic demo bundle, complete all ten policy reviews using
the current prompts, then run:

```powershell
.\infra\policy-demo-cache.ps1 -Action export -RunId "YOUR-COMPLETED-CU-RUN-ID"
```

Export verifies all ten reviews against the current prompts, claim facts and
policy sources. It includes only those reviews and the
public runtime configuration under `data\policy-demo`, with hashes referencing
the committed Parse run in `data\results`; credentials and request
logs aren't exported. Review that synthetic bundle with the source changes.

`deploy.ps1 -ResourceGroup` discovers and saves `.tools\policy-deployment.json`
after successful apply. Alternatively, provision it with the machine's Search,
Storage and Foundry resource IDs plus its model/analyzer names. Both Python
policy deployment scripts use these settings instead of environment-specific source constants.
The deployment file does not enable policy checks by itself; only verified
activation writes the runtime configuration.
The launcher uses that verified configuration's CU endpoint when neither
`-Endpoint` nor `CU_ENDPOINT` is supplied.
It also writes CU request diagnostics to `.tools\logs\cu-requests.jsonl`;
`CU_DIAGNOSTICS_LOG` can select an existing writable directory's log file.
Logs contain request metadata and correlation IDs, not tokens or document
payloads. See [retry and diagnostic guidance](../docs/policy-checks.md).

## Regenerate the policy corpus

The optional [`generate-rental-sop-corpus.py`](generate-rental-sop-corpus.py)
script uses separate
[`requirements-rental-sop-corpus.txt`](requirements-rental-sop-corpus.txt)
dependencies and Windows Segoe UI fonts. Attendees don't need these packages
to use the existing PDFs. Follow the
[corpus regeneration guidance](../docs/rental-ocr-comparison.md#activation-boundaries)
when changing policy rules or expected outcomes.
