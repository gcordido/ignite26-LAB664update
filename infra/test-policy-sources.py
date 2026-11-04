"""Offline tests for the audited lean source inventory and historical archive."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "data" / "policies" / "rental" / "ocr-comparison-v2"
ARCHIVE = ROOT / "data" / "policies" / "archive" / "legacy-rental-review-v2"


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


archive = module("source_archive", "archive-legacy-policy-sources.py")
setup = module("source_setup", "setup-policy-index.py")
generator = module("legacy_source_generator", "generate-rental-sop-corpus.py")


class PolicySourceTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((CORPUS / "manifest.json").read_text(encoding="utf-8"))
        self.registry = json.loads((ARCHIVE / "registry.json").read_text(encoding="utf-8"))

    def test_exact_lean_inventory_and_all_original_hashes(self):
        self.assertEqual(self.manifest["activeChecks"],
                         ["Daily rate", "Effective terms", "Repair estimate"])
        self.assertEqual(len(self.manifest["documents"]), 21)
        self.assertEqual(len(self.registry["documents"]), 21)
        self.assertIs(self.registry["includeInKnowledgeIndex"], False)
        original = json.loads((ARCHIVE / "original-manifest.json").read_text(encoding="utf-8"))
        original_citations = json.loads((ARCHIVE / "original-citations.json").read_text(encoding="utf-8"))
        self.assertEqual(len(original["documents"]), 42)
        for kind in ("manifest", "citations"):
            data = (ARCHIVE / f"original-{kind}.json").read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(),
                             self.registry["sourceGeneration"][f"{kind}Sha256"])
        active = {d["documentId"]: d for d in self.manifest["documents"]}
        archived = {d["documentId"]: d for d in self.registry["documents"]}
        self.assertFalse(set(active) & set(archived))
        for doc in original["documents"]:
            registered = archived.get(doc["documentId"])
            path = ROOT / registered["archivePath"] if registered else CORPUS / doc["pdf"]
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), doc["sha256"])
            if registered:
                self.assertEqual(registered["originalLogicalPath"],
                                 f"data/policies/rental/ocr-comparison-v2/{doc['pdf']}")
                self.assertEqual(registered["source"], doc)
                self.assertTrue(registered["rationale"])
                self.assertEqual(registered["citation"],
                                 next(c for c in original_citations if c["documentId"] == doc["documentId"]))
                self.assertFalse((CORPUS / doc["pdf"]).exists())
            else:
                self.assertEqual(active[doc["documentId"]], doc)

    def test_actual_native_layout_audit_covers_caps_taxes_policy_vin_term_and_amendment(self):
        original = json.loads((ARCHIVE / "original-manifest.json").read_text(encoding="utf-8"))
        snapshot = json.loads((ROOT / ".tools/policy-agent-framework-layout-index.json").read_text(encoding="utf-8"))
        evidence = archive.audit_sources(ROOT, original, snapshot)
        self.assertEqual(len(evidence), 11)
        for doc in evidence:
            if doc["documentId"] != "END-02":
                self.assertTrue(doc["mandatoryTaxesAdditional"])
                self.assertEqual(doc["baseDailyLimitUsd"], 75 if doc["documentId"] == "DEC-TX-01" else 85)
                self.assertTrue(doc["term"])
            else:
                self.assertEqual(doc["issuedDate"], "2026-01-30")
                self.assertEqual(doc["effectiveFrom"], "2026-02-01T00:01:00-06:00")
        changed = copy.deepcopy(snapshot)
        for chunk in changed["chunks"]:
            if chunk["documentId"] == "DEC-WA-P02":
                chunk["content"] = chunk["content"].replace("$85/day", "$60/day")
        with self.assertRaisesRegex(ValueError, "base-rate"):
            archive.audit_sources(ROOT, original, changed)

    def test_setup_loads_only_active_manifest_and_excludes_all_archived_or_controls(self):
        sources = setup.load_sources(ROOT)
        self.assertEqual(len(sources["documents"]), 21)
        self.assertTrue(all(Path(doc["path"]).parent == CORPUS for doc in sources["documents"]))
        retired_ids = {d["documentId"] for d in self.registry["documents"]}
        self.assertFalse(retired_ids & {d["documentId"] for d in sources["documents"]})

    def test_missing_policy_wrong_hash_and_archive_paths_fail_closed(self):
        root = ROOT / ".tools" / f"policy-source-test-{uuid.uuid4().hex}"
        corpus = root / setup.CORPUS
        corpus.mkdir(parents=True)
        try:
            for doc in self.manifest["documents"]:
                shutil.copyfile(CORPUS / doc["pdf"], corpus / doc["pdf"])
            original_citations = json.loads((CORPUS / "citations.json").read_text(encoding="utf-8"))
            for mode in ("missing", "hash", "archive-path"):
                manifest = copy.deepcopy(self.manifest)
                citations = copy.deepcopy(original_citations)
                if mode == "missing":
                    missing = manifest["documents"].pop(0)
                    citations = [c for c in citations if c["documentId"] != missing["documentId"]]
                elif mode == "hash":
                    manifest["documents"][0]["sha256"] = "0" * 64
                else:
                    manifest["documents"][0]["pdf"] = "../../archive/legacy-rental-review-v2/01.pdf"
                (corpus / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                (corpus / "citations.json").write_text(json.dumps(citations), encoding="utf-8")
                with self.subTest(mode=mode), self.assertRaises(setup.SetupError):
                    setup.load_sources(root)
        finally:
            shutil.rmtree(root)

    def test_default_legacy_generator_and_archive_reruns_never_restore_sources(self):
        paths = [CORPUS / "manifest.json", CORPUS / "citations.json",
                 ARCHIVE / "registry.json", ARCHIVE / "original-manifest.json",
                 ARCHIVE / "original-citations.json"]
        before = {p: p.read_bytes() for p in paths}
        with patch.object(generator, "build_document", side_effect=AssertionError("Must not regenerate legacy PDFs")):
            generator.main()
            generator.main()
        archive.archive()
        self.assertEqual(before, {p: p.read_bytes() for p in paths})
        self.assertEqual(len(list(CORPUS.glob("*.pdf"))), 21)
        self.assertEqual(len(list(ARCHIVE.glob("*.pdf"))), 21)

    def test_explicit_legacy_reproduction_is_confined_to_archive(self):
        root = ROOT / ".tools" / f"policy-legacy-generator-test-{uuid.uuid4().hex}"
        corpus, destination = root / archive.CORPUS, root / archive.ARCHIVE
        corpus.mkdir(parents=True)
        destination.mkdir(parents=True)
        try:
            for name in ("manifest.json", "citations.json"):
                shutil.copyfile(CORPUS / name, corpus / name)
            shutil.copyfile(ARCHIVE / "registry.json", destination / "registry.json")
            for doc in self.manifest["documents"]:
                shutil.copyfile(CORPUS / doc["pdf"], corpus / doc["pdf"])
            for doc in self.registry["documents"]:
                shutil.copyfile(ROOT / doc["archivePath"], root / doc["archivePath"])
            before = {p: p.read_bytes() for p in corpus.iterdir()}
            outputs = []

            def build(*_args):
                outputs.append(generator.OUT)
                return "0" * 64, "1" * 64

            with patch.object(generator, "ROOT", root), patch.object(generator, "OUT", corpus), \
                    patch.object(generator, "build_document", side_effect=build), \
                    patch.object(generator, "expected_fixture", return_value={}), \
                    patch.object(generator, "validate"):
                generator.main(legacy_archive=True)
            self.assertEqual(len(outputs), 11)
            self.assertEqual(set(outputs), {destination / "reproduced"})
            reproduced = json.loads((destination / "reproduced" / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(len(reproduced["documents"]), 11)
            self.assertEqual(before, {p: p.read_bytes() for p in corpus.iterdir()})
            self.assertFalse((root / "data" / "scenarios").exists())
        finally:
            shutil.rmtree(root)


if __name__ == "__main__":
    unittest.main(verbosity=2)
