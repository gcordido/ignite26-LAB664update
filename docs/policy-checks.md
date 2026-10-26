# Policy checks in the workbench

Compare what an agent can establish from claim facts alone with what it can
establish after retrieving the applicable policy rules. This is a synthetic
processing demo, not a coverage decision or permission to pay a claim.

The workflow has three parts:

1. **Claim facts:** Content Understanding extracts structured facts from a packet.
2. **Policy rules:** Azure AI Search holds searchable chunks of the synthetic
   SOP PDFs and policy-scoped contractual PDFs. The active configuration
   identifies the index and extraction mode.
3. **Review:** A Python Microsoft Agent Framework agent evaluates five checks
   and answers follow-up questions using the selected retrieval mode.

Use the [setup guide](policy-setup.md) and
[setup notebook](../infra/policy-agent-framework-setup.ipynb) to prepare
the policy index on your existing Search service.

## Compare packets 01 and 02

The top-level pivots are **Parse and extract**, **Check consistency**, and
**Check policies**. Cache/analyzer controls appear only in **Parse and extract**;
the loaded results remain shared across all three pivots. Classification and
document-type views live under **Parse and extract**; policy retrieval controls
appear only under **Check policies**. Switching pivots preserves the loaded run
and reuses the same table, document viewer and debugger. Returning to **Parse
and extract** restores the previously selected document type.

The workbench now enables **Run policy checks** only when **Azure Search
retrieval** is selected. **No policy retrieval** remains available to inspect
previously saved baseline results, but a new baseline run can't be started from
the app.

Start here on a prepared lab machine. You don't need to inspect or redeploy
Azure resources before trying the agent.

1. In the workbench's **Cache Results**, load the included completed **10/10**
   run. Select **Check policies**.
2. In **Policy retrieval**, select **Azure Search retrieval**. Select **Run policy
   checks** and confirm. This runs the Agent Framework agent against saved CU
   claim facts, not just a local rules engine. Azure charges apply, including
   any missing claim-summary extraction; the confirmation covers all loaded
   cases, not only the selected row.
3. Wait for the batch to finish. The status line shows the active case and
   whether CU is extracting claim fields or the agent is checking policy rules.
   Open a check's **Result** tab for an activity indicator, elapsed stage time
   and the age of the last successful workbench response. This confirms the
   progress connection, not individual Search/model-call completion. If updates
   stop, reconnect rather than starting another batch.
4. Optionally select **No policy retrieval** to inspect a previously saved
   baseline. Without an SOP, the agent must not invent a rate threshold.
   Return to **Azure Search retrieval** to inspect this run. Changing the
   dropdown doesn't submit another batch.
5. Compare **Amount** for packets **01** and **02**, using the expected
   evidence below. Select each check to inspect **Expected**, **Actual** and
   **Reasoning** in the expandable row below that customer. The PDF viewer remains available alongside it.
6. For packet **01**, select the Texas **Source** link. In the **Document** tab,
   inspect rule **TX-R2** on page 2 and **Schedule A** on page 3 of
   `tx-rental-review-sop-v2.pdf`. The inline review stays open; select **Back to claim document** to restore the packet preview.

| Case | Extracted daily base | Contractual daily cap | Retrieved routine authority | Expected amount result |
|---|---:|---:|---:|---|
| Packet 01 / Texas | $54 | $85 | $75, inclusive | **Satisfied**: numerical fit, conditional on timing |
| Packet 02 / Washington | $61 | $85 | $60, inclusive | **Review required**: above routine authority; supervisor exception evidence is missing |

These are source-based expectations, not hardcoded agent answers. If returned
facts, routing or citations differ, inspect the evidence and errors rather than
forcing a pass. Neither daily-rate result approves the entire claim or payment;
other checks can still require review. For example, the refreshed packet 01 CU
summary can omit the contractual daily cap. Even though $54 is below Texas's
$75 routine authority, the agent must return **Review required** until the
claim's contractual cap is established; the SOP can't supply that missing fact.
The matching revised declarations and effective amendment can establish the
contractual limit when the policy ID and insured VIN are verified. They cannot
establish that repairs actually began or ended.

In the source viewer, compare **CU Search** and **Digital parse** with the PDF.
Texas's page 3 table deliberately contains blank cells: a blank rate or duration
doesn't grant extra authority. Washington's SOP is entirely scanned, so Digital
parse may have no readable text. Arizona adds an image-based eligibility
flowchart. These examples show why understanding tables, scans and figures
matters to retrieval. A missing representation has an explicit, billable
generation action; switching tabs alone doesn't run CU.

Optionally, select **Ask agent** in the expanded review. Ask: "Explain this case's
daily-rate result. Cite the applicable rule and separate the contractual cap
from routine handling authority." Each chat turn
uses the selected case and retrieval mode; it isn't a new batch comparison.

## Optional: look under the hood

The lab demonstrates search-backed policy grounding, a pattern related to
Foundry IQ. **This implementation queries an ordinary Azure AI Search index
directly; it doesn't create or invoke a Foundry IQ knowledge base or knowledge
source.** Claim extraction, policy ingestion and agent reasoning are separate
steps.

### Inspect the deployed Search index

1. Note the active index name shown below **Policy retrieval**, or read
   `.tools\policy-agent-framework.json` locally. Its `searchEndpoint`,
   `indexName` and `extractionMode` are the source of truth; don't assume a name
   copied from another machine.
2. In the [Azure portal](https://portal.azure.com/), open the Search resource
   matching that endpoint. In the current shared environment it is
   **mmi-sample-ai-search**, in resource group **mmi-sample-vendors**,
   subscription **609bbde3-d152-4d7d-a12b-005e38ac4f27**.
3. Open **Indexes**, select the exact active index and open **Search explorer**.
   Search for `rental daily rate`. Inspect the returned content and source
   identity: `file`, `documentId`, `version` and page information. The current
   Layout index also includes `stateCodes` and `section`; managed index chunks
   use page ranges. The agent restricts retrieval to the loss state and verified
   corpus generation rather than searching every policy indiscriminately.

At the time this walkthrough was updated, the shared environment used
`lab664-rental-v2-agent-framework-3428a1feb437`, labeled **CU Layout**.
Don't describe it as Standard extraction. The
[managed CU ingestion setup](policy-setup.md) activates a replacement only
after ingestion and source verification succeed.

### Inspect the policy files and Blob Storage

Open the [v2 policy folder](../data/policies/rental/ocr-comparison-v2/) and its
[manifest](../data/policies/rental/ocr-comparison-v2/manifest.json). The PDFs are
the knowledge sources; the manifest carries state, version and hash metadata.
The expected-answer fixtures aren't indexed. Start with the
[Texas SOP](../data/policies/rental/ocr-comparison-v2/tx-rental-review-sop-v2.pdf),
[Washington SOP](../data/policies/rental/ocr-comparison-v2/wa-rental-review-sop-v2.pdf)
and [shared evidence standard](../data/policies/rental/ocr-comparison-v2/shared-rental-evidence-standard-v2.pdf).

For a **successfully applied managed ingestion pipeline**, open the matching
Search **Data source**, note its actual container, then inspect that container
under **Storage browser** in the configured storage account. The setup script
targets **mmiusw3bbstore**, resource group **mmi-usw3-eft**, subscription
**3b393ccb-47e3-4dea-9004-0c1085b5aba6**. Expect the manifest-listed PDFs,
including the Texas, Washington and shared SOPs. Inspect the corresponding
**Indexer** and **Skillset** to follow Blob PDFs through the CU skill to chunks.

The existing Layout index doesn't prove that this Blob/indexer pipeline has
been deployed. If only Layout is active or no matching data source exists, use
the repository PDFs for this optional inspection. Ask the lab owner about the
reported ingestion prerequisites; don't assign roles or create resources during
the attendee walkthrough.

### Inspect the agent

Open [`infra/policy-framework-agent.py`](../infra/policy-framework-agent.py).
Find `Agent`, `OpenAIChatClient` and `search_policy_rules`. The Search tool is
attached only in retrieval mode; both modes use the same claim fields and
review question. The
[workbench policy service](../src/workbench/src/policy-service.ts) starts this
Python agent and validates results and citations. This isn't an npm Agent
Framework implementation or a hosted Foundry agent.

## Run policy checks

1. Launch the workbench with `.\infra\launch-workbench.ps1`.
2. Load saved CU results, or explicitly run your connected analyzer.
3. In **Check policies**, select **Azure Search retrieval**.
4. Select **Run policy checks** and confirm the Azure operation.
5. Select a check in the grid to expand its review directly below the customer.

### Load saved policy results

Both **Parse and extract** and **Check policies** have a single selector with
**Run live** and **Load cached results** beside it. There is no cache dropdown
or Refresh button. The extraction button loads the saved CU run (preferring a
completed run); its tooltip identifies the analyzer and saved time.

After loading CU results, select the retrieval mode in **Check policies**, then
select **Load cached results**. The button loads the compatible saved checks for
that mode and loaded CU run. Availability updates when entering **Check
policies**, changing retrieval mode, or completing a policy batch.
Listing or loading saved policy results makes no Azure calls.

The saved checks must match the loaded CU run, exact claim input, review
question, runtime and active policy configuration, including the corpus/index
generation and claim analyzer. Results from another run or an older
configuration are not offered as current results. Source citations are verified
again when loading. A partially completed set loads only saved completed cases;
remaining cases stay **Not run**. Live runs still save successful cases
automatically. Loading is disabled while this session is processing a batch.
6. Optionally switch to **No policy retrieval** to inspect saved baseline
   results. The app doesn't start new runs in this mode.

Both modes use the same model, field-only claim Markdown and
[review question](rental-review-agent-question-v2.md). Selecting a mode, case,
tab or source link doesn't submit an agent request or start ingestion.

| Mode | What the agent receives |
|---|---|
| No policy retrieval | Claim facts only. Internal SOP thresholds aren't available; all five checks require review, with no invented citations. |
| Azure Search retrieval | The same claim facts, plus a tool that retrieves the applicable state SOP, shared evidence standard and matching policy/vehicle contract evidence. |

The application fixes the loss state, policy ID, insured VIN and source
generation in the Search filter. Policy-specific documents require both
identifiers to match; state/shared SOPs remain available without them.
The model chooses keywords, not a different state's rules. Missing
routing or evidence remains explicit; a similar state's SOP isn't substituted.

Claim preparation runs only when explicitly requested by a policy batch and
reuses matching saved extraction. The Studio classifier/router isn't changed,
and missing claim facts aren't filled in from policy rules or local answer guides.

### Follow batch progress

Both retrieval modes need prepared claim fields. With newly refreshed packets,
the first run can show **Extracting claim fields with CU**, even in **No policy
retrieval** mode. The ten cases run sequentially; the status line shows completed
cases, the active case, its extraction/review phase and total elapsed time.
No retrieval means no SOP lookup, not no Azure calls.

Refreshing the same browser tab reconnects to its private session, reloads its
selected CU run and resumes policy progress without submitting another batch.
Keep that tab open; a different private session can't take over its job.
The app disables another run while a batch is active. Repeated start requests
for the same session, run and mode return the existing job rather than charging
for a duplicate.

If a progress request fails, reload the same tab to reconnect. Restarting the
server clears in-memory jobs and private chat; it doesn't automatically rerun
them or cancel CU work already submitted to Azure. Completed extraction caches
remain available for the next explicitly confirmed run.

## Read the five checks

The checks appear in this order:

| Check | Question |
|---|---|
| Amount | How much of the bill fits the effective policy's numerical limits, conditional on an eligible period? |
| Timing | When can rental begin/end, and do actual repair evidence and remaining days support the billed interval? |
| Effective terms | Does the original limit or an effective carrier-issued amendment govern this vehicle and loss? |
| Charges and reimbursement calculation | Does the invoice reconcile, with supported taxes/fees, exclusions and credits counted once? |
| Authorization and payment readiness | Are the required insurer authority and payment documents established? |

For Packet #1, inspect the revised declarations, rental terms/diagram and
scanned amendment in the source viewer. The Honda row's blank optional-code
cell must not shift the $500 collision deductible, $85 daily rental limit, or
30-day maximum. The separate Toyota row does not establish the Honda's
coverage. R.4 states no separate rental deductible and mandatory taxes
additional. A numerical fit is not proof of an eligible repair period.

Effective terms requires the issued amendment and its effective time, not
just a customer signature. Timing requires actual repair dates; a scheduled
appointment or rental return is insufficient. Missing drivability remains
unknown, with both branches explained rather than guessed.

For a bounded owner evaluation, `POST /api/policy/batch` accepts
`{"mode":"search","live":true,"packetIds":["packet-01"]}` in the current
private workbench session after loading CU results. The normal UI confirmation
still runs all loaded cases; selecting a row alone does not restrict a batch.
Without `packetIds`, the existing all-loaded-cases behavior is unchanged.
Each shows a status, bold **Expected** and **Actual** values, italic
**Reasoning**, and verified **Source** links.

| Status | Meaning |
|---|---|
| Satisfied | Retrieved evidence supports this processing check. It isn't payment approval. |
| Not applicable | The rule and claim evidence establish that the check doesn't apply. It isn't a passed rental claim. |
| Review required | Evidence is missing, ambiguous, inconsistent or outside routine authority. It isn't a denial. |
| Run error | Extraction, retrieval, execution or validation failed. No business outcome is assumed. |

Keep contractual benefit limits separate from the SOP's internal handling
authority. For example, a rate below the policy cap can still exceed a routine
SOP threshold and require exception approval.

## Ask follow-up questions

The inline panel opens in **Result**. Select **Ask agent** to ask about the same case and
retrieval mode without replacing or changing its saved checks.

Chat uses the locally served, MIT-licensed [Deep Chat](https://deepchat.dev/)
component. It starts with the exact review prompt, field-only claim Markdown
and saved response. Expand **Exact original prompt and claim fields** to
inspect the input.

Each explicit question runs the same Python agent. Search-backed questions
retrieve fresh evidence; no-retrieval questions must disclose that SOP evidence
is unavailable. Questions don't change claim facts or authorize payment.

Chat history stays in server memory, isolated by private session, CU run, case,
mode and result/configuration identity. It isn't written into shared review
caches. It expires on server restart or private-session expiry. Each context
allows 20 follow-ups, with at most 30 contexts per private session.

Azure usage may be billed. Failed submissions aren't committed as successful
turns or automatically retried. The model receives `store: false`; no separate
hosted agent or hosted conversation is created.

## Open cited documents

Sources open the verified PDF in the right-hand viewer at the cited page without
closing the inline result or chat. **Back to claim document** restores the packet PDF.
The citation must match the source filename, document ID, version, rule,
section and unchanged PDF hash. Search-backed citations must also come from
evidence retrieved during that turn.

Managed chunks can span pages. The application uses their real page ranges
and the source citation map; it doesn't assume one chunk equals one page.

Three tabs display representations of the same PDF:

| Tab | What it shows |
|---|---|
| Document | The source PDF, initially at the cited page |
| CU Search | Cached Markdown from `prebuilt-documentSearch`, with document, table and figure understanding |
| Digital parse | Cached Markdown from `prebuilt-digitalParse`, using embedded digital content |

**These extraction tabs aren't the Search-managed Standard output.** Layout
isn't semantic figure interpretation. Digital parse isn't a complete substitute
for a Search Minimal ingestion pipeline. A scanned PDF can have no readable
digital text; that result is shown honestly.

The Markdown views show the whole document. **Raw extraction Markdown** exposes
the returned text. Rendering preserves table spans and empty cells, sanitizes
HTML and doesn't load remote images.

CU Search has its own analyzer-keyed cache. Existing `prebuilt-layout` output is
not relabeled or reused as documentSearch output; generate it again with
`prebuilt-documentSearch`. Changing this viewer does not rebuild or change the
active Azure Search index or its extraction-mode label.

Switching tabs reads the cache. Missing output has an explicit
**Generate with CU (Azure charges)** action. To generate both representations
for all registered policy PDFs:

```powershell
Set-Location .\src\workbench
node --import tsx .\src\policy-documents.ts --warm
```

## Configuration and saved results

The single configuration is `.tools/policy-agent-framework.json`, or the path
in `POLICY_FRAMEWORK_CONFIG`. Set `POLICY_PYTHON` if the workbench needs a
specific Python executable. Azure CLI sign-in supplies server-side credentials;
tokens and keys don't go to the browser.

Review caches include the exact claim input, question, selected mode, model,
runtime bytes, configuration and index generation. Changed inputs invalidate
reuse. Failed results aren't reused as successful checks. Claim and document
extraction caches remain separate from review and private-chat state.

An already configured Layout index can remain active while managed-ingestion
prerequisites are resolved. The workbench labels it **CU Layout**, not Standard;
setup activates the new managed index only after verification succeeds.

Expired sessions renew for safe reads and restore the saved CU run. Billed
operations aren't silently replayed. Missing configuration disables review
with an actionable message; ordinary saved claim views remain available.

This local demo isn't a multi-user authentication boundary. Use synthetic
packets, protect cached claim data and restrict access to the workbench host.
