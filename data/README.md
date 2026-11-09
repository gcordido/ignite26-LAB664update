# Data

Synthetic auto-insurance claim data for this lab, provided as ten complete
claim packets and individual PDFs. All names and claim details are fictional.

## Documents included

- [Roadside membership cards (demo IDs)](documents/packet-01/01-card.pdf)
- [Policy declarations and endorsements](documents/packet-01/02-policy.pdf)
- [Claim forms and assessments](documents/packet-01/03-claim_form.pdf)
- [Police and incident reports](documents/packet-01/04-incident_report.pdf)
- [Repair estimates](documents/packet-01/05-estimate.pdf) and
  [independent second-shop estimates](documents/packet-03/10-estimate-secondary.pdf)
- [Handwritten statements](documents/packet-01/06-handwriting.pdf) and
  [email statements](samples/email-statement.pdf)
- [Towing invoices](documents/packet-03/07-invoice.pdf) and
  [rental invoices](documents/packet-01/07-invoice.pdf)
- [Vehicle inspection reports](documents/packet-01/08-inspection.pdf)
- [Supplemental Form 1099-A documents](documents/packet-01/09-form-1099-a.pdf)

## Example repair estimate

<a href="documents/packet-01/05-estimate.pdf">
  <img src="example-repair-estimate.jpg" alt="Example synthetic repair estimate" width="480">
</a>

Select the image to open the sample PDF.

## Claim policy corpus

The [v2 Search corpus](policies/rental/ocr-comparison-v2/manifest.json) has
42 manifest-listed PDFs: three claim-scoped evidence documents for each of the
ten available packets, plus ten state SOPs, one shared evidence standard and
one synthetic repair-review diagram.
Each claim set contains a sparse declarations table, rental terms with an
eligibility diagram, and a scanned effective-date document. In the Texas and
Washington contracts, Figure R-1 controls eligibility timing; in the other
eight state contracts, the diagram is illustrative and the written clauses
control. The
[scenario questions and expected answers](policies/rental/ocr-comparison-v2/scenario-questions.json)
are for offline verification and are not indexed. No eleventh claim packet is
present in this dataset. See the
[scenario guide](../docs/rental-ocr-comparison.md) and
[recommended agent question](../docs/rental-review-agent-question-v2.md).
Keep claim packets and expected evaluation outcomes separate from policy knowledge.
The new CU Layout Search generation includes these contract PDFs alongside the
existing state and shared SOP evidence; the source index remains unchanged.

Texas's declaration now prints a **$75/day base** contractual cap; Washington
remains **$85/day base**. Their claim invoices remain $54/day and $61/day.
Texas END-02 references the declaration limit rather than printing a separate
amount, so its original scan and effective dates are unchanged. The internal
routine-authority limits remain separate rules even where the amounts coincide.
`infra/revise-rental-policy-cap.py` reproduces this Texas-only PDF revision using
the corpus-authoring environment, preserving the sparse table and other sources.
Packet 06's original Illinois scan is also unchanged: policy ingestion now
verifies an invalid native OCR VIN against the original page image instead of
asking the reviewer to ignore an identity mismatch.

The two-page `synthetic-repair-review-authority-v1.pdf` adds a separate,
fictional internal repair-review SOP, not state law or contractual coverage.
Its diagram compares each relevant quote's stated gross USD total, including
stated tax and before deductible or payments, against an inclusive state
threshold. It uses the claim's loss state and covers loss dates from
2024-01-01 through 2026-12-31, inclusive. Excess means referral, not denial
or payment authorization; quote differences remain in Business rules validation.
`infra/generate-repair-review-corpus.py` reproduces the PDF and registrations
without changing the original claim or policy PDFs. Each state's registered
rule and page appear in both the manifest and citation map.

## Saved policy demo

`policy-demo` contains ten real Agent Framework policy reviews of these synthetic
packets, their per-check questions and relevant saved Parse evidence,
and public resource configuration. It contains no
credentials and isn't policy knowledge or a set of scripted runtime answers.
The results are available on first launch without Azure configuration,
credentials or a restore script. The app automatically loads saved CU results
from `results` and all **40** saved policy comparisons from `policy-demo`.

The refreshed bundle uses CU run
`c12569eb-cf4b-479a-9f57-d6bf57fb5732` and records the verified **CU Layout**
index used for these agent reviews. It reuses the committed extraction manifest
and ten native CU responses in `results` without another claim extraction or
mandatory claim-summary cache. Transfer `results` and `policy-demo` together.
Earlier five-check results and their original Standard-index provenance are
preserved under `policy-demo/history/five-checks`; the previous three-comparison
bundle retains its provenance under `policy-demo/history/three-checks`.
Neither is reinterpreted as a four-check result. No
machine-local `.tools` configuration, credentials or Azure
deployment is required to view them. Follow-up chat still requires live setup.

The app validates bundle hashes, claim inputs and citations before loading.
Parse JSON hashes normalize only Git's LF/CRLF line endings so the same committed
evidence loads on Windows and Linux; original extraction files aren't rewritten.
The exact-byte policy corpus hash retains the registry's CRLF serialization,
enforced by `.gitattributes` on fresh checkouts.
**Bundled demo** identifies these read-only results and their original Search
index. Compatible local live caches take precedence; local configuration and
caches aren't overwritten. `.\infra\policy-demo-cache.ps1` remains optional
maintenance tooling, not a viewing prerequisite. See
[policy setup](../docs/policy-setup.md) for refreshing the bundle.

The SOP corpus includes eleven mixed digital/scanned PDFs, editable DOCX exports
and pre-scan PDF controls. Its Python generator creates the SOP assets from rule
definitions; DOCX exports are not inputs to PDF generation. Controls and DOCX
exports support generation validation and extraction comparisons. Index only the
manifest-listed PDFs, not evaluation fixtures, answer guides or controls. The
retired v1 corpus and its ZIP archive have been removed.
