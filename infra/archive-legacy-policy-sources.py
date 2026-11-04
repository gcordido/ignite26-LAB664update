"""Archive superseded rental sources without changing PDF bytes or historical metadata."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parents[1]
CORPUS = Path("data/policies/rental/ocr-comparison-v2")
ARCHIVE = Path("data/policies/archive/legacy-rental-review-v2")
RETIRED_ROLES = {"rental_terms", "state_sop", "shared_standard"}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def audit_sources(root: Path, manifest: dict, snapshot: dict) -> list[dict]:
    """Verify native Layout evidence against registered bytes, not citation frequency."""
    audit = []
    declarations = [d for d in manifest["documents"] if d.get("role") == "revised_declarations"]
    if len(declarations) != 10 or len({d["states"][0] for d in declarations}) != 10:
        raise ValueError("Expected ten state-specific declarations.")
    for doc in [*declarations, next(d for d in manifest["documents"] if d["documentId"] == "END-02")]:
        registered = next(d for d in snapshot["documents"] if d["documentId"] == doc["documentId"])
        if registered["sha256"] != doc["sha256"] or registered["file"] != doc["pdf"]:
            raise ValueError(f"Native Layout snapshot does not match {doc['documentId']}.")
        pdf = root / CORPUS / doc["pdf"]
        if sha(pdf.read_bytes()) != doc["sha256"]:
            raise ValueError(f"PDF hash mismatch: {doc['pdf']}")
        chunks = [c for c in snapshot["chunks"] if c["documentId"] == doc["documentId"]]
        if not chunks or any(c["sha256"] != doc["sha256"] for c in chunks):
            raise ValueError(f"Missing verified Layout chunks: {doc['documentId']}")
        text = "\n".join(c["content"] for c in chunks)
        scope = doc["policyScope"]
        if any(value not in text for value in scope.values()):
            raise ValueError(f"Native evidence is missing policy/VIN: {doc['documentId']}")
        evidence = {"documentId": doc["documentId"], "sha256": doc["sha256"],
                    "policyScope": scope, "nativeLayoutChunkIds": [c["id"] for c in chunks]}
        if doc in declarations:
            cap = 75 if doc["states"] == ["TX"] else 85
            required = [f"${cap}/day base charge; maximum 30 days",
                        "Mandatory taxes and surcharges are additional to the stated base daily limit."]
            with fitz.open(pdf) as parsed:
                plain = " ".join(page.get_text() for page in parsed)
            for content, requirements in [(text, required), (plain, [
                f"${cap}/day base charge; maximum 30", "days", required[1],
            ])]:
                normalized = re.sub(r"\s+", " ", content)
                if any(value not in normalized for value in [*requirements, *scope.values()]):
                    raise ValueError(f"Missing base-rate/tax/scope authority: {doc['documentId']}")
                if not re.search(r"Policy term: \d{4}-\d{2}-\d{2} through \d{4}-\d{2}-\d{2}", normalized):
                    raise ValueError(f"Missing term: {doc['documentId']}")
            evidence.update(baseDailyLimitUsd=cap, mandatoryTaxesAdditional=True,
                            term=re.search(r"Policy term: ([\d-]+ through [\d-]+)", text).group(1))
        else:
            if any(value not in text for value in [
                "END-02", "February 1, 2026, at 12:01 a.m. Central Time",
                "Issued: 2026-01-30", "applies from the effective date above",
            ]):
                raise ValueError("Texas amendment lacks issued/effective authority.")
            evidence.update(issuedDate="2026-01-30", effectiveFrom=doc["effectiveFrom"])
        audit.append(evidence)
    return audit


def archive(root: Path = ROOT) -> dict:
    corpus, destination = root / CORPUS, root / ARCHIVE
    registry_path = destination / "registry.json"
    if registry_path.exists():
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        for doc in registry["documents"]:
            if sha((root / doc["archivePath"]).read_bytes()) != doc["sha256"]:
                raise ValueError(f"Archived PDF changed: {doc['documentId']}")
        active = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
        if {d["documentId"] for d in active["documents"]} & {
            d["documentId"] for d in registry["documents"]
        }:
            raise ValueError("An archived source was restored to the active manifest.")
        return registry
    manifest_raw = (corpus / "manifest.json").read_bytes()
    citations_raw = (corpus / "citations.json").read_bytes()
    manifest, citations = json.loads(manifest_raw), json.loads(citations_raw)
    snapshot = json.loads((root / ".tools/policy-agent-framework-layout-index.json").read_text(encoding="utf-8"))
    audit = audit_sources(root, manifest, snapshot)
    retired, retained = [], []
    for doc in manifest["documents"]:
        (retired if doc.get("role", doc["documentType"]) in RETIRED_ROLES else retained).append(doc)
    if len(retired) != 21 or len(retained) != 21:
        raise ValueError("Expected 21 retained and 21 archived sources; refusing an incomplete migration.")
    maps = {c["documentId"]: c for c in citations}
    records = []
    for doc in manifest["documents"]:
        if sha((corpus / doc["pdf"]).read_bytes()) != doc["sha256"]:
            raise ValueError(f"PDF changed: {doc['pdf']}")
        cite = maps[doc["documentId"]]
        if any(cite[k] != doc[k] for k in ("documentId", "version", "pdf", "sha256", "ruleIds")):
            raise ValueError(f"Citation registration mismatch: {doc['documentId']}")
    for doc in retired:
        rationale = ("Rental-start eligibility/diagram and legacy rental conditions are not selected checks; "
                     "all ten declarations independently state the narrow base-rate cap, additional "
                     "mandatory taxes, policy/VIN and term."
                     if doc.get("role") == "rental_terms" else
                     "Legacy five-check handling authority (including internal rate bands) is not "
                     "the selected contractual base-rate, effective-terms or repair-estimate authority.")
        records.append({
            "documentId": doc["documentId"], "version": doc["version"], "pdf": doc["pdf"],
            "sha256": doc["sha256"],
            "originalLogicalPath": (CORPUS / doc["pdf"]).as_posix(),
            "archivePath": (ARCHIVE / doc["pdf"]).as_posix(),
            "rationale": rationale, "source": doc, "citation": maps[doc["documentId"]],
        })
    registry = {
        "schemaVersion": 1, "archiveId": "legacy-rental-review-v2",
        "includeInKnowledgeIndex": False,
        "purpose": "Historical citation resolution only; never active ingestion, Search or native warming.",
        "sourceGeneration": {
            "manifestSha256": sha(manifest_raw), "citationsSha256": sha(citations_raw),
            "nativeLayoutIndexFingerprint": snapshot["indexFingerprint"],
            "originalManifest": "original-manifest.json", "originalCitations": "original-citations.json",
        },
        "sourceAudit": {
            "basis": "Existing native Layout chunks plus direct declaration PDF text; no model/paid ingestion.",
            "scope": "Narrow base daily-rate comparison only; no rental-start/eligibility or tax-rate certification.",
            "uniqueArchivedAuthorityRequiredForSelectedChecks": False,
            "documents": audit,
        },
        "documents": records,
    }
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "original-manifest.json").write_bytes(manifest_raw)
    (destination / "original-citations.json").write_bytes(citations_raw)
    for doc in records:
        (root / doc["originalLogicalPath"]).rename(root / doc["archivePath"])
    registry_path.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")
    manifest["documents"] = retained
    manifest["activeChecks"] = ["Daily rate", "Effective terms", "Repair estimate"]
    manifest["archiveRegistry"] = "data/policies/archive/legacy-rental-review-v2/registry.json"
    (corpus / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n",
                                        encoding="utf-8", newline="\r\n")
    retained_ids = {d["documentId"] for d in retained}
    (corpus / "citations.json").write_text(
        json.dumps([c for c in citations if c["documentId"] in retained_ids], indent=2) + "\n",
        encoding="utf-8", newline="\n")
    return registry


if __name__ == "__main__":
    result = archive()
    print(f"21 active sources; {len(result['documents'])} archived PDFs; all 42 original hashes preserved.")
