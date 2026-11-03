# Data

<!-- IGNITE TEMPLATE PLACEHOLDER: remove this folder when the session needs no data files. -->

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

## Rental review policy corpus

The [v2 Search corpus](policies/rental/ocr-comparison-v2/manifest.json) has
41 manifest-listed PDFs: three claim-scoped evidence documents for each of the
ten available packets, plus ten state SOPs and one shared evidence standard.
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

## Saved policy demo

`policy-demo` contains ten real Agent Framework policy reviews of these synthetic
packets, their per-check questions and relevant CU inputs, CU claim fields,
and public resource configuration. It contains no
credentials and isn't policy knowledge or a set of scripted runtime answers.
The results are available on first launch without Azure configuration,
credentials or a restore script. In **Check policies**, select **FoundryIQ**,
then **Load cached results** to load the included **10/10** CU run and all
**50** saved policy checks. **Parse and extract** > **Load cached results**
also loads the included extraction results independently.

The refreshed bundle uses CU run
`76d80507-e191-4354-81f1-dbfe4fa412f9` and records the Search-managed **Standard**
index used for these agent reviews. Its extraction manifest and ten native CU
responses are already tracked under `results/76d80507-e191-4354-81f1-dbfe4fa412f9`.
Keep that run and the complete `policy-demo` folder together when transferring
the repository. No machine-local `.tools` configuration, credentials or Azure
deployment is required to view them. Follow-up chat still requires live setup.

The app validates bundle hashes, claim inputs and citations before loading.
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
