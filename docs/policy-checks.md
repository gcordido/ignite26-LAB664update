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

Reviews use the existing typed CU fields, including the prepared claim-summary
fields. The CU Python SDK's public `to_llm_input` helper formats them as YAML
frontmatter with `include_fields=True` and `include_markdown=False` (there is
no separate public `to_llm_frontmatter` helper). Each check receives only its
relevant field paths and document categories. Packet OCR, page images, bounding
boxes, confidence and duplicate prose are not sent. False and zero remain
values; fields without a value appear in explicit `missingFields` metadata.
Missing claim facts wait for data; conflicting facts require review. The agent
does not reread the PDF to repair extraction.
The full packet export remains available in Parse and extract for human inspection.
For explicit OCR diagnostics only, start the server with
`POLICY_INCLUDE_PACKET_TEXT=1`; leave it unset for normal reviews. This diagnostic
mode uses a single review call. Changing input mode invalidates matching review
caches.

For the initial five-check review, the application fetches all indexed chunks
within the registered state, policy, vehicle and corpus scope in one Search
request and verifies their source identities. It then runs **five concurrent
model requests per packet**, one for each check, without a Search tool-planning
loop. Each gets its own question, relevant CU fields and complete relevant
policy pages. The timing check retains the governing diagrams; the effective
terms check omits rental-timing clauses. All five share one model connection
pool and cached Azure CLI token provider. Citation validation is scoped to the
evidence supplied to each call. Results are combined in the original five-column
order; one failed call cancels its siblings rather than saving a partial review.
A scope exceeding 200 chunks is an explicit error, not truncated evidence.
Follow-up questions retain tool-based retrieval and only the selected check's
SDK-formatted claim context; their sources are verified afresh.

The `gpt-5` deployment defaults to low reasoning effort. Other deployment names
keep their model default unless explicitly configured. Set
`POLICY_REVIEW_STRATEGY=single` to compare with the single-call version, or
`POLICY_REASONING_EFFORT=minimal|low|medium|high` to choose an effort supported by
your deployment. Restart the server after changing these settings. Strategy,
reasoning effort, prompt and formatter changes invalidate matching review caches.
Five concurrent calls can reduce wall-clock time but repeat some shared context,
consume more request quota and encounter token-rate limits. They are not a
guaranteed speedup.

For a different model in follow-up chat only, set
`POLICY_CHAT_MODEL_DEPLOYMENT` to an existing deployment name on the same
Azure OpenAI resource. Optionally set
`POLICY_CHAT_REASONING_EFFORT=minimal|low|medium|high` to an effort that model
supports, then restart the server. These settings don't change the model used
for the five initial checks or invalidate their saved results. Chat shows its
deployment name and starts a separate context when model settings change.
For example, an existing `gpt-4.1-mini` deployment is a smaller-model candidate
for short follow-ups; don't set a reasoning effort for this non-reasoning model.
Benchmark answer quality and end-to-end latency before making it the default.

Global Standard can offer broader capacity, but doesn't guarantee a faster
individual response. Global deployments can process prompts outside the
resource's region; choose Data Zone when processing must stay within its zone.
See [deployment types](https://learn.microsoft.com/azure/foundry/foundry-models/concepts/deployment-types)
and [latency guidance](https://learn.microsoft.com/azure/foundry/openai/how-to/latency).

**Load cached results** restores both the saved CU extraction and completed
policy checks without calling Azure. Each successful packet review is saved
atomically as it completes, so completed packets survive a later failure or
interrupted batch. A separate saved-review snapshot survives prompt, runtime
and reasoning-setting changes; earlier-prompt results are labeled as such
instead of becoming "Not run." Claim facts, CU run/analyzer and policy
configuration must still match. Changed claim data, Search scope or corpus
does not reuse an incompatible snapshot. An explicit new review uses the
current prompt and updates the saved snapshot only after validation succeeds.

Local review-cache envelopes record per-check input/evidence character counts,
usage, model time, shared retrieval/authentication time and total time. Timings
exclude preceding CU extraction. They distinguish actual model latency from
Search/authentication overhead; compare live timings before claiming a speedup.

The **Rental car policy check** heading sits directly above the comparison table.
Its five columns are **Daily cost**, **Rental dates**, **Active policy**,
**Covered charges**, and **Payment approval**, with a short question under each.
These are readable labels for the same five agent checks, not new rules.
Select a result to replace the right-hand panel with a short agent-written finding and the decisive claim
fields compared with the policy rule values. Exact CU field names and policy
rule IDs remain visible; links open the supporting policy documents.
Missing information is shown explicitly rather than filled in.
Checks waiting only for claim information show **Waiting for info** in blue.
The detail panel explains that claim information or approval is missing and names the missing fact,
document or pending insurer approval. This is not a running agent: add the
information and rerun the policy checks. Conflicting facts, known rule
violations and missing or ambiguous policy evidence stay **Review required**.
The agent returns a distinct `InProgress` outcome with `ReviewRequired=false`;
the interface does not guess the status from finding text. Existing saved
reviews need a fresh evaluation to use this status.
In the comparison table, select a linked **Claim** value to open the original
packet at the CU source page, with the extracted field highlighted. Select a
linked **Policy** value to open the exact cited rule page. When multiple pages
support a field or rule, each page is offered separately. **Back to policy
check** restores the selected finding and focus. Missing fields or fields with
no CU source coordinates are explicitly unlinked; page locations are never
guessed from an agent-written label or value.
**Review details** and **Structured output and provenance** retain the fuller
explanation and original output. Earlier saved reviews remain readable but need
a new live run to receive the new headline and structured field comparisons;
the interface does not invent a summary or extract values from old prose.
The policy workflow does not automatically open claim packets. Its right panel
contains the selected check's **Result** and **Ask agent** views and identifies
the customer and packet. The left table stays in place without an expanded row.
Select a policy source to inspect it in the right panel, then **Back to policy
check** to return to the finding or chat. Parse and extract and Check consistency
retain their packet viewer and inline details.

### Non-rental claims

The five rental checks show **N/A**, not a review warning, when affirmative
extracted evidence confirms that no rental was requested or used and no rental
request, agreement, use or bill conflicts. Applicability is evaluated before
dates, limits, charges or payment approval: missing rental facts do not require
review for a confirmed non-rental claim. A pending rental request still applies
even if the rental has not been used yet.

The claim-summary schema extracts `RentalRequested`, `RentalUsed` and
`RequestTypeEvidence` from explicit answers or statements, including selected
Yes/No checkboxes. Blank boxes, no rental invoice, and repair/towing/glass
charges alone do not prove no rental. Incomplete or conflicting evidence stays
**Waiting for info** for missing claim evidence or **Review required** for conflicting
evidence. Existing saved extracts without these fields are not
silently reclassified; prepare updated claim extraction and rerun the policy
checks to use newly captured evidence. A labeled extracted checkbox answer can
establish no rental request even if CU leaves its boolean field unknown; an
unlabeled "No" cannot. Rental amounts are extracted only from rental records,
not unrelated repair, towing or glass bills.
An answer to a towing or other service question is not a rental request answer.
When rental applicability is unknown because claim data is missing, all five
checks show **Waiting for info**, including the policy-date check. Contradictory
applicability remains **Review required**; an otherwise valid policy term cannot
establish that a rental was requested.

Use the [setup guide](policy-setup.md) and
[setup notebook](../infra/policy-agent-framework-setup.ipynb) to prepare
the policy index on your existing Search service.

## Compare packets 01 and 02

The top-level pivots are **Parse and extract**, **Check consistency**, and
**Check policies**. Saved results load automatically and remain shared across
all three pivots. **Settings** contains the cache reload actions and the
default-off **Enable live calls** option. Classification and
document-type views live under **Parse and extract**; policy retrieval controls
appear only under **Check policies**. Switching pivots preserves the loaded run
and reuses the same table, document viewer and debugger. Returning to **Parse
and extract** restores the previously selected document type.

The workbench enables policy **Run live** only when **Enable live calls** is
selected in **Settings** and **FoundryIQ** is selected. **No policy retrieval** remains available to inspect
previously saved baseline results, but a new baseline run can't be started from
the app.

The dropdown loads from the policy configuration independently of the packet
classifier. A missing live classifier does not prevent using cached claim
results with the configured policy index. The choices are **No policy retrieval**
and **FoundryIQ**. FoundryIQ is the lab's umbrella label for grounded policy
retrieval; this implementation queries an ordinary Azure AI Search index directly,
not a Foundry IQ knowledge base. If the policy configuration cannot
be loaded, the dropdown shows an unavailable message and the status below it
explains why.

If a case shows **Run error**, open its **Result** and select **Retry this case**
under the error. The confirmation names that one case; it does not rerun other
customers. Wait for any active batch to finish first. Matching saved claim fields
and completed reviews are reused, while missing extraction or agent work can
incur Azure charges. Retrying evaluates all five checks for that case, not just
the selected check. Historical failures remain available after restarting the
workbench and are labeled with their previous attempt time.

The launcher writes CU request diagnostics to `.tools\logs\cu-requests.jsonl`.
Each request records its method, resource endpoint, path, API version, elapsed
time, client request ID and available Azure request/activity IDs. Policy claim
requests also identify the packet and job. Network failures record underlying
error codes; logs distinguish authentication, sending the request and receiving
an HTTP error. Tokens, request payloads and successful document responses are not
logged. These local diagnostics do not enable Azure resource diagnostic logging
or expose Microsoft's internal service trace. Use the activity/request IDs and
UTC timestamps when escalating a service error.

For live checks, complete [policy setup](policy-setup.md) and sign in with the
approved lab identity. For a first-run walkthrough without Azure setup or
charges, use [Load saved policy results](#load-saved-policy-results) instead.

1. In **Parse and extract**, select **Load cached results** to load the
   included completed **10/10** CU run. Select **Check policies**.
2. In **Policy retrieval**, select **FoundryIQ**. Select **Run live**
   and confirm. This runs the Agent Framework agent against saved CU
   claim facts, not just a local rules engine. Azure charges apply, including
   any missing claim-summary extraction; the confirmation covers all loaded
   cases, not only the selected row.
3. Wait for the batch to finish. While a run is active, a prominent status banner
   shows the packet being processed, its customer name when available, the
   number of finished packets, and a total elapsed timer updated every second.
   The banner distinguishes CU claim extraction from agent policy review and
   follows the active packet even when another customer is selected.
   Packets run sequentially; an uncached packet can require CU extraction
   before one Search prefetch and five parallel Agent Framework calls, one per
   check. Matching current reviews skip the model calls.
   Open a check's **Result** tab for an activity indicator, elapsed stage time
   and the age of the last successful workbench response. This confirms the
   progress connection, not individual Search/model-call completion. If updates
   stop, reconnect rather than starting another batch.
4. Optionally select **No policy retrieval** to inspect a previously saved
   baseline. Without an SOP, the agent must not invent a rate threshold.
   Return to **FoundryIQ** to inspect this run. Changing the
   dropdown doesn't submit another batch.
5. Compare **Daily cost** for packets **01** and **02**, using the expected
   evidence below. Select each check to inspect its headline, claim and policy
   values, and sources in the right panel.
   Open **Review details** for the fuller explanation.
   Claim PDFs remain available in Parse and extract.
6. For packet **01**, select the Texas **Source** link. In the **Document** tab,
   inspect rule **TX-R2** on page 2 and **Schedule A** on page 3 of
   `tx-rental-review-sop-v2.pdf`. Select **Back to policy check** to restore the finding.

| Case | Extracted daily base | Contractual daily cap | Retrieved routine authority | Included saved daily-cost result |
|---|---:|---:|---:|---|
| Packet 01 / Texas | $54 | $85 | $75, inclusive | **Satisfied**: $54/day and four billed days fit the contractual limits |
| Packet 02 / Washington | $61 | $85 | $60, inclusive | **Satisfied**: $61/day and five billed days fit the contractual limits; payment authority is a separate check |

In the refreshed saved reviews, both packets wait for actual repair dates and
insurer approval. Packet 02's **Covered charges** requires review because the
local rental levy needs supporting evidence. Its daily-cost result isn't a
failure merely because the rate exceeds the SOP's routine handling authority.

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
Find `Agent`, `OpenAIChatClient` and `search_policy_rules`. Initial reviews
prefetch Search evidence and pass each check only its relevant CU fields and
rules. Follow-up chat can use the Search tool. The
[workbench policy service](../src/workbench/src/policy-service.ts) starts this
Python agent and validates results and citations. This isn't an npm Agent
Framework implementation or a hosted Foundry agent.

## Run policy checks

1. Launch the workbench with `.\infra\launch-workbench.ps1`.
2. Load saved CU results, or explicitly run your connected analyzer.
3. In **Check policies**, select **FoundryIQ**.
4. Select **Run live** and confirm the Azure operation.
5. Select a check in the grid to inspect its review in the right panel.
6. Optionally switch to **No policy retrieval** to inspect saved baseline
   results. The app doesn't start new runs in this mode.

### Load saved policy results

Both **Parse and extract** and **Check policies** have a single selector with
**Run live** and **Load cached results** beside it. There is no cache dropdown
or Refresh button. The extraction button loads the saved CU run (preferring a
completed run); its tooltip identifies the analyzer and saved time.

Select the retrieval mode in **Check policies**, then
select **Load cached results**. The button loads the compatible saved checks for
that mode and loaded CU run. On first launch, **FoundryIQ** can load the included
CU run and policy results together; loading extraction results separately isn't
required. Availability updates when entering **Check
policies**, changing retrieval mode, or completing a policy batch.
Listing or loading saved policy results makes no Azure calls.

Exact execution caches match the CU run, claim input, prompt, runtime and policy
configuration. Persistent snapshots also allow earlier-prompt results when the
CU run, claim input and policy configuration still match; the app labels them
as historical. Local results from another run or configuration aren't substituted.
Source citations are verified
again when loading. A partially completed set loads only saved completed cases;
remaining cases stay **Not run**. Live runs still save successful cases
automatically. Loading is disabled while this session is processing a batch.

On first launch, select **Check policies** > **FoundryIQ** > **Load cached
results**. The app loads the included **10/10** CU run automatically.
Without compatible local reviews, the app
reads ten policy reviews and their claim fields directly from `data\policy-demo`.
No Azure configuration, credentials or manual restore command is required.
The **Bundled demo** label identifies these read-only results and their original
Search index, even if a different live index is configured. Local configuration
and caches aren't changed. Compatible local reviews take precedence.
The original CU run is already included under `data\results`.
The bundle covers **FoundryIQ**, not **No policy retrieval**; follow-up chat and
live work require the approved lab identity, configured Azure resources and a
live review. `.\infra\policy-demo-cache.ps1` remains an optional maintenance command.

Both modes use the same model, field-only claim Markdown and
[review question](rental-review-agent-question-v2.md). Selecting a mode, case,
tab or source link doesn't submit an agent request or start ingestion.

| Mode | What the agent receives |
|---|---|
| No policy retrieval | Claim facts only. Internal SOP thresholds aren't available; all five checks require review, with no invented citations. |
| FoundryIQ | Relevant CU fields and prefetched Azure AI Search evidence for each check; follow-up chat can use the Search tool. |

The application fixes the loss state, policy ID, insured VIN and source
generation in the Search filter. Policy-specific documents require both
identifiers to match; state/shared SOPs remain available without them.
Initial reviews use one scoped prefetch; follow-up chat can choose search
keywords, not a different state's rules. Missing
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
| Daily cost | Does the rental price fit the effective policy's numerical limits, conditional on an eligible period? |
| Rental dates | Do actual repair dates and remaining rental days support the billed interval? |
| Active policy | Which issued terms govern this vehicle at the time of the accident? |
| Covered charges | Does the bill add up, with supported taxes, fees and credits counted once? |
| Payment approval | Are insurer approval and required payment documents available? |

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
Each shows a short finding, claim-versus-policy values with source links,
and optional **Review details**.

| Status | Meaning |
|---|---|
| Satisfied | A check mark identifies a supported check. It isn't payment approval. |
| Not applicable | The rule and claim evidence establish that the check doesn't apply. It isn't a passed rental claim. |
| Review required | An open circle identifies a decision needing human review: conflicting facts, unclear policy evidence or a known exception. It isn't a denial or a checkbox that changes the agent result. |
| Waiting for info | A circular-arrow icon identifies missing claim information or pending insurer approval. The review has finished; add the missing evidence, then rerun. The icon doesn't spin or imply active processing. The internal outcome remains `InProgress`. |
| Run error | Extraction, retrieval, execution or validation failed. No business outcome is assumed. |

Keep contractual benefit limits separate from the SOP's internal handling
authority. For example, a rate below the policy cap can still exceed a routine
SOP threshold and require exception approval.

## Ask follow-up questions

The right panel opens in **Result**. Select **Ask agent** to ask about the selected
check for the same case and retrieval mode without changing its saved results.
Daily cost, Rental dates, Active policy, Covered charges and Payment approval
each have their own conversation. Switching checks doesn't mix their history.

Chat uses the locally served, MIT-licensed [Deep Chat](https://deepchat.dev/)
component. It starts with that check's question, relevant CU fields in SDK
frontmatter and its single saved answer. Expand the question-and-fields section
to inspect the input. New parallel reviews preserve the actual per-check
prompts in the review cache. Older snapshots without those prompts use the
current per-check question and selected CU fields, explicitly labeled as current.

Each explicit question runs the same Python agent. Search-backed questions
retrieve fresh evidence; no-retrieval questions must disclose that SOP evidence
is unavailable. Questions don't change claim facts or authorize payment.

Chat history stays in server memory, isolated by private session, CU run, case,
check, mode and result/model/configuration identity. It isn't written into shared review
caches. It expires on server restart or private-session expiry. Each context
allows 20 follow-ups, with at most 100 contexts per private session.

Azure usage may be billed. Failed submissions aren't committed as successful
turns or automatically retried. The model receives `store: false`; no separate
hosted agent or hosted conversation is created.

## Open cited documents

Sources replace the right-panel finding with the verified PDF at the cited page.
**Back to policy check** restores the finding and its selected value.

The PDF preview loads its renderer and worker from the local workbench, not a
CDN. If a server restart interrupts the worker load, the viewer makes one attempt
with a fresh renderer to clear the failed module import. If it still can't load,
check that the workbench is running and reload the page. PDF.js calls its
main-thread fallback a "fake worker"; this isn't a separate service or model.
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
