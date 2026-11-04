# Policy checks in the workbench

Compare what an agent can establish from claim facts alone with what it can
establish after retrieving the applicable policy rules. This is a synthetic
processing demo, not a coverage decision or permission to pay a claim.

The workflow has three parts:

1. **Claim facts:** Content Understanding extracts structured facts from a packet.
2. **Policy rules:** Azure AI Search holds searchable chunks of the synthetic
   SOP PDFs and policy-scoped contractual PDFs. The active configuration
   identifies the index and extraction mode.
3. **Review:** A Python Microsoft Agent Framework agent evaluates three comparisons
   and answers follow-up questions using grounded Search retrieval.

Reviews use only saved **Parse and extract** fields and selected first-pass page
text from that same run. There is no claim-summary prerequisite or claim CU
reanalysis. The CU Python SDK's public `to_llm_input` helper formats typed fields as YAML
frontmatter with `include_fields=True` and `include_markdown=False` (there is
no separate public `to_llm_frontmatter` helper). Each check receives only its
relevant field paths, document categories and preserved text evidence IDs.
Page images, bounding boxes, confidence and duplicate prose are not sent. False and zero remain
values; fields without a value appear in explicit `missingFields` metadata.
Missing claim facts wait for data; conflicting facts require review. The agent
does not reread the PDF to repair extraction.
The full packet export remains available in Parse and extract for human inspection.
Interpretations of first-pass page text are distinguished from typed CU facts.
They reference the supplied `parse.<contentpath>` ID and its native page range,
not a guessed field label or fabricated polygon.

For the initial three-check review, the application fetches all indexed chunks
within the registered state, policy, vehicle and corpus scope in one Search
request and verifies their source identities. A separate interpretation establishes
rental applicability for Daily rate from the saved evidence before **three concurrent comparison
requests per packet**, one for each check, without a Search tool-planning
loop. Each gets its own question, relevant saved Parse evidence and complete relevant
policy pages. **Effective
terms** compares the loss date with the matched terms, independently of rental use.
**Repair estimate** independently compares each relevant distinct quote's gross total,
including stated tax and before deductible or payments, with the retrieved
synthetic internal state-specific routine review threshold.
The calls share one model connection
pool and cached Azure CLI token provider. Citation validation is scoped to the
evidence supplied to each call. Results are combined in the three-column
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
Concurrent calls can reduce wall-clock time but repeat some shared context,
consume more request quota and encounter token-rate limits. They are not a
guaranteed speedup.

For a different model in follow-up chat only, set
`POLICY_CHAT_MODEL_DEPLOYMENT` to an existing deployment name on the same
Azure OpenAI resource. Optionally set
`POLICY_CHAT_REASONING_EFFORT=minimal|low|medium|high` to an effort that model
supports, then restart the server. These settings don't change the model used
for the three initial checks or invalidate their saved results. Chat shows its
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

The **Claim policy checks** heading sits directly above the comparison table.
Its three columns are **Daily rate**, **Effective terms**, and **Repair estimate**,
with a short comparison question under each. These labels are also the exact
ordered runtime check IDs.
Select a result to replace the right-hand panel with a short agent-written finding and the decisive claim
fields compared with the policy rule values. Exact CU field names and policy
rule IDs remain visible; links open the supporting policy documents.
Missing information is shown explicitly rather than filled in.
Checks waiting only for claim information show **Waiting for info** in blue.
The detail panel names the missing evidence needed by that comparison.
Missing unrelated repair completion or payment authorization doesn't create
a wait for these narrow checks. This is not a running agent: add the
information and rerun the policy checks. Conflicting facts, known rule
violations and missing or ambiguous policy evidence stay **Review required**.
The agent returns a distinct `InProgress` outcome with `ReviewRequired=false`;
the interface does not guess the status from finding text. Existing saved
reviews need a fresh evaluation to use this status.
In the comparison table, select a linked **Claim** value to open the original
packet at the supplied CU source page, with native extracted-field boxes highlighted
when available. Text-only sources display **First-pass parsed page text** and
the exact preserved page range, without invented boxes. Their interpretation is
not a typed CU fact. Select a
linked **Policy** value to open the exact cited rule page. When multiple pages
support a field or rule, each page is offered separately. **Back to policy
check** restores the selected finding and focus. Missing fields or fields with
no supplied source coordinates or page range are explicitly unlinked; page locations are never
guessed from an agent-written label or value.
**Review details** and **Structured output and provenance** retain the fuller
explanation and original output. Earlier saved reviews remain readable but need
a new live run to receive the new headline and structured field comparisons;
the interface does not invent a summary or extract values from old prose.
The policy workflow does not automatically open claim packets. Its right panel
contains the selected check's **Result** and **Ask agent** views and identifies
the customer and packet. The left table stays in place without an expanded row.
Select a policy source to inspect it in the right panel, then **Back to policy
check** to return to the finding or chat. **Parse and extract** and
**Business rules validation** retain their packet viewer and inline details.

### Non-rental claims

**Daily rate** can show **N/A** when affirmative saved
evidence confirms no rental was requested or used and no rental request,
agreement, use or bill conflicts. A pending request still applies before use.
**Effective terms** still compares the applicable policy and genuine amendment
with the actual loss date for the matched policy ID and insured VIN. Non-rental
status isn't a blanket exemption from that comparison. **Repair estimate** is
also independent of rental applicability; evaluate the supplied repair quotes
against the retrieved state-specific internal authority diagram.

The agent interprets applicability from original typed facts and selected
first-pass page text, preserving their supplied evidence IDs. Explicit, labeled
Yes/No answers can establish applicability; a blank checkbox, absent rental
invoice or unrelated repair, towing or glass bill can't establish no rental.
An answer to a towing question isn't a rental request answer. Missing applicability
evidence can leave the Daily rate comparison **Waiting for info**; contradictory
evidence requires review. Neither changes an independently supported
**Effective terms** comparison. Rental amounts come from rental evidence only.

Use the [setup guide](policy-setup.md) and
[setup notebook](../infra/policy-agent-framework-setup.ipynb) to prepare
the policy index on your existing Search service.

## Compare packets 01 and 02

The top-level pivots are **Parse and extract**, **Business rules validation**,
and **Check policies**. Saved results load automatically and remain shared across
all three pivots. Classification and
document-type views live under **Parse and extract**; policy resource links
appear only under **Check policies**. Switching pivots preserves the loaded run
and reuses the same table, document viewer and debugger. Returning to **Parse
and extract** restores the previously selected document type.

Grounded Search retrieval is the default; the app has no retrieval-mode dropdown.
Earlier no-retrieval baselines remain in cache history, not a selectable app mode.
A missing live classifier does not prevent using cached claim
results with the configured policy index. FoundryIQ is the lab's umbrella label for grounded policy
retrieval; this implementation queries an ordinary Azure AI Search index directly,
not a Foundry IQ knowledge base. Two plain labels identify the Search index and
policy document storage. The index name opens that exact index in the Azure portal.
A verified Blob container, when registered for the same source generation, opens
its container view. The current Layout generation reads local PDFs and has no
matching Azure container, so its storage label says so without a misleading link.
**Settings** retains live-run controls, configuration status and cache reloads;
active runs still have a visible progress banner.

If a case shows **Run error**, open its **Result** and select **Retry this case**
under the error. The confirmation names that one case; it does not rerun other
customers. Wait for any active batch to finish first. Matching saved claim fields
and completed reviews are reused; new Search and agent work can
incur Azure charges. Retrying evaluates all three checks for that case, not just
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

1. In **Settings**, select **Reload saved results** to load the
   included completed **10/10** CU run. Select **Check policies**.
2. In **Settings**, enable live calls and select **Run live policy checks**
   and confirm. This runs the Agent Framework agent against saved CU
   fields and selected first-pass text, not just a local rules engine. Azure charges apply;
   no claim CU reanalysis is submitted. The confirmation covers all loaded
   cases, not only the selected row.
3. Wait for the batch to finish. While a run is active, a prominent status banner
   shows the packet being processed, its customer name when available, the
   number of finished packets, and a total elapsed timer updated every second.
   The banner reports the three policy comparisons and
   follows the active packet even when another customer is selected.
   Packets run sequentially; an uncached packet uses saved Parse evidence,
   one Search prefetch, applicability interpretation and three parallel Agent Framework calls, one per
   check. Matching current reviews skip the model calls.
   Open a check's **Result** tab for an activity indicator, elapsed stage time
   and the age of the last successful workbench response. This confirms the
   progress connection, not individual Search/model-call completion. If updates
   stop, reconnect rather than starting another batch.
4. Compare **Daily rate** for packets **01** and **02**, using the source
   evidence below. Select each check to inspect its headline, claim and policy
   values, and sources in the right panel.
   Open **Review details** for the fuller explanation.
   Claim PDFs remain available in Parse and extract.
5. For packet **01**, select the declarations and issued amendment source links.
   Inspect the matched vehicle row and the amendment's effective terms.
   Select **Back to policy check** to restore the finding.

| Case | Daily base evidence | Contractual daily cap | Comparison to inspect |
|---|---:|---:|---|
| Packet 01 / Texas | $54 | $75 | Compare $54/day with the matched effective $75/day cap, conditional on eligibility |
| Packet 02 / Washington | $61 | $85 | Compare $61/day with the matched effective $85/day cap |

Inspect **Effective terms**
against the actual loss date and genuine issued amendment. Unrelated completion,
fee classification and insurer payment approval aren't additional checks.

These are source-based expectations, not hardcoded agent answers. If returned
facts, routing or citations differ, inspect the evidence and errors rather than
forcing a pass. Neither daily-rate result approves the entire claim or payment;
other checks can still require review. The synthetic repair SOP can't supply
a missing contractual rental benefit.
The matching revised declarations and effective amendment can establish the
contractual limit when the policy ID and insured VIN are verified. They cannot
establish that repairs actually began or ended.

In **Policy documents**, compare **CU Search** and **Digital parse** with each PDF.
Declarations retain sparse tables; effective-date records retain scans; the
repair SOP retains both complete diagram pages. Both genuine native outputs
are bundled for every active PDF. Digital parse may successfully return no text
for a scan. The viewer explains this without substituting OCR or Layout chunks.
An unavailable representation has an explicit, billable generation action;
switching tabs alone doesn't run CU.

Optionally, select **Ask agent** in the expanded review. Ask: "Explain this case's
daily-rate result and cite the matched contractual cap." Each chat turn
uses the selected case and retrieval mode; it isn't a new batch comparison.

## Optional: look under the hood

The lab demonstrates search-backed policy grounding, a pattern related to
Foundry IQ. **This implementation queries an ordinary Azure AI Search index
directly; it doesn't create or invoke a Foundry IQ knowledge base or knowledge
source.** Claim extraction, policy ingestion and agent reasoning are separate
steps.

### Inspect the deployed Search index

1. Select the index name beside **Azure Search (FoundryIQ) Index for policy documents**,
   or read
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

The current pruned three-check bundle records its isolated index in
`data\policy-demo\policy-agent-framework.json`, with **CU Layout** extraction.
Don't describe it as Standard extraction. The
[managed CU ingestion setup](policy-setup.md) activates a replacement only
after ingestion and source verification succeed.

### Inspect the local policy files

Open the [v2 policy folder](../data/policies/rental/ocr-comparison-v2/) and its
[manifest](../data/policies/rental/ocr-comparison-v2/manifest.json). The PDFs are
the knowledge sources; the manifest carries state, version and hash metadata.
The expected-answer fixtures aren't indexed. The active manifest contains
21 PDFs: ten declarations, nine scanned effective-date records, the issued
Texas amendment and the two-page synthetic repair-review diagram.
These establish the contractual rental cap, effective terms and synthetic
repair authority needed by the three current questions.

The 21 legacy rental-terms, state rental-review SOP and shared five-check-standard
PDFs remain in `data\policies\archive\legacy-rental-review-v2\`.
The archive manifest records original logical paths, versions, SHA-256 values,
archive paths and rationale. Historical citations resolve only through these
verified records; archives aren't in active retrieval, previews or document counts.
Corpus generation verifies the pruned sources rather than recreating legacy files.

The **Policy documents** link opens a same-origin, manifest-backed list of the
actual local source folder. Each file opens in **Original**, **CU Search**, or
**Digital parse**. This isn't arbitrary directory browsing, a `file://` link,
Explorer or a Blob container. No files are uploaded by this workflow.
Public portal metadata lives in `data\policy-demo\resources.json`, separate from
model inputs and review-cache identity. It must match the exact index name,
corpus hash, index fingerprint and Search endpoint before any links are shown.
Missing, invalid or stale metadata produces an explicit unavailable label and
doesn't prevent loading offline reviews. After a different deployment, register
only verified resource metadata for that generation; a Blob entry requires its
actual account resource ID and populated policy container, not a name inferred
from a hash. Rendering the labels makes no Azure calls. Opening a portal link
requires the viewer's Azure sign-in and resource permissions. If saved results
and live configuration use different indexes, the page identifies both.

### Inspect the agent

Open [`infra/policy-framework-agent.py`](../infra/policy-framework-agent.py).
Find `Agent`, `OpenAIChatClient` and `search_policy_rules`. Initial reviews
prefetch Search evidence and pass each check only its relevant saved Parse fields, selected first-pass text and
rules. Follow-up chat can use the Search tool. The
[workbench policy service](../src/workbench/src/policy-service.ts) starts this
Python agent and validates results and citations. This isn't an npm Agent
Framework implementation or a hosted Foundry agent.

## Run policy checks

1. Launch the workbench with `.\infra\launch-workbench.ps1`.
2. Load saved CU results, or explicitly run your connected analyzer.
3. Open **Check policies**, which always uses grounded Search retrieval.
4. In **Settings**, enable live calls, select **Run live policy checks** and confirm the Azure operation.
5. Select a check in the grid to inspect its review in the right panel.

### Load saved policy results

Open **Settings** for **Reload saved results** and **Reload policy reviews**.
There is no policy retrieval selector. The extraction button loads the saved CU run (preferring a
completed run); its tooltip identifies the analyzer and saved time.

Select **Reload policy reviews**. The button loads the compatible grounded checks for
the loaded CU run. On first launch, it can load the included
CU run and policy results together; loading extraction results separately isn't
required. Availability updates when entering **Check
policies** or completing a policy batch.
Listing or loading saved policy results makes no Azure calls.

Exact execution caches match the CU run, claim input, prompt, runtime and policy
configuration. Persistent snapshots also allow earlier-prompt results when the
CU run, claim input and policy configuration still match; the app labels them
as historical. Local results from another run or configuration aren't substituted.
Source citations are verified
again when loading. A partially completed set loads only saved completed cases;
remaining cases stay **Not run**. Live runs still save successful cases
automatically. Loading is disabled while this session is processing a batch.

On first launch, the app automatically loads the included **10/10** CU run and
**30** saved comparison cells. Open **Check policies**;
**Settings** > **Reload policy reviews** reloads them.
Without compatible local reviews, the app
reads ten policy reviews and their claim fields directly from `data\policy-demo`.
No Azure configuration, credentials or manual restore command is required.
The **Bundled demo** label identifies these read-only results and their original
Search index, even if a different live index is configured. Local configuration
and caches aren't changed. Compatible local reviews take precedence.
The original CU run is already included under `data\results`.
The bundle covers **FoundryIQ**, not **No policy retrieval**; follow-up chat and
live work require the approved lab identity and configured Azure resources.
`.\infra\policy-demo-cache.ps1` remains an optional maintenance command, never an
attendee prerequisite. Earlier five-, four-, and three-check reviews remain history,
not relabeled or converted into the current three-check outcomes. Contract version 5
distinguishes this bundle from the old three-check set containing Rental start.
The new bundle replaces
the active results without altering saved Parse facts.

The grounded workflow uses the saved Parse evidence and
[review question](rental-review-agent-question-v2.md). Selecting a case,
tab or source link doesn't submit an agent request or start ingestion.

| Mode | What the agent receives |
|---|---|
| No policy retrieval (historical backend baseline only) | Saved claim evidence only. Missing governing policy evidence remains explicit, with no invented citations or benefit limits. Not selectable in the app. |
| FoundryIQ | Relevant saved Parse fields, selected first-pass text and prefetched Azure AI Search evidence for each check; follow-up chat can use the Search tool. |

The application fixes the loss state, policy ID, insured VIN and source
generation in the Search filter. Policy-specific documents require both
identifiers to match; the synthetic repair SOP remains available by loss state.
Initial reviews use one scoped prefetch; follow-up chat can choose search
keywords, not a different state's rules. Missing
routing or evidence remains explicit; a similar state's SOP isn't substituted.

Policy review reuses saved Parse evidence without preparing a claim summary or
submitting claim CU reanalysis. The Studio classifier/router isn't changed,
and missing claim facts aren't filled in from policy rules or local answer guides.

### Follow batch progress

Policy checks use the loaded saved Parse fields and selected first-pass
page text. The ten cases run sequentially; the status line shows completed
cases, the active case, three-comparison review progress and total elapsed time.

Refreshing the same browser tab reconnects to its private session, reloads its
selected CU run and resumes policy progress without submitting another batch.
Keep that tab open; a different private session can't take over its job.
The app disables another run while a batch is active. Repeated start requests
for the same session, run and mode return the existing job rather than charging
for a duplicate.

If a progress request fails, reload the same tab to reconnect. Restarting the
server clears in-memory jobs and private chat; it doesn't automatically rerun
them. Completed saved results remain available for the next explicitly confirmed run.

## Read the three checks

The checks appear in this order:

| Check | Question |
|---|---|
| Daily rate | Is the claimed daily rental base rate within the effective cap for the matched insured vehicle, conditional on rental eligibility? |
| Effective terms | Were the applicable policy and genuine amendment effective and in force on the actual loss date for the policy ID and insured VIN? |
| Repair estimate | Is each supplied repair-estimate total within this state's routine review authority? |

For Packet #1, inspect the revised declarations and
scanned amendment in the source viewer. The Honda row's blank optional-code
cell must not shift the $500 collision deductible, $75 daily rental limit, or
30-day maximum. The separate Toyota row does not establish the Honda's
coverage. The declarations identify the base daily cap with mandatory tax
additional. A numerical fit is not proof of an eligible repair period.
Verify the policy ID and insured VIN against the actual source image; a similar
vehicle description or parsed VIN alone doesn't establish the matched vehicle.

**Repair estimate** uses the retrieved repair-authority diagram's **synthetic
internal state-specific routine review threshold**. It isn't law, a contractual
coverage cap or payment approval. Compare each relevant distinct quote's gross
total, including stated tax, before deductible or payments. Don't add different
quotes together, net out a deductible or select just the lower quote.
Different amounts alone don't require review here: the separate
**Business rules validation** multiple-estimates warning retains that role.
Missing required quote evidence can mean **Waiting for info**; missing or ambiguous
authority stays **Review required**, never a guessed threshold. This check is
independent of rental applicability. Keep Texas's **$75/day** and Washington's
**$85/day** contractual rental limits distinct from repair authority.

**Effective terms** requires a genuine issued amendment and its effective time,
not just a customer signature. Missing unrelated repair completion or payment authorization doesn't
turn these narrow comparisons into a wait.

For a bounded owner evaluation, `POST /api/policy/batch` accepts
`{"mode":"search","live":true,"packetIds":["packet-01"]}` in the current
private workbench session after loading CU results. The normal UI confirmation
still runs all loaded cases; selecting a row alone does not restrict a batch.
Without `packetIds`, the existing all-loaded-cases behavior is unchanged.
Each shows a concise headline, one to three claim-versus-policy comparisons with source links,
and optional **Review details**.

| Status | Meaning |
|---|---|
| Satisfied | A check mark identifies a supported check. It isn't payment approval. |
| Not applicable | The rule and claim evidence establish that the check doesn't apply. It isn't a passed rental claim. |
| Review required | An open circle identifies a decision needing human review: conflicting facts, unclear policy evidence or a known exception. It isn't a denial or a checkbox that changes the agent result. |
| Waiting for info | A circular-arrow icon identifies missing claim evidence needed for that comparison, not unrelated repair completion or payment authorization. The review has finished; add the missing evidence, then rerun. The icon doesn't spin or imply active processing. The internal outcome remains `InProgress`. |
| Run error | Retrieval, execution or validation failed. No business outcome is assumed. |

Keep contractual benefit limits separate from the SOP's internal handling
authority. For example, a rate below the policy cap can still exceed a routine
SOP threshold and require exception approval.

## Ask follow-up questions

The right panel opens in **Result**. Select **Ask agent** to ask about the selected
check for the same case using grounded Search retrieval without changing its saved results.
Daily rate, Effective terms and Repair estimate
each have their own conversation. Switching checks doesn't mix their history.

Chat uses the locally served, MIT-licensed [Deep Chat](https://deepchat.dev/)
component. It starts with that check's question, relevant CU fields in SDK
frontmatter and its single saved answer. Expand the question-and-fields section
to inspect the input. New parallel reviews preserve the actual per-check
prompts in the review cache. Older snapshots without those prompts use the
current per-check question and selected CU fields, explicitly labeled as current.

Each explicit question runs the same Python agent and can retrieve fresh Search
evidence. Questions don't change claim facts or authorize payment.

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
