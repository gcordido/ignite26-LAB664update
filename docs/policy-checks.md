# Policy checks in the workbench

Compare what an agent can establish from claim facts alone with what it can
establish after retrieving the applicable policy rules. This is a synthetic
processing demo, not a coverage decision or permission to pay a claim.

The workflow has three parts:

1. **Claim facts:** Content Understanding extracts structured facts from a packet.
2. **Policy rules:** Azure AI Search indexes the synthetic SOP PDFs using a
   managed Content Understanding ingestion pipeline.
3. **Review:** A Python Microsoft Agent Framework agent evaluates five checks
   and answers follow-up questions using the selected retrieval mode.

Use the [setup guide](policy-setup.md) and
[setup notebook](../infra/policy-agent-framework-setup.ipynb) to prepare
the policy index on your existing Search service.

## Run policy checks

1. Launch the workbench with `.\infra\launch-workbench.ps1`.
2. Load saved CU results, or explicitly run your connected analyzer.
3. In **Policy checks**, select **No policy retrieval** or
   **Azure Search retrieval**.
4. Select **Run policy checks** and confirm the Azure operation.
5. Select a check in the grid to see the complete review in the sidebar.
6. Switch retrieval mode and run again to compare the same claim inputs.

Both modes use the same model, field-only claim Markdown and
[review question](rental-review-agent-question-v2.md). Selecting a mode, case,
tab or source link doesn't submit an agent request or start ingestion.

| Mode | What the agent receives |
|---|---|
| No policy retrieval | Claim facts only. Internal SOP thresholds aren't available; all five checks require review, with no invented citations. |
| Azure Search retrieval | The same claim facts, plus a tool that retrieves the applicable state SOP and shared evidence standard. |

The application fixes the loss state and source generation in the Search
filter. The model chooses keywords, not a different state's rules. Missing
routing or evidence remains explicit; a similar state's SOP isn't substituted.

Claim preparation runs only when explicitly requested by a policy batch and
reuses matching saved extraction. The Studio classifier/router isn't changed,
and missing claim facts aren't filled in from policy rules or local answer guides.

## Read the five checks

The checks cover rental eligibility, daily rate, duration and repair alignment,
charges and reimbursement calculation, and authorization/payment readiness.
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

The sidebar opens in **Result**. Select **Chat** to ask about the same case and
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

Sources open the verified PDF inside the sidebar at the cited page.
**Back to policy checks** or **Back to chat** restores the previous view.
The citation must match the source filename, document ID, version, rule,
section and unchanged PDF hash. Search-backed citations must also come from
evidence retrieved during that turn.

Managed chunks can span pages. The application uses their real page ranges
and the source citation map; it doesn't assume one chunk equals one page.

Three tabs display representations of the same PDF:

| Tab | What it shows |
|---|---|
| Document | The source PDF, initially at the cited page |
| CU Layout | Cached Markdown from `prebuilt-layout`, with OCR and table layout |
| Digital parse | Cached Markdown from `prebuilt-digitalParse`, using embedded digital content |

**These extraction tabs aren't the Search-managed Standard output.** Layout
isn't semantic figure interpretation. Digital parse isn't a complete substitute
for a Search Minimal ingestion pipeline. A scanned PDF can have no readable
digital text; that result is shown honestly.

The Markdown views show the whole document. **Raw extraction Markdown** exposes
the returned text. Rendering preserves table spans and empty cells, sanitizes
HTML and doesn't load remote images.

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
