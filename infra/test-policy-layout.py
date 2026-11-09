"""Offline regression coverage for isolated CU Layout deployment."""

import copy
import importlib.util
import json
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

    def test_discovered_model_name_is_distinct_from_deployment_name(self):
        self.run_setup("--apply", "--model-deployment", "lab-policy-model",
                       "--cu-model-name", "gpt-5.2", "--index-name", "isolated-index")
        config = layout.setup.read_json(self.root / layout.setup.CONFIG_PATH)
        self.assertEqual(config["modelDeployment"], "lab-policy-model")
        self.assertEqual(config["cuModelName"], "gpt-5.2")

    def test_discovery_does_not_inherit_index_names_from_another_search_service(self):
        layout.setup.atomic_json(self.root / layout.setup.DEPLOYMENT_PATH, {
            **fixtures.RESOURCES, "layoutSourceIndex": "foreign-source",
            "layoutIndexName": "foreign-target",
        })
        report = self.run_setup(
            "--search-resource-id",
            f"{fixtures.RESOURCE_ROOT}/Microsoft.Search/searchServices/other-search",
        )
        self.assertIsNone(report["sourceIndex"])
        self.assertIsNone(report["targetIndex"])
        self.assertFalse(any("foreign-" in url for _, url in self.http.calls))
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

    def archived_source(self):
        self.source()
        corpus = self.root / layout.setup.CORPUS
        folder = self.root / "data" / "policies" / "archive" / "legacy-rental-review-v2"
        folder.mkdir(parents=True)
        manifest_raw = (corpus / "manifest.json").read_bytes()
        citations_raw = (corpus / "citations.json").read_bytes()
        manifest, citations = json.loads(manifest_raw), json.loads(citations_raw)
        retired = manifest["documents"].pop(0)
        citation = next(c for c in citations if c["documentId"] == retired["documentId"])
        fingerprint = layout.layout_generation(
            self.http.rows["source-index"], self.sources["corpusHash"],
            {"searchEndpoint": fixtures.SEARCH_ENDPOINT})
        for row in self.http.rows["source-index"]:
            row["indexFingerprint"] = fingerprint
            row["corpusHash"] = self.sources["corpusHash"]
        registry = {
            "schemaVersion": 1, "archiveId": "legacy-rental-review-v2", "includeInKnowledgeIndex": False,
            "sourceGeneration": {
                "manifestSha256": layout.setup.sha256_hex(manifest_raw),
                "citationsSha256": layout.setup.sha256_hex(citations_raw),
                "nativeLayoutIndexFingerprint": fingerprint,
                "originalManifest": "original-manifest.json", "originalCitations": "original-citations.json",
            },
            "documents": [{
                **{k: retired[k] for k in ("documentId", "version", "pdf", "sha256")},
                "originalLogicalPath": f"data/policies/rental/ocr-comparison-v2/{retired['pdf']}",
                "archivePath": f"data/policies/archive/legacy-rental-review-v2/{retired['pdf']}",
                "rationale": "Unselected legacy source.", "source": retired, "citation": citation,
            }],
        }
        (folder / "original-manifest.json").write_bytes(manifest_raw)
        (folder / "original-citations.json").write_bytes(citations_raw)
        layout.setup.atomic_json(folder / "registry.json", registry)
        (corpus / retired["pdf"]).rename(folder / retired["pdf"])
        layout.setup.atomic_json(corpus / "manifest.json", manifest)
        layout.setup.atomic_json(corpus / "citations.json",
                                [c for c in citations if c["documentId"] != retired["documentId"]])
        self.sources = layout.setup.load_sources(self.root)
        return folder, registry

    def test_registered_archive_preflight_prunes_only_verified_rows_without_extraction(self):
        self.archived_source()
        original = copy.deepcopy(self.http.rows["source-index"])
        result = self.run_setup("--source-index", "source-index", "--index-name", "isolated-index")
        self.assertEqual(result["prunedArchivedChunks"], 3)
        self.assertEqual(result["prunedArchivedDocumentCount"], 1)
        self.assertEqual(result["prunedArchivedDocuments"], ["TX-RENTAL-002"])
        self.assertEqual(result["reusedChunks"], 6)
        self.assertEqual(result["newDocuments"], [])
        self.extract.assert_not_called()
        self.assertEqual(self.http.rows["source-index"], original)
        self.assertEqual((self.root / layout.setup.CONFIG_PATH).read_bytes(), self.before)
        self.assertTrue(all(method == "GET" or "/docs/search?" in url for method, url in self.http.calls))

    def test_registered_archive_apply_preserves_old_index_and_writes_only_active_rows(self):
        self.archived_source()
        original = copy.deepcopy(self.http.rows["source-index"])
        result = self.run_setup("--apply", "--source-index", "source-index", "--index-name", "isolated-index")
        self.assertEqual(result["prunedArchivedChunks"], 3)
        self.assertEqual(result["chunks"], 6)
        self.assertEqual(result["documents"], 2)
        self.extract.assert_not_called()
        self.assertEqual(self.http.rows["source-index"], original)
        self.assertEqual({row["documentId"] for row in self.http.rows["isolated-index"]},
                         {doc["documentId"] for doc in self.sources["documents"]})

    def test_archive_pruning_rejects_unknown_metadata_generation_and_content_drift(self):
        self.archived_source()
        original = copy.deepcopy(self.http.rows["source-index"])
        mutations = [
            {"documentId": "UNKNOWN"}, {"version": "wrong"}, {"file": "foreign.pdf"},
            {"sha256": "c" * 64}, {"stateCodes": ["WA"]}, {"ruleIds": ["WRONG"]},
            {"page": 99}, {"section": "wrong"}, {"corpusHash": "c" * 64},
            {"indexFingerprint": "c" * 64}, {"content": "Altered archived extraction"},
            {"id": "altered-chunk-key"}, {"extra": "unexpected"},
        ]
        for mutation in mutations:
            self.http.rows["source-index"] = copy.deepcopy(original)
            self.http.rows["source-index"][0].update(mutation)
            with self.subTest(mutation=mutation), self.assertRaises(layout.setup.SetupError):
                self.run_setup("--source-index", "source-index", "--index-name", "isolated-index")
        self.http.rows["source-index"] = copy.deepcopy(original)
        self.http.rows["source-index"][-1]["content"] = "Altered retained extraction"
        with self.assertRaisesRegex(layout.setup.SetupError, "content fingerprint"):
            self.run_setup("--source-index", "source-index", "--index-name", "isolated-index")
        self.extract.assert_not_called()
        self.assertEqual((self.root / layout.setup.CONFIG_PATH).read_bytes(), self.before)

    def test_archive_pruning_rejects_registry_original_metadata_and_pdf_drift(self):
        folder, registry = self.archived_source()
        for mutation in [
            {"archivePath": "../doc0.pdf"}, {"originalLogicalPath": "foreign/doc0.pdf"},
            {"sha256": "c" * 64}, {"version": "wrong"},
            {"citation": {**registry["documents"][0]["citation"], "sections": {"wrong": 1}}},
            {"source": {**registry["documents"][0]["source"], "states": ["WA"]}},
        ]:
            changed = copy.deepcopy(registry)
            changed["documents"][0].update(mutation)
            layout.setup.atomic_json(folder / "registry.json", changed)
            with self.subTest(mutation=mutation), self.assertRaises(layout.setup.SetupError):
                self.run_setup("--source-index", "source-index", "--index-name", "isolated-index")
        layout.setup.atomic_json(folder / "registry.json", registry)
        old_citations = (folder / "original-citations.json").read_bytes()
        (folder / "original-citations.json").write_bytes(b"[]")
        with self.assertRaisesRegex(layout.setup.SetupError, "metadata hash"):
            self.run_setup("--source-index", "source-index", "--index-name", "isolated-index")
        (folder / "original-citations.json").write_bytes(old_citations)
        (folder / registry["documents"][0]["pdf"]).write_bytes(b"tampered archived PDF")
        with self.assertRaisesRegex(layout.setup.SetupError, "archived PDF hash"):
            self.run_setup("--source-index", "source-index", "--index-name", "isolated-index")
        self.extract.assert_not_called()

    def test_archive_pruning_preserves_active_invalid_vin_reread(self):
        folder, registry = self.archived_source()
        for row in self.http.rows["source-index"]:
            if row["documentId"] == "WA-RENTAL-002":
                row["content"] = "VEHICLE IDENTIFICATION NUMBER\n1FMCUOG63MA514686"
        fingerprint = layout.layout_generation(
            self.http.rows["source-index"], registry["sourceGeneration"]["manifestSha256"],
            {"searchEndpoint": fixtures.SEARCH_ENDPOINT})
        registry["sourceGeneration"]["nativeLayoutIndexFingerprint"] = fingerprint
        for row in self.http.rows["source-index"]:
            row["indexFingerprint"] = fingerprint
        layout.setup.atomic_json(folder / "registry.json", registry)
        current = copy.deepcopy(self.sources)
        next(doc for doc in current["documents"] if doc["documentId"] == "WA-RENTAL-002")[
            "documentType"] = "policy_contract"
        with patch.object(layout.setup, "load_sources", return_value=current):
            report = self.run_setup("--source-index", "source-index", "--index-name", "isolated-index")
        self.assertEqual(report["prunedArchivedChunks"], 3)
        self.assertEqual(report["reusedChunks"], 3)
        self.assertEqual(report["vinVerificationDocuments"], ["WA-RENTAL-002"])
        self.assertEqual(report["newDocuments"], ["doc1.pdf"])
        self.extract.assert_not_called()

    def test_changed_registered_policy_is_reextracted_without_changing_source(self):
        self.sources["documents"][0]["documentType"] = "policy_contract"
        self.source()
        original = copy.deepcopy(self.http.rows["source-index"])
        revised = copy.deepcopy(self.sources)
        revised["documents"][0]["sha256"] = "c" * 64
        revised["corpusHash"] = "d" * 64
        with patch.object(layout.setup, "load_sources", return_value=revised):
            report = self.run_setup("--source-index", "source-index", "--index-name", "isolated-index")
            self.extract.assert_not_called()
            self.assertEqual(report["revisedDocuments"], [revised["documents"][0]["documentId"]])
            self.assertEqual(report["reusedChunks"], 6)
            self.run_setup("--apply", "--source-index", "source-index", "--index-name", "isolated-index")
        self.assertEqual(self.extract.call_count, 1)
        self.assertEqual(self.extract.call_args.args[1], revised["documents"][0])
        self.assertEqual(self.http.rows["source-index"], original)
        self.assertEqual(len(self.http.rows["isolated-index"]), 9)

    def test_policy_revision_does_not_allow_unrelated_metadata_drift(self):
        self.sources["documents"][0]["documentType"] = "policy_contract"
        self.source()
        for row in self.http.rows["source-index"]:
            if row["documentId"] == self.sources["documents"][0]["documentId"]:
                row["sha256"] = "c" * 64
        self.http.rows["source-index"][0]["file"] = "foreign-policy.pdf"
        with patch.object(layout.setup, "load_sources", return_value=self.sources):
            with self.assertRaisesRegex(layout.setup.SetupError, "inconsistent file"):
                self.run_setup("--apply", "--source-index", "source-index", "--index-name", "isolated-index")
        self.extract.assert_not_called()

    def test_sop_hash_drift_is_not_silently_replaced(self):
        self.source()
        self.http.rows["source-index"][0]["sha256"] = "c" * 64
        with self.assertRaisesRegex(layout.setup.SetupError, "inconsistent sha256"):
            self.run_setup("--apply", "--source-index", "source-index", "--index-name", "isolated-index")
        self.extract.assert_not_called()

    def test_invalid_policy_vin_triggers_only_that_document_reread(self):
        self.sources["documents"][0]["documentType"] = "policy_contract"
        self.source()
        self.http.rows["source-index"][0]["content"] = "VEHICLE IDENTIFICATION NUMBER\n1FMCUOG63MA514686"
        original = copy.deepcopy(self.http.rows["source-index"])
        with patch.object(layout.setup, "load_sources", return_value=self.sources):
            result = self.run_setup("--apply", "--source-index", "source-index", "--index-name", "isolated-index")
        self.assertEqual(result["vinVerificationDocuments"], [self.sources["documents"][0]["documentId"]])
        self.assertEqual(self.extract.call_count, 1)
        self.assertEqual(self.http.rows["source-index"], original)

    def test_source_cannot_be_target(self):
        with self.assertRaisesRegex(layout.setup.SetupError, "cannot be overwritten"):
            self.run_setup("--apply", "--source-index", "source-index", "--index-name", "source-index")
        self.assertFalse(self.http.calls)

    def test_failed_upload_preserves_runtime_configuration(self):
        self.http.fail_upload = True
        with self.assertRaisesRegex(layout.setup.SetupError, "upload denied"):
            self.run_setup("--apply", "--index-name", "isolated-index")
        self.assertEqual((self.root / layout.setup.CONFIG_PATH).read_bytes(), self.before)

    def test_empty_search_403_identifies_operation_and_request(self):
        error = layout.request_error(
            "GET", "https://test-search.search.windows.net/indexes/test?api-version=preview",
            403, None, {"X-Ms-Request-Id": "test-request"},
        )
        self.assertIn("Azure AI Search GET https://test-search.search.windows.net/indexes/test", error)
        self.assertIn("request ID: test-request", error)
        self.assertIn("Search data-plane permissions", error)
        self.assertNotIn("api-version", error)

    def test_empty_cu_403_identifies_analyze_permissions(self):
        error = layout.request_error(
            "POST", "https://test-foundry.services.ai.azure.com/contentunderstanding/analyzers/prebuilt-layout:analyzeBinary",
            403, None, {},
        )
        self.assertIn("Content Understanding POST", error)
        self.assertIn("CU analyze permissions", error)

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

    def test_default_setup_ignores_saved_summary_and_activates_without_analyzer(self):
        for analyzer_id in ("lab664_policy_checks_claim_summary", "custom_existing_claims"):
            with self.subTest(analyzer_id=analyzer_id):
                layout.setup.atomic_json(self.root / layout.setup.DEPLOYMENT_PATH, {
                    **fixtures.RESOURCES, "claimAnalyzerId": analyzer_id,
                })
                config = json.loads(self.before)
                config["claimAnalyzerHash"] = "a" * 64
                layout.setup.atomic_json(self.root / layout.setup.CONFIG_PATH, config)
                self.http.analyzer = None
                report = self.run_setup("--index-name", "isolated-index")
                self.assertEqual(report["status"], "preflight")
                result = self.run_setup("--apply", "--index-name", "isolated-index")
                self.assertEqual(result["status"], "verified")
                config = layout.setup.read_json(self.root / layout.setup.CONFIG_PATH)
                self.assertNotIn("claimAnalyzerId", config)
                self.assertNotIn("claimAnalyzerHash", config)
                self.assertEqual(config["indexName"], "isolated-index")
                self.assertEqual(config["modelDeployment"], "gpt-5")
                saved = layout.setup.read_json(self.root / layout.setup.DEPLOYMENT_PATH)
                self.assertNotIn("claimAnalyzerId", saved)
                self.assertFalse(any("/contentunderstanding/analyzers/" in url for _, url in self.http.calls))

    def test_default_rerun_preserves_active_summary_metadata_without_analyzer_calls(self):
        self.run_setup("--apply", "--claim-analyzer-id", "claim_summary", "--index-name", "isolated-index")
        before = layout.setup.read_json(self.root / layout.setup.CONFIG_PATH)
        saved = layout.setup.read_json(self.root / layout.setup.DEPLOYMENT_PATH)
        saved["claimAnalyzerId"] = "different_saved_summary"
        layout.setup.atomic_json(self.root / layout.setup.DEPLOYMENT_PATH, saved)
        self.http.analyzer = None
        self.http.calls.clear()
        self.assertEqual(self.run_setup("--apply")["status"], "verified")
        after = layout.setup.read_json(self.root / layout.setup.CONFIG_PATH)
        self.assertEqual(after, before)
        self.assertFalse(any("/contentunderstanding/analyzers/" in url for _, url in self.http.calls))

    def test_fresh_default_setup_activates_without_summary_settings_or_analyzer(self):
        (self.root / layout.setup.CONFIG_PATH).unlink()
        self.http.analyzer = None
        args = ["--model-deployment", "gpt-5", "--index-name", "isolated-index"]
        for key, value in fixtures.RESOURCES.items():
            args.extend(["--" + {"searchResourceId": "search-resource-id",
                                "storageResourceId": "storage-resource-id",
                                "foundryResourceId": "foundry-resource-id"}[key], value])
        self.assertEqual(self.run_setup(*args)["status"], "preflight")
        self.assertEqual(self.run_setup("--apply", *args)["status"], "verified")
        config = layout.setup.read_json(self.root / layout.setup.CONFIG_PATH)
        self.assertNotIn("claimAnalyzerId", config)
        self.assertNotIn("claimAnalyzerHash", config)
        self.assertEqual(config["searchEndpoint"], fixtures.SEARCH_ENDPOINT)
        self.assertEqual(config["azureOpenAIEndpoint"], fixtures.FOUNDRY_ROOT)
        self.assertFalse(any("/contentunderstanding/analyzers/" in url for _, url in self.http.calls))

    def test_missing_explicit_claim_analyzer_requires_creation_and_preflight_never_creates(self):
        self.http.analyzer = None
        with self.assertRaises(layout.setup.SetupError):
            self.run_setup("--claim-analyzer-id", "claim_summary", "--index-name", "isolated-index")
        self.http.calls.clear()
        report = self.run_setup("--create-claim-analyzer", "--index-name", "isolated-index")
        self.assertEqual(report["status"], "preflight")
        self.assertIsNone(self.http.analyzer)
        self.assertTrue(all(method == "GET" for method, _ in self.http.calls))
        with patch.object(layout.setup.time, "sleep"):
            result = self.run_setup("--apply", "--create-claim-analyzer", "--index-name", "isolated-index")
        self.assertEqual(result["status"], "verified")
        self.assertEqual(self.http.analyzer["status"], "ready")
        config = layout.setup.read_json(self.root / layout.setup.CONFIG_PATH)
        self.assertEqual(config["claimAnalyzerId"], "claim_summary")
        self.assertEqual(config["claimAnalyzerHash"], layout.setup.analyzer_hash(self.http.analyzer))
        self.http.calls.clear()
        self.run_setup("--apply", "--claim-analyzer-id", "claim_summary", "--index-name", "isolated-index")
        self.assertTrue(any(method == "GET" and "/analyzers/claim_summary?" in url
                            for method, url in self.http.calls))
        self.assertFalse(any(method == "PUT" and "/analyzers/" in url for method, url in self.http.calls))


class VinImageTests(unittest.TestCase):
    def setUp(self):
        self.root = fixtures.make_root()
        self.addCleanup(shutil.rmtree, self.root)
        self.doc = layout.setup.load_sources(self.root)["documents"][0]
        self.settings = {
            "azureOpenAIEndpoint": fixtures.FOUNDRY_ROOT, "modelDeployment": "gpt-5",
        }
        self.text = "VEHICLE IDENTIFICATION NUMBER\n1FMCUOG63MA514686\nPolicy term: 2025-10-06"

    def response(self, vin, legible=True):
        return {"status": "completed", "model": "gpt-5", "output": [{
            "type": "message", "content": [{"type": "output_text",
                                          "text": json.dumps({"legible": legible, "vin": vin})}],
        }]}

    def test_scanned_zero_is_read_from_original_pdf_not_scope_or_replacement(self):
        self.doc["policyScope"] = {"policyId": "NEVER-SEND", "vin": "1FMCU0G61MA514687"}
        with patch.object(layout, "request", return_value=(self.response("1FMCU0G63MA514686"), {})) as call:
            result = layout.verify_policy_vin(None, self.doc, 1, self.text, self.settings, self.root)
            again = layout.verify_policy_vin(None, self.doc, 1, self.text, self.settings, self.root)
        self.assertEqual(call.call_count, 1, "The original source-image response is reused on an identical rerun.")
        self.assertEqual(result, again)
        self.assertIn("1FMCU0G63MA514686", result)
        self.assertNotIn("1FMCUOG63MA514686", result)
        self.assertIn("Policy term: 2025-10-06", result)
        self.assertIn("Policy VIN image verification v1", result)
        body = call.call_args.kwargs["body"]
        self.assertFalse(body["store"])
        self.assertEqual(body["input"][0]["content"][1]["type"], "input_file")
        self.assertNotIn("NEVER-SEND", json.dumps(body))
        self.assertNotIn("1FMCU0G61MA514687", json.dumps(body))
        self.assertNotIn("1FMCUOG63MA514686", json.dumps(body))

    def test_valid_different_vin_is_not_normalized_or_reread(self):
        text = self.text.replace("1FMCUOG63MA514686", "1FMCU0G61MA514687")
        with patch.object(layout, "request") as call:
            self.assertEqual(layout.verify_policy_vin(None, self.doc, 1, text, self.settings, self.root), text)
        call.assert_not_called()

    def test_image_reading_is_not_forced_to_the_registered_or_claim_identity(self):
        with patch.object(layout, "request", return_value=(self.response("1FMCU0G61MA514687"), {})):
            result = layout.verify_policy_vin(None, self.doc, 1, self.text, self.settings, self.root)
        self.assertIn("1FMCU0G61MA514687", result)
        self.assertNotIn("1FMCU0G63MA514686", result)

    def test_uncertain_or_invalid_original_vin_stops_instead_of_waiving_mismatch(self):
        for vin, legible in ((None, False), ("1FMCUOG63MA514686", True)):
            with self.subTest(vin=vin), patch.object(
                    layout, "request", return_value=(self.response(vin, legible), {})):
                with self.assertRaisesRegex(layout.setup.SetupError, "no OCR substitution"):
                    layout.verify_policy_vin(None, self.doc, 1, self.text, self.settings, self.root)
            for cache in (self.root / ".tools" / "policy-layout-cache").glob("vin-*.json"):
                cache.unlink()


if __name__ == "__main__":
    unittest.main()
