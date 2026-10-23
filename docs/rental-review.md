# Synthetic rental review scenarios

This corpus supports a five-check rental reimbursement review using Content
Understanding claim facts and retrieved SOP knowledge. All state differences
are **fictional internal procedures**, not state law or insurer contract terms.
This historical reference describes the original v1 scenarios; their policy
files and ZIP archive have been removed. For the current
all-state corpus and application, use the [v2 corpus guide](rental-ocr-comparison.md)
and [policy checks workflow](policy-checks.md).

## Documents

| Retired source | Current replacement |
|---|---|
| Texas SOP: TX-RENTAL-001 v1.0 | [TX-RENTAL-002 v2.0](../data/policies/rental/ocr-comparison-v2/tx-rental-review-sop-v2.pdf) |
| Washington SOP: WA-RENTAL-001 v1.0 | [WA-RENTAL-002 v2.0](../data/policies/rental/ocr-comparison-v2/wa-rental-review-sop-v2.pdf) |
| Shared standard: SHARED-EVIDENCE-001 v1.0 | [SHARED-EVIDENCE-002 v2.0](../data/policies/rental/ocr-comparison-v2/shared-rental-evidence-standard-v2.pdf) |

The documents contain decision tables with merged title/exception rows,
multi-level headers, checkbox worksheets and checked illustrations, stable
rule IDs, numbered sections, authorization roles and boundary examples.
Worksheets and examples are explicitly not claim evidence.

The [original agent question and input contract](rental-review-agent-question.md)
and [expected packet outcomes](../data/scenarios/rental-review.expected.json)
remain historical references, not knowledge sources. For current routing metadata,
use the [v2 corpus manifest](../data/policies/rental/ocr-comparison-v2/manifest.json)
with the [v2 agent question](rental-review-agent-question-v2.md).

## Five checks and state differences

| Check | Texas | Washington |
|---|---|---|
| Eligibility and need | Actual repair downtime required; dated shop records suffice | Drivable vehicle also needs explicit facility confirmation of actual unavailability; an explicit statement on a shop record qualifies |
| Daily rate | Routine authority through $75/day | Routine authority through $60/day |
| Duration and repair alignment | Routine authority through 7 days | Routine authority through 5 days |
| Charges and calculation | Reconcile charges; establish mandatory taxes separately from base cap | Same, with an explicit clarification trigger for generically described local levies/surcharges |
| Authorization and readiness | Insurer approval; supervisor approval for internal exceptions | Insurer approval plus supervisor sign-off for rate/duration exceptions |

Thresholds are inclusive. Applicable policy limits always apply independently.
Both state SOPs use the loss date for fictional effective-date selection:
2024-01-01 through 2026-12-31 inclusive. This intentionally covers the existing
historical packets. State routing uses loss state by explicit lab convention;
it is not legal advice on jurisdiction.

## Existing packet scenarios

The existing [packet manifest](../data/packets.json) maps original PDF pages.
Facts below are grounded in the saved CU results. Expected statuses assume
normalization confirms routing facts; missing routing evidence requires
clarification rather than treating the manifest as CU output.

| Check | Texas: packet 01 | Washington: packet 02 |
|---|---|---|
| R1 | **Review required:** drivable; scheduled repairs do not prove actual loss of use | **Review required:** drivable; explicit facility downtime confirmation not established |
| R2 | **Pass:** $54/day is within both $85 contractual cap and $75 routine authority | **Review required:** $61/day is within $85 contractual cap but above $60 routine authority; no supervisor exception established |
| R3 | **Review required:** 4 days meets the 7-day threshold, but actual repair alignment and cumulative usage remain unsupported | **Review required:** 5 days meets the 5-day threshold, but actual repair alignment and cumulative usage remain unsupported |
| R4 | **Pass:** 4 x $54 = $216; plus $21.60 identified rental tax = $237.60; stated endorsement allows mandatory tax additional to base | **Review required:** $305 + $30.50 + $18 + $5.49 = $358.99 reconciles, but the generic local levy needs clarification |
| R5 | **Review required:** final bill records no insurance authorization | **Review required:** no insurer authorization; rate exception also needs supervisor sign-off |

R4 does not independently certify legal tax rates. R2 can pass independently
of unresolved necessity; R3 can require review even when the numeric day count
is within authority. A later return record resolves earlier return-pending
status but does not prove repair completion or authorization. Different rental
and insured vehicles are expected; unrelated supplemental tax forms are not
rental evidence.

For packet 01, route to the adjuster for authorization and the shop for actual
downtime records. For packet 02, add supervisor review of the $61/day rate and
supplier clarification of the local levy. Neither packet is ready for an
automatic payment recommendation.

## Search ingestion guidance

The original v1 workflow indexed only its three policy PDFs. The current workflow
indexes only the eleven PDFs listed in the v2 manifest, one representation per document version.
Keep DOCX originals as editable sources, not duplicate indexed documents.
Do not index this guide, the agent question, evaluation fixtures, claim packets
or CU outputs into the policy knowledge corpus.

Use the manifest as ingestion metadata; it does not automatically configure
Azure AI Search. Suggested filterable fields are document ID/type/version,
states (a collection), product, coverage type, benefit and effective dates.
Retain rule ID, section, source path and page on each chunk. Filter the state
SOP by normalized loss state and other applicability fields, then also retrieve
the shared standard. Metadata is a retrieval aid; the authored SOP remains the
human-readable authority.

Keep each table row with its headers and exception note, retrieving the linked
calculation section and shared rules when necessary. Do not retrieve a numeric
threshold detached from its exception conditions. Chunking should preserve the
distinction between decision instructions, blank checklists and examples.
No relevant matching SOP, ambiguous scope or multiple matching versions means
review, not fallback to a semantically similar state's rule.

For the current corpus, revise the definitions in
`infra/generate-rental-sop-corpus.py` and regenerate the PDFs, DOCX exports,
controls, manifest and expected outcomes together. The DOCX exports are not
inputs to PDF generation.
