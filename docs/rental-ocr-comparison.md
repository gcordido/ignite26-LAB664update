# Rental SOP OCR and table comparison

The [v2 corpus manifest](../data/policies/rental/ocr-comparison-v2/manifest.json)
contains ten state SOPs and one shared evidence standard covering every state
in the existing ten-packet dataset. These are fictional internal processing
rules, not state law, new contractual benefits or permission to pay a claim.
The retired Texas/Washington v1 files and their ZIP archive have been removed.
The v2 PDFs are indexed in the current Layout-based policy index. The
[managed extraction setup](policy-setup.md) prepares the semantic extraction
pipeline separately and activates it only after verification.

## Documents and limits

| State | Routine daily base, inclusive | Routine days, inclusive | Scope with an express rental benefit |
|---|---:|---:|---|
| [Texas](../data/policies/rental/ocr-comparison-v2/tx-rental-review-sop-v2.pdf) | $75 | 7 | Personal collision |
| [Washington](../data/policies/rental/ocr-comparison-v2/wa-rental-review-sop-v2.pdf) | $60 | 5 | Personal collision |
| [Arizona](../data/policies/rental/ocr-comparison-v2/az-rental-review-sop-v2.pdf) | $70 | 5 | Personal comprehensive/theft |
| [Colorado](../data/policies/rental/ocr-comparison-v2/co-rental-review-sop-v2.pdf) | $80 | 5 | Personal comprehensive/hail |
| [Florida](../data/policies/rental/ocr-comparison-v2/fl-rental-review-sop-v2.pdf) | $75 | 7 | Personal collision |
| [Illinois](../data/policies/rental/ocr-comparison-v2/il-rental-review-sop-v2.pdf) | $80 | 5 | Personal collision |
| [Louisiana](../data/policies/rental/ocr-comparison-v2/la-rental-review-sop-v2.pdf) | $70 | 5 | Personal comprehensive/flood |
| [California](../data/policies/rental/ocr-comparison-v2/ca-rental-review-sop-v2.pdf) | $85 | 3 | Personal comprehensive/glass |
| [New York](../data/policies/rental/ocr-comparison-v2/ny-rental-review-sop-v2.pdf) | $75 | 5 | Personal comprehensive/animal strike |
| [Ohio](../data/policies/rental/ocr-comparison-v2/oh-rental-review-sop-v2.pdf) | $80 | 5 | Commercial delivery with express rental endorsement |

Every state also requires the
[shared evidence standard](../data/policies/rental/ocr-comparison-v2/shared-rental-evidence-standard-v2.pdf).
State rules use `XX-R1` through `XX-R5`; the shared rules use `E-01` through
`E-06`. Document IDs end in `-002`, version `2.0`; select this corpus alone,
not a mixture of v1 and v2 sources. The fictional effective window covers
2024-01-01 through 2026-12-31 inclusive.

These numbers are internal authority, **not the policy's benefit limits**.
Compare both limits separately. A rental supervisor can approve an internal
rate/duration exception only within the remaining contractual benefit.

## Why the PDFs exercise figures, tables and OCR

The corpus separates three extraction challenges rather than making every
document the same kind of scan. Arizona has five pages; the others have four.
No PDF contains an embedded attachment or an answer-bearing hidden OCR layer.

| Document | Format and extraction challenge |
|---|---|
| Arizona | Selectable text on pages 1-4; page 5 embeds the controlling AZ-R1 eligibility flowchart as an image. The branch labels, connectors and outcomes are pixels, not selectable text or alt text. The rule matrix points to the figure instead of restating its eligibility conditions. |
| Texas | Selectable-text PDF with a sparse Schedule A on page 3. Rate-only and duration-only exception rows have intentionally empty cells; the reader must preserve headers, blank positions and the table's interpretation key. |
| Washington | All four pages, including the routing cover, are 180-DPI grayscale scan images. There is no digital text on any page; even state/product/date routing requires OCR or externally supplied routing metadata. |
| Other seven states and shared standard | Selectable routing cover, followed by three image-only rule pages: the decision matrix, rate/duration/charge schedules, and applicability/checkbox worksheet. |

### Arizona eligibility flowchart

Figure 1, **5. Figure 1: rental eligibility (AZ-R1)**, distinguishes confirmed
no-request evidence from an unknown request, checks routing and express coverage,
then branches between non-drivable evidence and dated actual shop intake/release.
Scheduled repairs alone lead to review. A satisfied R1 terminal does not approve
R2-R5 or payment. The editable DOCX embeds the same figure; there is no parallel
eligibility transcript for a text-only extractor to use instead.

### Texas table with intentional blanks

The routine limits remain **$75/day and 7 days**, independently bounded by the
actual policy. The rate-exception row's duration cell is empty; the following
duration-exception row has empty authority-band and daily-rate cells.

The printed key makes these blanks unambiguous: a blank **Authority band**
continues the previous band, but a blank rate or duration cell grants **no extra
authority** for that dimension. It does not mean zero, unlimited or permission
to copy an adjacent number. A rate-only approval therefore does not approve a
9-day rental, and a duration-only approval does not approve $80/day. Both
exceptions are needed when both routine limits are exceeded.

For example, Washington's `$61/day` request must be read against the `$60/day`
**routine** row, not merely the supplied `$85/day` contractual cap. A reader
must retain the exception-approval condition and must not take the exception
row's authority as permission to exceed the contract.

The `editable/` folder contains generated DOCX exports, not PDF-generation inputs.
The generator retains them for editable reference and validates their tables,
blank cells and embedded figure. The `controls/` folder contains
pre-scan PDFs: Washington and the eight cover-only documents retain their
original digital text there. Arizona's flowchart intentionally remains an image
in its control too, and Texas is already digital; these two controls do not
remove their figure/table challenges. The generator checks each full-page scan
against its control rendered at the scan resolution. Use Washington's control
to isolate OCR effects, Texas to test table association without OCR, and Arizona
to test figure interpretation. The scans are legible, not deliberately blurred.

Standard extraction with OCR is expected to retrieve substantially more rule
text than a no-OCR Minimal/Tika path on the scans. **That is a test hypothesis,
not a measured service result or guaranteed model advantage.** Some Minimal
configurations may perform OCR; verify the actual generated pipeline.

## A mostly-clear dataset without invented approvals

The source packets do not contain ten rental reimbursement requests. Only
packets **01, 02 and 09** contain rental invoices. The remaining seven are
towing, repair, glass-service, valuation or commercial downtime documents.
Having a rental benefit on the policy is not evidence that it was claimed.

| Packets | Intended source-evidence outcome | Important distinction |
|---|---|---|
| 03, 04, 05, 06, 07, 08, 10 | Not applicable to rental review when no request is affirmatively established | Seven clear cases, **not seven approved rental claims** |
| 01 / Texas | Two satisfied checks; three review checks | $54/day and arithmetic pass; actual downtime, prior usage and insurer authority still need evidence |
| 02 / Washington | Five review checks | $61 exceeds $60 routine; generic $5.49 levy, downtime, prior usage and approvals require follow-up |
| 09 / New York | Three satisfied checks; two review checks | Non-drivable need, $73/day and named-tax arithmetic pass; remaining days/downtime and insurer authority remain unresolved |

The [conditional expected outcomes](../data/scenarios/rental-review-v2.expected.json)
are **35 Not applicable, 5 Satisfied and 10 Review required** out of 50 checks:
40 checks have no rental-review action. They are expectations from the source
document inventory and saved root OCR from included run
`6e3b62d2-abe5-4ea7-9898-d2d11f4dc5f1`, not executed agent results.
The fixture records the dataset fingerprint, and its page references follow the
current packet manifest rather than the retired dataset's page ordering.

Earlier field-only CU claim summaries contained contradictions: some towing,
repair, premium and policy-limit values appeared under `Rental`. Arizona, for
example, contains a `$237` flat recovery/towing charge, not a `$237/day` rental;
Florida's `$283` tow bill is also not a daily rental rate. Some routing dates
are inconsistent with the packet chronology. A missing `Rental` field or
missing `rental_invoice` classifier label does **not** establish no request.

**Do not change claim facts to match these targets.** Until request type,
document identity and conflicting extracted values are resolved by reliable
CU fields, these cases must remain review-required. New SOPs remove missing
state/peril coverage; they cannot honestly repair missing claim evidence.
If the desired demo requires a majority of actual rental requests to pass,
additional synthetic rental/repair/authorization evidence is needed; that
evidence is not manufactured by this corpus.

## Compare extraction fairly

Use the [32 source-only probes](../data/scenarios/rental-ocr-comparison.probes.json)
before interpreting the end-to-end claim outcomes. Each state has an exact
routine-rate/inclusivity probe and a duration/exception probe. Additional probes
cover Washington's rate and levy exceptions, a Florida towing-only bill,
Ohio commercial scope, missing-request evidence and blank-checkbox semantics.
Six additional probes cover three Arizona flowchart paths and three Texas
blank-cell interpretations, including the two independent exception approvals.

1. Use the [managed extraction setup](policy-setup.md) for the manifest-listed
   PDFs. Keep the claim facts, question, model and routing unchanged when
   comparing no policy retrieval with Search-backed review.
2. Inspect the source PDF alongside the Layout and Digital parse tabs to
   understand what each representation contains. These direct CU views aren't
   equivalent to a managed Standard/Minimal ingestion comparison.
3. Run the probes against the managed index. Score each complete expected
   answer as one point; separately record abstentions and wrong answers,
   retrieved rule text, page/section citation accuracy, latency and cost.
4. Then compare the exact same claim-field Markdown with the v2 question.
   Report applicability, pass/review accuracy and unsupported guesses
   separately. An honest abstention is preferable to a fabricated pass.

Do not give the agent the oracle, probes' expected answers, this guide,
source-generator constants or claim manifest as knowledge. Do not index the
DOCX originals, text controls or old v1 PDFs alongside the scan corpus.
Index only routing metadata: document ID/version, state, product/peril,
benefit and dates. The manifest's `routineAuthority` is an operator aid,
**not indexed metadata**; otherwise it would leak the scan-only answer.

## Activation boundaries

The workbench uses the v2 corpus and [v2 question](rental-review-agent-question-v2.md).
Managed ingestion activates only after setup verifies the new source generation.
It doesn't change source rules or silently substitute a different extraction mode.

The agent output requires `Outcome` so `NotApplicable` isn't displayed
as `Satisfied`. The strict response schema, runtime validator and table/detail
badges use this distinction together. The Boolean
`ReviewRequired` remains available and must agree with `Outcome`.
Unknown/conflicting applicability is `ReviewRequired`, never `NotApplicable`.
Review caches aren't reused across source generations.

Regenerate the local assets without cloud calls using:

```powershell
python -m pip install -r .\infra\requirements-rental-sop-corpus.txt
python .\infra\generate-rental-sop-corpus.py
```

The optional generator dependencies (`python-docx`, `reportlab` and `PyMuPDF`)
are separate from the attendee workbench setup. The script also needs Windows
Segoe UI fonts and the included completed CU run matching `data/packets.json`.
It stops if that run's dataset fingerprint no longer matches; review the new
evidence and expected outcomes before updating the source run.
It validates all state coverage, source
identities, page counts, state-specific text/image profiles, image/control
equivalence, blank table cells, embedded flowchart, rule IDs, DOCX tables,
PDF hashes and exact oracle counts. It writes only the
v2 corpus and its two evaluation fixtures.
