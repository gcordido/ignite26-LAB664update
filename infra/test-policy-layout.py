"""Offline regression coverage for isolated CU Layout deployment."""

import copy
import importlib.util
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


layout = load("policy_layout", "setup-policy-layout.py")
fixtures = load("policy_fixtures", "test-policy-index.py")


def chunks(doc):
    return [{
        "id": f"{doc['documentId']}-{page}", "content": f"Verified layout page {page}",
        **{key: doc[key] for key in ("stateCodes", "documentId", "version", "file", "ruleIds", "sha256")},
        "section": section, "page": page,
    } for section, page in doc["sections"].items()]


class Azure(fixtures.FakeAzure):
    def __init__(self):
        super().__init__()
        self.rows = {}
        self.fail_upload = False

    def _search(self, method, url, body):
        path = urlsplit(url).path.split("/")
        name = path[2]
        if len(path) == 3:
            if method == "GET":
                return (200, self.objects[name], {}) if name in self.objects else (404, None, {})
            if method == "PUT":
                self.objects[name] = copy.deepcopy(body)
                self.rows[name] = []
                return 201, body, {}
        if path[-1] == "search":
            rows = self.rows[name]
            if body.get("filter"):
                rows = [r for r in rows if r["documentId"] in body["filter"]]
            return 200, {"value": copy.deepcopy(rows[body.get("skip", 0):][:body["top"]])}, {}
        if path[-1] == "index":
            if self.fail_upload:
                return 403, {"error": {"message": "upload denied"}}, {}
            for row in body["value"]:
                self.rows[name].append({k: v for k, v in row.items() if not k.startswith("@")})
            return 200, {"value": [{"status": True} for _ in body["value"]]}, {}
        raise AssertionError((method, url))


class LayoutTests(unittest.TestCase):
    def setUp(self):
        self.root = fixtures.make_root()
        self.addCleanup(shutil.rmtree, self.root)
        self.http = Azure()
        self.sources = layout.setup.load_sources(self.root)
        self.before = (self.root / layout.setup.CONFIG_PATH).read_bytes()
        self.extraction = patch.object(layout, "layout", side_effect=lambda http, doc, settings, root: chunks(doc))
        self.extract = self.extraction.start()
        self.addCleanup(self.extraction.stop)

    def run_setup(self, *args):
        return layout.run(layout.parser().parse_args(list(args)), http=self.http, root=self.root)

    def test_fresh_preflight_is_read_only_without_extraction_or_activation(self):
        report = self.run_setup("--index-name", "isolated-index")
        self.assertEqual(report["status"], "preflight")
        self.assertEqual(len(report["newDocuments"]), 3)
        self.extract.assert_not_called()
        self.assertTrue(all(method == "GET" for method, _ in self.http.calls))
        self.assertEqual((self.root / layout.setup.CONFIG_PATH).read_bytes(), self.before)

    def test_fresh_apply_populates_all_sources_and_reuses_target_on_rerun(self):
        result = self.run_setup("--apply", "--index-name", "isolated-index")
        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["documents"], 3)
        self.assertEqual(result["chunks"], 9)
        config = layout.setup.read_json(self.root / layout.setup.CONFIG_PATH)
        self.assertEqual(config["indexName"], "isolated-index")
        self.assertEqual(config["extractionMode"], "layout")
        self.assertEqual(layout.setup.read_json(self.root / layout.setup.BACKUP_PATH)["indexName"], "legacy-index")
        writes = [c for c in self.http.calls if c[0] == "PUT" or "/docs/index?" in c[1]]
        result = self.run_setup("--apply")
        self.assertEqual(result["indexName"], "isolated-index")
        self.assertEqual(writes, [c for c in self.http.calls if c[0] == "PUT" or "/docs/index?" in c[1]])
        self.assertFalse(any(c[0] == "DELETE" for c in self.http.calls))

    def source(self):
        self.http.objects["source-index"] = {"fields": layout.layout_fields()}
        self.http.rows["source-index"] = [
            {**row, "corpusHash": "a" * 64, "indexFingerprint": "b" * 64}
            for doc in self.sources["documents"] for row in chunks(doc)
        ]

    def test_source_is_only_read_and_reused_without_extraction(self):
        self.source()
        original = copy.deepcopy(self.http.rows["source-index"])
        self.run_setup("--apply", "--source-index", "source-index", "--index-name", "isolated-index")
        self.extract.assert_not_called()
        self.assertEqual(self.http.rows["source-index"], original)
        self.assertTrue(all(method in ("GET", "POST") and "/docs/index?" not in url
                            for method, url in self.http.calls if "/indexes/source-index" in url))

    def test_source_cannot_be_target(self):
        with self.assertRaisesRegex(layout.setup.SetupError, "cannot be overwritten"):
            self.run_setup("--apply", "--source-index", "source-index", "--index-name", "source-index")
        self.assertFalse(self.http.calls)

    def test_failed_upload_preserves_runtime_configuration(self):
        self.http.fail_upload = True
        with self.assertRaisesRegex(layout.setup.SetupError, "upload denied"):
            self.run_setup("--apply", "--index-name", "isolated-index")
        self.assertEqual((self.root / layout.setup.CONFIG_PATH).read_bytes(), self.before)

    def test_foreign_target_is_not_overwritten(self):
        self.http.objects["isolated-index"] = {"description": "shared index"}
        with self.assertRaises(layout.setup.ConflictError):
            self.run_setup("--apply", "--index-name", "isolated-index")
        self.assertFalse(any(method == "PUT" or "/docs/index?" in url for method, url in self.http.calls))
        self.assertEqual((self.root / layout.setup.CONFIG_PATH).read_bytes(), self.before)

    def test_drifted_rows_are_not_repopulated(self):
        self.run_setup("--apply", "--index-name", "isolated-index")
        self.http.rows["isolated-index"][0]["content"] = "Changed externally"
        self.http.calls.clear()
        before = (self.root / layout.setup.CONFIG_PATH).read_bytes()
        with self.assertRaises(layout.setup.ConflictError):
            self.run_setup("--apply")
        self.assertFalse(any(method == "PUT" or "/docs/index?" in url for method, url in self.http.calls))
        self.assertEqual((self.root / layout.setup.CONFIG_PATH).read_bytes(), before)

    def test_partial_matching_upload_is_resumed_without_replacing_rows(self):
        self.run_setup("--apply", "--index-name", "isolated-index")
        self.http.rows["isolated-index"].pop()
        result = self.run_setup("--apply")
        self.assertEqual(result["chunks"], 9)

    def test_invalid_target_name_fails_before_network(self):
        with self.assertRaises(layout.setup.SetupError):
            self.run_setup("--apply", "--index-name", "../shared")
        self.assertFalse(self.http.calls)

    def test_missing_claim_analyzer_requires_explicit_creation_and_preflight_never_creates(self):
        self.http.analyzer = None
        with self.assertRaises(layout.setup.SetupError):
            self.run_setup("--index-name", "isolated-index")
        self.http.calls.clear()
        report = self.run_setup("--create-claim-analyzer", "--index-name", "isolated-index")
        self.assertEqual(report["status"], "preflight")
        self.assertIsNone(self.http.analyzer)
        self.assertTrue(all(method == "GET" for method, _ in self.http.calls))
        with patch.object(layout.setup.time, "sleep"):
            result = self.run_setup("--apply", "--create-claim-analyzer", "--index-name", "isolated-index")
        self.assertEqual(result["status"], "verified")
        self.assertEqual(self.http.analyzer["status"], "ready")


if __name__ == "__main__":
    unittest.main()
