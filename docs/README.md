# Docs

<!-- IGNITE TEMPLATE PLACEHOLDER: remove this folder when the session needs no additional documentation. -->

Use this folder for supporting documentation such as reference material and
architecture/context.

If this repository intentionally uses MkDocs or another docs-site pattern,
attendee instructions can remain here. Link the attendee entry point clearly
from the root README.

## Rental reimbursement review

The [current rental scenario guide](rental-ocr-comparison.md) links the synthetic
SOPs for all ten dataset states, the shared evidence standard and expected packet outcomes.
Use the [current agent question](rental-review-agent-question-v2.md) with normalized
Content Understanding claim facts.

The [policy checks workbench flow](policy-checks.md) adds explicit batch review
with five per-case results, reasons and verified PDF citations. Use the
[Agent Framework setup notebook](../infra/policy-agent-framework-setup.ipynb)
and [setup guide](policy-setup.md) to populate an ordinary index on
the existing Search service using managed CU extraction. Compare no policy
retrieval with Search-backed retrieval through one Agent Framework implementation.

The [v2 OCR/table comparison](rental-ocr-comparison.md) adds all ten dataset
states, an Arizona eligibility figure, a Texas table with intentional blanks,
fully scanned Washington PDFs, comparison controls, 32 source-only probes
and a distinct Not applicable outcome. Its
[v2 agent question](rental-review-agent-question-v2.md) expands product/peril
routing and is used by the index-backed Framework agent.

The [original scenario guide](rental-review.md) and
[original agent question](rental-review-agent-question.md) remain historical
references for the retired v1 rule set, not current workbench instructions.

## Packet Markdown representation

Policy checks use the packet's grouped field values with YAML frontmatter,
without raw document text or extraction metadata. The results toolbar no longer
includes a Markdown copy button.
See the [packet Markdown and JSON formats](packet-json.md) for the representation
and its relationship to the rental review agent.
