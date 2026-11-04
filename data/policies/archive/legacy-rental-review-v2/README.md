# Historical rental sources

These 21 PDFs are archived, not active policy knowledge:

- Ten rental-terms PDFs, including the former rental-start diagrams.
- Ten legacy state rental-review SOPs.
- The legacy shared five-check evidence standard.

The active corpus is defined only by
[`manifest.json`](../../rental/ocr-comparison-v2/manifest.json): ten declarations,
nine scanned effective-date records, the Texas issued amendment, and the two-page
synthetic repair-review diagram. Do not recursively ingest this archive,
`editable/`, `controls/`, scenarios, or answer guides.

## Preserved evidence

[`registry.json`](registry.json) records each original logical path, document
version, SHA-256, archive path, reason for archival, and original source/citation
metadata. `original-manifest.json` and `original-citations.json` preserve the
complete pre-archive metadata bytes and are themselves hash-registered.
All 42 original PDF hashes are unchanged across the active and archived folders.

The source audit used the existing native Layout extraction and direct PDF text
for all ten declarations. Each declaration states the base daily cap, additional
mandatory taxes and surcharges, policy ID, insured VIN, and policy term.
Texas states $75/day; the other nine states, including Washington, state $85/day.
The issued Texas amendment independently identifies the policy/VIN, issued date,
and effective time. No archived source is uniquely required for the selected
base-rate, effective-terms, or repair-estimate checks.

This is a narrow base-rate comparison, not a rental-eligibility decision or
certification of tax rates. The archived Washington internal $60 handling band
does not replace its retained contractual $85 base-rate limit.

## Historical links and regeneration

Original `/data/policies/rental/ocr-comparison-v2/<filename>.pdf` links resolve
through the registered archive alias only after original manifest/citation and
PDF hash validation. Citation document ID, version, file, rule, heading, and
registered page checks remain strict. Direct archive PDF URLs are not served.
Historical review bundles and citations retain their original meaning.

Layout migration validates the archive registry, preserved metadata hashes,
archived PDF bytes, every original row's identity and page metadata, and the
complete original generation's content fingerprint before pruning registered
archive rows. Unknown or changed rows stop migration. Retained rows still pass
the existing policy-revision and insured-VIN verification checks. Preflight
reports pruned archived documents/chunks separately from reused active chunks.

From the repository root, `python infra\generate-rental-sop-corpus.py` validates
the current active/archive hashes without rewriting or restoring legacy sources.
For an intentional legacy reproduction, use
`python infra\generate-rental-sop-corpus.py --rebuild-legacy-archive`.
It writes only to `reproduced/` in this archive, including legacy editable files,
text controls, fixtures, and probes; it never replaces registered archived PDFs
or the active manifest. Reproduction requires the generator's existing
ReportLab, PyMuPDF, python-docx, and Windows Segoe UI font prerequisites.
