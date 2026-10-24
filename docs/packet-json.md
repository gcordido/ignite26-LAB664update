# Packet Markdown and standard JSON

The workbench generates a field-only Markdown representation for policy checks.
It covers the entire packet, not just the active document-type tab, visible
columns or first document. The results toolbar no longer includes a Markdown
copy button. The existing native CU JSON download remains unchanged.

## Markdown with YAML frontmatter

The representation is a Markdown document beginning with YAML frontmatter
between `---` delimiters. Quoted keys and JSON-escaped scalar strings are valid
YAML; dates are quoted to avoid implicit type conversion.

The frontmatter contains the title, packet ID, and grouped field values:
customer, vehicles, damage and incident, policy, rental, repair, towing,
supplemental tax, and other extracted details. Only populated fields and groups
are emitted. No source, confidence, page, region, polygon, analyzer or run metadata
is included in the Markdown. Separate entries are retained rather than combining different vehicles
or people simply because their field names match. Tax fields stay in a separate
supplemental group rather than being mistaken for the insured vehicle.

The visible body highlights the same key field values under category headings.
The original document Markdown and raw text are not included. Details that exist
only in that text are not inferred into structured fields. This is a deterministic
field summary, not an LLM-authored narrative.

Missing/null values, empty strings and empty collections are omitted from the
summary; zero and false are preserved. The underlying JSON and native CU response
retain their original missing-value handling. Author metadata is not invented.
Rendered frontmatter visibility depends on the Markdown viewer.

The endpoint returns this string as `packetMarkdown`. The original versioned
representation is still returned as `packetJson` by the existing
session-scoped `GET /api/packet/:packetId` endpoint. It is generated locally
from saved CU fields, with no Azure analysis or LLM call on copy or selection.
After an explicit **Run policy checks**, the Markdown also includes saved fields
from the separate packet-level claim-summary analyzer: loss routing, insured and
rental vehicle roles, policy limits, actual repair timing and authorizations.
These fields are reused across both policy modes. Missing values remain unknown.
The `packetJson` evidence export and native download retain the original routed
analysis; the enriched `packetMarkdown` is the policy agent's input.

## Structure

| Property | Meaning |
|---|---|
| `schema_version` | `"1.0"` identifies this workbench export format |
| `kind` | `"content_understanding_packet"` |
| `packet_id` | Selected input packet ID |
| `source` | Source PDF file, page count and SHA-256 from the run's input manifest |
| `analysis` | Source run ID, analyzer, API version, CU creation time and operation status |
| `notes` | Evidence-use and missing-data limitations |
| `extracted_text` | CU's full extracted packet Markdown, or null if absent |
| `documents` | Every top-level CU-classified segment, in page order |
| `documents[].pages` | Original PDF start/end page |
| `documents[].category` | Category returned by CU, not an authored expected label |
| `documents[].classification_confidence` | Supplied CU confidence, or null |
| `documents[].extracted_text` | Segment Markdown, including text with no structured extraction |
| `documents[].extractions` | All routed extraction results associated with this segment, including nested child analyzers |
| `extractions[].fields` | Native field names with plain values; nested objects and arrays are preserved |
| `extractions[].evidence` | Flattened field paths, values, present/missing status, confidence, source and page polygons |

Regions use original PDF page numbers and polygons normalized to page dimensions.
Missing structured scalar values are `null`, not zero or empty strings.
An explicitly extracted empty string, `false`, zero or empty array is retained.
A segment without structured extraction still has its category, page range and
extracted text, with an empty `extractions` array.

For example, a rental invoice's CU money object becomes:

```json
{
  "TotalAmount": {
    "Amount": 237.6,
    "CurrencyCode": "USD"
  }
}
```

Its evidence remains separate under field paths such as `TotalAmount.Amount`.
Amounts are JSON numbers directly from CU, without formatted currency strings or
invented currency defaults. Downstream financial calculations should use decimal
arithmetic.

## Using the export with the rental agent

Paste the copied Markdown alongside the
[current rental review question](rental-review-agent-question-v2.md).
Before policy preparation, state, coverage, downtime and authorization may only
appear in the original extracted text, which is deliberately excluded from the
copied summary. The policy batch extracts those facts into structured fields
instead of copying raw document text or inferring them from reference labels.
Only populated structured field values are copied; missing facts are not inferred.

The export does not copy authored claim IDs, expected repair answers, expected
document labels, review fixtures or policy decisions into extracted facts.
It retains all extracted documents, including potentially unrelated ones, so
the agent must distinguish insured and rental vehicles and exclude irrelevant
evidence. Copied content can include personal or tax fields present in the
packet; only paste it into an appropriately authorized destination.

If packet review or export validation fails, the copy button is unavailable
and the packet shows a warning. Native saved JSON remains available for
inspection. The export is not written back into the saved raw CU response.
