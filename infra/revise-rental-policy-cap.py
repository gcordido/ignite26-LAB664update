"""Reproduce the Texas-only synthetic declaration revision without rebuilding other evidence.

Requires the existing corpus-authoring requirements. Keeps the sparse table and
all other declarations, terms, scans, diagrams and claim PDFs unchanged.
"""

import hashlib
import json
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL_SHA256 = "ca6bd9e77a27843718a947be04292f72c56567d3c186092e16ddfe3ac7bde243"


def revise(root=ROOT):
    corpus = root / "data" / "policies" / "rental" / "ocr-comparison-v2"
    pdf = corpus / "01-revised-declarations.pdf"
    with pymupdf.open(pdf) as document:
        page = document[0]
        text = page.get_text()
        if "$75/day base charge; maximum 30" not in text:
            if hashlib.sha256(pdf.read_bytes()).hexdigest() != ORIGINAL_SHA256:
                raise ValueError("Texas declaration differs from the original; refusing an unverified revision.")
            spans = [span for block in page.get_text("dict")["blocks"]
                     for line in block.get("lines", []) for span in line["spans"]
                     if span["text"] == "$85/day base charge; maximum 30"]
            if len(document) != 1 or len(spans) != 1:
                raise ValueError("Expected exactly one Texas declaration daily-limit span.")
            span = spans[0]
            page.add_redact_annot(span["bbox"], fill=(1, 1, 1))
            page.apply_redactions()
            page.insert_text(span["origin"], span["text"].replace("$85/", "$75/"),
                             fontname="helv", fontsize=span["size"])
            temporary = pdf.with_suffix(".revision.pdf")
            document.save(temporary, garbage=4, deflate=True, no_new_id=True)
        else:
            temporary = None
    if temporary:
        temporary.replace(pdf)
    sha256 = hashlib.sha256(pdf.read_bytes()).hexdigest()
    for name in ("manifest.json", "citations.json"):
        path = corpus / name
        value = json.loads(path.read_text(encoding="utf-8"))
        entries = value["documents"] if isinstance(value, dict) else value
        matches = [entry for entry in entries if entry["documentId"] == "DEC-TX-01"]
        if len(matches) != 1 or matches[0]["pdf"] != pdf.name:
            raise ValueError(f"{name}: Texas declaration registration is ambiguous.")
        matches[0]["sha256"] = sha256
        path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8",
                        newline="\r\n" if name == "manifest.json" else "\n")
    print(f"Texas declaration: $75/day base, maximum 30 days; sha256={sha256}.")
    print("END-02 references the declaration limit; its dates, scope and original scan are unchanged.")


if __name__ == "__main__":
    revise()
