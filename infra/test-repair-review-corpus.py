"""Source-only checks for the fictional repair-authority diagram; no cloud calls."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import subprocess
import unittest

import fitz


ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "infra" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SOURCE = load_module("repair_corpus", "generate-repair-review-corpus.py")
EXPECTED = (
    ("TX", 2500), ("WA", 1750), ("AZ", 2500), ("CO", 2500), ("FL", 2000),
    ("IL", 3000), ("LA", 10000), ("CA", 2000), ("NY", 4000), ("OH", 4000),
)


def head_bytes(path: Path) -> bytes:
    relative = path.relative_to(ROOT).as_posix()
    return subprocess.check_output(
        ["git", "--no-pager", "show", f"HEAD:{relative}"], cwd=ROOT,
        stderr=subprocess.PIPE,
    )


def entry_texts(raw: bytes) -> dict[str, str]:
    """Recover exact serialized entry text, without normalizing its whitespace."""
    text = raw.decode("utf-8")
    decoder = json.JSONDecoder()
    entries = {}
    for match in re.finditer(r'\{\s*"documentId"\s*:', text):
        entry, end = decoder.raw_decode(text, match.start())
        entries[entry["documentId"]] = text[match.start():end]
    return entries


class RepairReviewCorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf_path = SOURCE.OUT / SOURCE.PDF_NAME
        cls.manifest_raw = (SOURCE.OUT / "manifest.json").read_bytes()
        cls.citations_raw = (SOURCE.OUT / "citations.json").read_bytes()
        cls.manifest = json.loads(cls.manifest_raw)
        cls.citations = json.loads(cls.citations_raw)

    def test_exact_state_values_and_page_section_mapping(self):
        self.assertEqual(SOURCE.STATES, EXPECTED)
        with fitz.open(self.pdf_path) as pdf:
            self.assertEqual(len(pdf), 2)
            for index, (section, page_number) in enumerate(SOURCE.SECTIONS.items()):
                self.assertEqual(page_number, index + 1)
                page = pdf[index]
                text = page.get_text()
                self.assertIn(section, text)
                self.assertFalse(page.get_images(), "Diagram must not be rasterized.")
                self.assertGreater(len(page.get_drawings()), 40)
                own_states = EXPECTED[index * 5:(index + 1) * 5]
                actual = re.findall(
                    r"([A-Z]{2}) \| REPAIR-\1-01\s+Gross USD <= ([\d,]+\.00)\?",
                    text,
                )
                self.assertEqual(actual, [(s, f"{v:,.2f}") for s, v in own_states])
                self.assertEqual(len(re.findall(r"Gross USD <= [\d,]+\.00\?", text)), 5)
                self.assertNotIn("$", text, "Dollar signs can be transcribed as leading 5s.")
                for state, _ in EXPECTED:
                    self.assertEqual(text.count(f"REPAIR-{state}-01"),
                                     1 if state in dict(own_states) else 0)

    def test_every_page_is_self_contained_and_safe(self):
        required = (
            "Version 1.0", "2024-01-01", "2026-12-31", "inclusive",
            "Gross stated total including tax BEFORE", "deductible/payments",
            "LOSS STATE, not shop state", "Affirmative source confirms none",
            "missing fields are not proof", "Waiting", "Unknown necessary facts",
            "unless contradiction/excess", "Unsupported state",
            "missing, ambiguous or", "outside dates", "ReviewRequired",
            "Satisfied", "NotApplicable", "YES: <= -> S", "NO: > -> R",
            "Compare each distinct relevant quote independently",
            "never sum alternative quotes", "duplicate/supplement relationships",
            "source evidence", "Different quotes are Business rules validation, not failure",
            "any contradiction or established excess", "even if other evidence is missing",
            "Retain the COMPLETE diagram", "extraction/projection",
            "FICTIONAL / SYNTHETIC TRAINING ONLY", "Not law, a coverage cap, denial",
            "payment approval", "Internal routine handling authority only",
            "REPAIR-SCOPE-01", "Unknown state -> W: cite REPAIR-SCOPE-01",
            "no substitute state and no applied threshold",
        )
        with fitz.open(self.pdf_path) as pdf:
            for page in pdf:
                text = " ".join(page.get_text().split())
                for phrase in required:
                    self.assertIn(phrase, text, f"Page {page.number + 1}: {phrase}")

    def test_text_stays_inside_readable_page_bounds(self):
        with fitz.open(self.pdf_path) as pdf:
            for page in pdf:
                self.assertEqual(tuple(page.rect)[2:], SOURCE.PAGE_SIZE)
                for block in page.get_text("dict")["blocks"]:
                    for line in block.get("lines", []):
                        for span in line["spans"]:
                            self.assertGreaterEqual(span["size"], 9)
                            x0, y0, x1, y1 = span["bbox"]
                            self.assertGreaterEqual(x0, 15)
                            self.assertGreaterEqual(y0, 5)
                            self.assertLessEqual(x1, page.rect.width - 15)
                            self.assertLessEqual(y1, page.rect.height - 4)

    def test_registration_hashes_scope_and_local_setup_loader(self):
        manifest_entries = [d for d in self.manifest["documents"]
                            if d["documentId"] == SOURCE.DOCUMENT_ID]
        citation_entries = [d for d in self.citations
                            if d["documentId"] == SOURCE.DOCUMENT_ID]
        self.assertEqual(len(manifest_entries), 1)
        self.assertEqual(len(citation_entries), 1)
        entry, citation = manifest_entries[0], citation_entries[0]
        expected_entry, expected_citation = SOURCE.registrations(
            SOURCE.digest(self.pdf_path.read_bytes()))
        self.assertEqual(entry, expected_entry)
        self.assertEqual(citation, expected_citation)
        self.assertNotIn("policyScope", entry)
        self.assertEqual(entry["documentType"], "repair_review_sop")
        self.assertEqual(entry["role"], "repair_review")
        self.assertEqual(entry["states"], [s for s, _ in EXPECTED])
        self.assertEqual(citation["sections"], SOURCE.SECTIONS)
        expected_rules = {
            state: {"page": index // 5 + 1, "ruleId": f"REPAIR-{state}-01"}
            for index, (state, _) in enumerate(EXPECTED)
        }
        self.assertEqual(entry["stateRules"], expected_rules)
        self.assertEqual(citation["stateRules"], expected_rules)
        self.assertEqual(set(SOURCE.SECTIONS.values()),
                         {rule["page"] for rule in expected_rules.values()})
        with fitz.open(self.pdf_path) as pdf:
            for state, rule in expected_rules.items():
                text = pdf[rule["page"] - 1].get_text()
                self.assertIn(rule["ruleId"], text)
                self.assertIn(next(section for section, page in SOURCE.SECTIONS.items()
                                   if page == rule["page"]), text)
        setup = load_module("repair_source_setup", "setup-policy-index.py")
        sources = setup.load_sources(ROOT)
        loaded = next(d for d in sources["documents"]
                      if d["documentId"] == SOURCE.DOCUMENT_ID)
        self.assertEqual(loaded["ruleIds"],
                         ["REPAIR-SCOPE-01", *[f"REPAIR-{s}-01" for s, _ in EXPECTED]])
        self.assertEqual(loaded["sections"], SOURCE.SECTIONS)

    def test_original_entries_are_byte_preserved_and_all_pdf_hashes_unchanged(self):
        for name in ("manifest.json", "citations.json"):
            path = SOURCE.OUT / name
            previous = head_bytes(path)
            if name == "manifest.json":
                # Git stores LF; .gitattributes explicitly checks this file out CRLF.
                previous = previous.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
            current = path.read_bytes()
            old_entries, new_entries = entry_texts(previous), entry_texts(current)
            for document_id, original in old_entries.items():
                if document_id != SOURCE.DOCUMENT_ID:
                    self.assertEqual(new_entries[document_id], original, document_id)
            if name == "manifest.json":
                previous_manifest = json.loads(previous)
                for key, value in previous_manifest.items():
                    if key != "documents":
                        self.assertEqual(self.manifest[key], value, key)
        original_pdfs = subprocess.check_output(
            ["git", "ls-tree", "-r", "--name-only", "HEAD", "--",
             SOURCE.OUT.relative_to(ROOT).as_posix()], cwd=ROOT,
        ).decode().splitlines()
        checked = 0
        for relative in original_pdfs:
            path = ROOT / relative
            if path.suffix.lower() == ".pdf" and path != self.pdf_path:
                self.assertEqual(SOURCE.digest(path.read_bytes()),
                                 SOURCE.digest(head_bytes(path)), relative)
                checked += 1
        self.assertGreater(checked, 30)

    def test_registry_line_endings(self):
        self.assertIn(b"\r\n", self.manifest_raw)
        self.assertNotIn(b"\n", self.manifest_raw.replace(b"\r\n", b""))
        self.assertNotIn(b"\r", self.citations_raw)
        self.assertTrue(self.manifest_raw.endswith(b"\r\n"))
        self.assertTrue(self.citations_raw.endswith(b"\n"))

    def test_generator_is_byte_idempotent(self):
        paths = (self.pdf_path, SOURCE.OUT / "manifest.json", SOURCE.OUT / "citations.json")
        before = {p: p.read_bytes() for p in paths}
        original_pdfs = {p: SOURCE.digest(p.read_bytes())
                         for p in SOURCE.OUT.rglob("*.pdf") if p != self.pdf_path}
        SOURCE.main()
        SOURCE.main()
        self.assertEqual({p: p.read_bytes() for p in paths}, before)
        self.assertEqual({p: SOURCE.digest(p.read_bytes()) for p in original_pdfs},
                         original_pdfs)


if __name__ == "__main__":
    unittest.main(verbosity=2)
