# Data

<!-- IGNITE TEMPLATE PLACEHOLDER: remove this folder when the session needs no data files. -->

Synthetic auto-insurance claim data for this lab, provided as ten complete
claim packets and individual PDFs. All names and claim details are fictional.

## Documents included

- [Roadside membership cards (demo IDs)](documents/packet-01/01-card.pdf)
- [Policy declarations and endorsements](documents/packet-01/02-policy.pdf)
- [Claim forms and assessments](documents/packet-01/03-claim_form.pdf)
- [Police and incident reports](documents/packet-01/04-incident_report.pdf)
- [Repair estimates](documents/packet-01/05-estimate.pdf)
- [Handwritten statements](documents/packet-01/06-handwriting.pdf)
- [Towing invoices](documents/packet-03/07-invoice.pdf),
  [rental invoices](documents/packet-01/07-invoice.pdf), and
  [supporting quotes](documents/packet-08/07-invoice.pdf)
- [Vehicle inspection reports](documents/packet-01/08-inspection.pdf)
- [Supplemental Form 1099-A documents](documents/packet-01/09-form-1099-a.pdf)

## Example repair estimate

<a href="documents/packet-01/05-estimate.pdf">
  <img src="example-repair-estimate.jpg" alt="Example synthetic repair estimate" width="480">
</a>

Select the image to open the sample PDF.
## Rental review policy corpus

Synthetic Texas and Washington rental-review SOPs and a shared evidence standard
are in [`policies/rental/`](policies/rental/manifest.json), with editable DOCX
originals and PDF ingestion copies. See the
[scenario guide](../docs/rental-review.md) and
[recommended agent question](../docs/rental-review-agent-question.md).
Keep claim packets and expected evaluation outcomes separate from policy knowledge.

The separate [v2 OCR/table corpus](policies/rental/ocr-comparison-v2/manifest.json)
covers all ten dataset states. It includes eleven scan-based SOP PDFs, editable
DOCX originals and identical selectable-text controls. See the
[comparison design and limitations](../docs/rental-ocr-comparison.md).
It is not yet deployed; keep its evaluation fixtures and text controls out of
the scan knowledge index.
