"""Verify the synthetic Texas-only cap revision and preserve all other evidence."""

import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import uuid
import unittest

import pymupdf

spec = importlib.util.spec_from_file_location("policy_cap", Path(__file__).with_name("revise-rental-policy-cap.py"))
cap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cap)
CORPUS = cap.ROOT / "data" / "policies" / "rental" / "ocr-comparison-v2"


class PolicyCapTests(unittest.TestCase):
    def test_texas_75_and_washington_85_are_printed_contract_caps(self):
        for name, amount, identity in (
                ("01-revised-declarations.pdf", 75, "7FARW1H55NA510781"),
                ("declarations-wa-packet-02.pdf", 85, "4S4BTACC1LA511562")):
            with self.subTest(state=name), pymupdf.open(CORPUS / name) as document:
                text = document[0].get_text()
                self.assertIn(f"${amount}/day base charge; maximum 30", text)
                self.assertIn(identity, text)
                self.assertIn("Optional rental code\nRental limit", text)
                self.assertIn("Mandatory taxes and surcharges are additional", text)
                self.assertGreater(len(document[0].get_drawings()), 0)
        questions = json.loads((CORPUS / "scenario-questions.json").read_text(encoding="utf-8"))
        self.assertEqual(questions[0]["questions"][0]["answer"], "$75 per day.")
        self.assertEqual(questions[1]["questions"][0]["answer"], "$85 per day.")
        manifest = json.loads((CORPUS / "manifest.json").read_text(encoding="utf-8"))
        registry = json.loads((cap.ROOT / "data" / "policies" / "archive" /
                               "legacy-rental-review-v2" / "registry.json").read_text(encoding="utf-8"))
        for state, amount in (("TX", "75.00"), ("WA", "60.00")):
            sop = next(doc["source"] for doc in registry["documents"]
                       if doc["documentId"] == f"{state}-RENTAL-002")
            self.assertNotIn(sop["documentId"], {d["documentId"] for d in manifest["documents"]})
            self.assertEqual(sop["routineAuthority"]["dailyBaseRateUsd"], amount)
            self.assertFalse(sop["routineAuthority"]["contractualBenefit"])

    def test_amendment_and_original_illinois_scan_remain_byte_identical(self):
        for name, expected in (
                ("03-scanned-midterm-endorsement.pdf",
                 "03aa4ddd979e1e3a01833b2352033547ab5c9fb32d4395fac0d0f0e3e3f297bc"),
                ("effective-date-il-packet-06.pdf",
                 "8fac5a6e6f0bb865c8019e58acdd126685fae9e590ecbc039a762a0817aebcb5")):
            with self.subTest(file=name):
                self.assertEqual(hashlib.sha256((CORPUS / name).read_bytes()).hexdigest(), expected)

    def test_revision_is_idempotent_and_does_not_rebuild_other_sources(self):
        root = cap.ROOT / ".tools" / f"policy-cap-test-{uuid.uuid4().hex}"
        try:
            corpus = root / "data" / "policies" / "rental" / "ocr-comparison-v2"
            corpus.mkdir(parents=True)
            names = ("01-revised-declarations.pdf", "manifest.json", "citations.json")
            for name in names:
                shutil.copyfile(CORPUS / name, corpus / name)
            before = {name: (corpus / name).read_bytes() for name in names}
            cap.revise(root)
            self.assertEqual(before, {name: (corpus / name).read_bytes() for name in names})
            self.assertEqual(set(before), {path.name for path in corpus.iterdir()})
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
