"""Offline tests for the Search-managed policy ingestion setup (no Azure calls)."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import io
import json
import shutil
import unittest
import uuid
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location(
    "policy_index_setup", Path(__file__).with_name("setup-policy-index.py"),
)
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)

STATES = ["TX", "WA", "AZ", "CA", "OR", "NV"]
SUBSCRIPTION = "00000000-0000-0000-0000-000000000001"
RESOURCE_ROOT = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/test-lab/providers"
RESOURCES = {
    "searchResourceId": f"{RESOURCE_ROOT}/Microsoft.Search/searchServices/test-search",
    "storageResourceId": f"{RESOURCE_ROOT}/Microsoft.Storage/storageAccounts/teststorage",
    "foundryResourceId": f"{RESOURCE_ROOT}/Microsoft.CognitiveServices/accounts/test-foundry",
}
FOUNDRY_ROOT = "https://test-foundry.services.ai.azure.com"
SEARCH_ENDPOINT = "https://test-search.search.windows.net"


def make_root(count: int = 3) -> Path:
    root = setup.ROOT / ".tools" / f"policy-index-tests-{uuid.uuid4().hex}"
    corpus = root / setup.CORPUS
    corpus.mkdir(parents=True)
    docs, citations = [], []
    for i in range(count):
        shared = i == count - 1
        doc_id = "SHARED-EVIDENCE-002" if shared else f"{STATES[i]}-RENTAL-002"
        name = f"doc{i}.pdf"
        data = f"synthetic pdf {i}".encode()
        (corpus / name).write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        doc = {"documentId": doc_id, "version": "2.0", "pdf": name, "sha256": digest,
               "states": STATES[:3] if shared else [STATES[i]],
               "documentType": "shared_standard" if shared else "state_sop",
               "ruleIds": ["E-01"] if shared else [f"{STATES[i]}-R1"],
               "routineAuthority": {"oracle": "NEVER_INDEX"}}
        docs.append(doc)
        citations.append({"documentId": doc_id, "version": "2.0", "pdf": name, "sha256": digest,
                          "ruleIds": doc["ruleIds"],
                          "sections": {"1. Scope": 1, "2. Matrix": 2, "3. Figure": 3}})
    (corpus / "manifest.json").write_text(json.dumps({"documents": docs}), encoding="utf-8")
    (corpus / "citations.json").write_text(json.dumps(citations), encoding="utf-8")
    (root / ".tools").mkdir(exist_ok=True)
    (root / setup.CONFIG_PATH).write_text(json.dumps({
        "schemaVersion": 1, "provider": "agent-framework", "extractionMode": "layout",
        **RESOURCES,
        "azureOpenAIEndpoint": FOUNDRY_ROOT, "cuEndpoint": FOUNDRY_ROOT,
        "modelDeployment": "gpt-5", "claimAnalyzerId": "claim_summary", "cuApiVersion": "2025-11-01", "indexName": "legacy-index",
    }), encoding="utf-8")
    return root


class FakeAzure:
    """In-memory ARM/Search/Blob responder implementing the Http.request contract."""

    def __init__(self, sources=None, roles_ok=True, run_status="success", failed=0):
        self.sources, self.roles_ok, self.run_status, self.failed = sources, roles_ok, run_status, failed
        self.objects, self.blobs, self.calls, self.runs = {}, {}, [], 0
        self.chunks = []
        self.analyzer = {"status": "ready", **setup.claim_evidence_analyzer_definition()}
        self.search_principal = "search-mi"
        self.caller = "caller-oid"

    def token(self, scope):
        import base64
        payload = base64.urlsafe_b64encode(json.dumps({"oid": self.caller}).encode()).decode().rstrip("=")
        return f"h.{payload}.s"

    def request(self, method, url, scope, body=None, headers=None, raw=None):
        self.calls.append((method, url))
        if "/contentunderstanding/analyzers/" in url:
            if method == "PUT":
                if self.analyzer is not None:
                    return 412, {"error": {"message": "already exists"}}, {}
                self.analyzer = {"status": "ready", **copy.deepcopy(body)}
                return 201, self.analyzer, {}
            if self.analyzer is None:
                return 404, {"error": {"message": "missing"}}, {}
            return 200, self.analyzer, {}
        if "management.azure.com" in url:
            return self._arm(method, url)
        if "blob.core.windows.net" in url:
            return self._blob(method, url, headers or {}, raw)
        return self._search(method, url, body)

    def _arm(self, method, url):
        if "roleAssignments" in url:
            if not self.roles_ok:
                return 200, {"value": []}, {}
            role = {"search-mi": [setup.ROLES["Storage Blob Data Reader"], setup.ROLES["Cognitive Services User"]],
                    "caller-oid": [setup.ROLES["Storage Blob Data Contributor"],
                                   setup.ROLES["Search Service Contributor"],
                                   setup.ROLES["Search Index Data Contributor"]]}
            who = "search-mi" if "search-mi" in url else "caller-oid"
            return 200, {"value": [{"properties": {"scope": "/subscriptions/x" if False else url.split("/providers/Microsoft.Authorization")[0].replace(setup.ARM, ""),
                                                   "roleDefinitionId": f"/x/{r}"}} for r in role[who]]}, {}
        return 200, {"identity": {"principalId": self.search_principal}, "sku": {"name": "standard"},
                     "properties": {}}, {}

    def _blob(self, method, url, headers, raw):
        key = url.split(".net/")[1].split("?")[0]
        if "restype=container" in url:
            return 201, None, {}
        if method == "HEAD":
            if key not in self.blobs:
                return 404, None, {}
            return 200, None, {f"x-ms-meta-{k}": v for k, v in self.blobs[key].items()}
        self.blobs[key] = {k[len("x-ms-meta-"):]: v for k, v in headers.items() if k.startswith("x-ms-meta-")}
        return 201, None, {}

    def _search(self, method, url, body):
        path = url.split(".net/")[1]
        if "/search.status" in path:
            if self.runs == 0:
                return 200, {"status": "idle", "lastResult": None}, {}
            return 200, {"status": "running" if self.run_status == "inProgress" else "idle",
                         "lastResult": {"status": self.run_status, "startTime": f"run-{self.runs}",
                                        "itemsProcessed": len(self.sources["documents"]),
                                        "itemsFailed": self.failed, "errors": []}}, {}
        if "/search.run" in path:
            self.runs += 1
            return 202, None, {}
        if "/search.reset" in path:
            return 204, None, {}
        if "docs/search.post.search" in path:
            if body.get("filter", "").startswith("id gt"):
                return 200, {"value": []}, {}
            if "searchFields" in body:
                allowed = [row for row in self.chunks if row["documentId"] in body.get("filter", "")]
                return 200, {"value": allowed[:1]}, {}
            return 200, {"value": self.chunks}, {}
        name = path.split("'")[1]
        if method == "GET":
            return (200, self.objects[name], {}) if name in self.objects else (404, None, {})
        if method == "PUT":
            self.objects[name] = body
            return 201, body, {}
        return 400, None, {}


def good_chunks(sources, generation):
    rows = []
    for doc in sources["documents"]:
        for n, (page, page_to) in enumerate([(1, 2), (3, 3)]):
            rows.append({"id": f"{doc['documentId']}-{n}", "parentId": doc["documentId"],
                         "content": f"content {n}", "documentId": doc["documentId"],
                         "version": doc["version"], "file": doc["file"], "page": page, "pageTo": page_to,
                         "ordinal": n, "sha256": doc["sha256"], "corpusHash": sources["corpusHash"],
                         "indexFingerprint": generation})
    return rows


class TransportTests(unittest.TestCase):
    def test_progress_is_timestamped_and_flushed_to_stderr(self):
        with patch.object(setup.time, "strftime", return_value="12:34:56"), \
                patch("builtins.print") as output:
            setup.progress("Waiting for indexer")
        output.assert_called_once_with("[12:34:56] Waiting for indexer", file=setup.sys.stderr, flush=True)

    def test_tokens_are_cached_per_scope_until_five_minutes_before_expiry(self):
        credential = Mock()
        credential.get_token.side_effect = [
            SimpleNamespace(token="search-secret", expires_on=2000),
            SimpleNamespace(token="storage-secret", expires_on=3000),
            SimpleNamespace(token="refreshed-secret", expires_on=4000),
        ]
        http = setup.Http(credential=credential)
        with patch.object(setup.time, "time", return_value=1000):
            self.assertEqual(http.token(setup.SEARCH_SCOPE), "search-secret")
            self.assertEqual(http.token(setup.SEARCH_SCOPE), "search-secret")
            self.assertEqual(http.token(setup.STORAGE_SCOPE), "storage-secret")
        self.assertEqual(credential.get_token.call_count, 2)
        with patch.object(setup.time, "time", return_value=1699):
            self.assertEqual(http.token(setup.SEARCH_SCOPE), "search-secret")
        self.assertEqual(credential.get_token.call_count, 2)
        with patch.object(setup.time, "time", return_value=1700):
            self.assertEqual(http.token(setup.SEARCH_SCOPE), "refreshed-secret")
            self.assertEqual(http.token(setup.STORAGE_SCOPE), "storage-secret")
        self.assertEqual(credential.get_token.call_count, 3)
        self.assertEqual([call.args[0] for call in credential.get_token.call_args_list],
                         [setup.SEARCH_SCOPE, setup.STORAGE_SCOPE, setup.SEARCH_SCOPE])

    def test_authentication_failures_are_not_cached_or_reported_as_success(self):
        credential = Mock()
        credential.get_token.side_effect = [
            RuntimeError("CLI timed out"),
            SimpleNamespace(token="secret", expires_on=4000),
        ]
        http = setup.Http(credential=credential)
        output = io.StringIO()
        with redirect_stderr(output), self.assertRaisesRegex(RuntimeError, "CLI timed out"):
            http.token(setup.SEARCH_SCOPE)
        self.assertNotIn("Authentication ready", output.getvalue())
        with patch.object(setup.time, "time", return_value=1000):
            self.assertEqual(http.token(setup.SEARCH_SCOPE), "secret")
        self.assertEqual(credential.get_token.call_count, 2)

    def test_request_logs_status_without_tokens_query_or_document_contents(self):
        credential = Mock()
        credential.get_token.return_value = SimpleNamespace(token="private-token", expires_on=4000)
        response = Mock(status=200, headers={})
        response.read.return_value = b'{"value":[]}'
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        output, stdout = io.StringIO(), io.StringIO()
        with patch.object(setup.time, "time", return_value=1000), \
                patch.object(setup.urllib.request, "urlopen", return_value=response), \
                redirect_stderr(output), redirect_stdout(stdout):
            http = setup.Http(credential=credential)
            result = http.request(
                "POST", SEARCH_ENDPOINT + "/indexes/test/docs/search?secret=private-query",
                setup.SEARCH_SCOPE, body={"search": "private-document"},
            )
            http.request("GET", SEARCH_ENDPOINT + "/indexes/test", setup.SEARCH_SCOPE)
        self.assertEqual(result, (200, {"value": []}, {}))
        credential.get_token.assert_called_once_with(setup.SEARCH_SCOPE)
        logs = output.getvalue()
        self.assertIn("Requesting Azure CLI token", logs)
        self.assertIn("Authentication ready", logs)
        self.assertIn("POST test-search.search.windows.net/indexes/test/docs/search", logs)
        self.assertIn("HTTP 200", logs)
        for secret in ("private-token", "private-query", "private-document"):
            self.assertNotIn(secret, logs)
        self.assertEqual(stdout.getvalue(), "")

    def test_default_cli_authentication_has_a_bounded_timeout(self):
        factory = Mock(return_value=Mock(
            get_token=Mock(return_value=SimpleNamespace(token="secret", expires_on=4000)),
        ))
        with patch.dict("sys.modules", {"azure.identity": SimpleNamespace(AzureCliCredential=factory)}):
            self.assertEqual(setup.Http().token(setup.SEARCH_SCOPE), "secret")
        factory.assert_called_once_with(process_timeout=30)

    def test_interruption_reports_remote_indexer_may_continue_without_success_json(self):
        output, stdout = io.StringIO(), io.StringIO()
        with patch.object(setup, "Http"), patch.object(setup, "apply", side_effect=KeyboardInterrupt), \
                redirect_stderr(output), redirect_stdout(stdout):
            code = setup.main(["--apply", "--index-only"])
        self.assertEqual(code, 130)
        self.assertIn("Search may still be running", output.getvalue())
        self.assertIn("No verification success", output.getvalue())
        self.assertEqual(stdout.getvalue(), "")


class PolicyIndexTests(unittest.TestCase):
    def setUp(self):
        self.root = make_root()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.sources = setup.load_sources(self.root)
        self.settings = setup.runtime_settings(self.root)
        self.generation = setup.generation_hash(self.sources, self.settings)

    def fake(self, **kw):
        fake = FakeAzure(self.sources, **kw)
        fake.chunks = good_chunks(self.sources, self.generation)
        return fake

    def test_deployment_settings_override_active_config_and_derive_endpoints(self):
        deployment = {**RESOURCES, "modelDeployment": "lab-model", "cuModelName": "gpt-5.2",
                      "claimAnalyzerId": "lab_claims",
                      "foundryResourceId": f"{RESOURCE_ROOT}/Microsoft.CognitiveServices/accounts/other-foundry"}
        (self.root / setup.DEPLOYMENT_PATH).write_text(json.dumps(deployment), encoding="utf-8")
        settings = setup.runtime_settings(self.root)
        self.assertEqual(settings["cuEndpoint"], "https://other-foundry.services.ai.azure.com")
        self.assertEqual(settings["azureOpenAIEndpoint"], settings["cuEndpoint"])
        self.assertEqual(settings["searchEndpoint"], SEARCH_ENDPOINT)
        self.assertEqual(settings["modelName"], "gpt-5.2")
        self.assertEqual(setup.runtime_settings(self.root, {"modelDeployment": "explicit"})["modelDeployment"], "explicit")
        self.assertNotEqual(setup.generation_hash(self.sources, settings), self.generation)

    def test_invalid_or_missing_resource_settings_fail_before_azure_calls(self):
        for key in RESOURCES:
            for value in ("", "https://example.com", RESOURCES[key] + "/child", RESOURCES[key] + "?query"):
                with self.subTest(key=key, value=value), self.assertRaises(setup.SetupError):
                    setup.runtime_settings(self.root, {key: value or "invalid"})
        (self.root / setup.DEPLOYMENT_PATH).write_text('{"unknown": "value"}', encoding="utf-8")
        with self.assertRaisesRegex(setup.SetupError, "Unknown deployment"):
            setup.runtime_settings(self.root)

    def test_explicit_claim_bootstrap_is_read_only_until_apply_and_never_overwrites(self):
        fake = self.fake()
        fake.analyzer = None
        report = setup.preflight(fake, self.root, create_claim_analyzer=True)
        self.assertTrue(report["ready"], report["problems"])
        self.assertEqual(report["claimAnalyzer"]["status"], "planned")
        self.assertTrue(all(method == "GET" for method, _ in fake.calls))
        result = setup.apply(fake, self.root, sleep=lambda _: None, create_claim_analyzer=True)
        self.assertEqual(result["status"], "verified")
        self.assertIn("DrivabilityEvidence", fake.analyzer["fieldSchema"]["fields"])
        writes = [c for c in fake.calls if c[0] == "PUT" and "/analyzers/" in c[1]]
        setup.prepare_claim_analyzer(fake, self.settings, apply_changes=True, sleep=lambda _: None)
        self.assertEqual(writes, [c for c in fake.calls if c[0] == "PUT" and "/analyzers/" in c[1]])
        fake.analyzer["fieldSchema"]["fields"] = {}
        with self.assertRaises(setup.ConflictError):
            setup.prepare_claim_analyzer(fake, self.settings, apply_changes=True)

    def test_missing_permissions_block_claim_bootstrap_before_any_writes(self):
        fake = self.fake(roles_ok=False)
        fake.analyzer = None
        self.assertEqual(setup.apply(fake, self.root, create_claim_analyzer=True)["status"], "blocked")
        self.assertFalse(any(method != "GET" for method, _ in fake.calls))

    # generation scope
    def test_generation_names_and_hash_follow_sources_pipeline_and_model(self):
        names = setup.names_for(self.generation)
        self.assertTrue(all(self.generation[:12] in v for v in names.values()))
        self.assertLessEqual(len(names["container"]), 63)
        self.assertEqual(self.generation, setup.generation_hash(setup.load_sources(self.root), self.settings))
        self.assertNotEqual(self.generation, setup.generation_hash(
            self.sources, {**self.settings, "modelDeployment": "other", "modelName": "other"}))
        pdf = self.root / setup.CORPUS / "doc0.pdf"
        pdf.write_bytes(b"changed")
        manifest = self.root / setup.CORPUS / "manifest.json"
        data = json.loads(manifest.read_text())
        digest = hashlib.sha256(b"changed").hexdigest()
        data["documents"][0]["sha256"] = digest
        manifest.write_text(json.dumps(data))
        cites = self.root / setup.CORPUS / "citations.json"
        c = json.loads(cites.read_text())
        c[0]["sha256"] = digest
        cites.write_text(json.dumps(c))
        self.assertNotEqual(self.generation, setup.generation_hash(setup.load_sources(self.root), self.settings))

    def test_document_count_comes_from_manifest(self):
        other = make_root(count=5)
        self.addCleanup(shutil.rmtree, other, True)
        self.assertEqual(len(setup.load_sources(other)["documents"]), 5)
        self.assertEqual(len(self.sources["documents"]), 3)

    # malformed sources
    def test_malformed_sources_fail_closed(self):
        corpus = self.root / setup.CORPUS
        manifest = json.loads((corpus / "manifest.json").read_text())
        cases = {
            "hash": lambda m, c: m["documents"][0].__setitem__("sha256", "0" * 64),
            "path": lambda m, c: m["documents"][0].__setitem__("pdf", "../evil.pdf"),
            "dup": lambda m, c: m["documents"].append(copy.deepcopy(m["documents"][0])),
            "cite-version": lambda m, c: c[0].__setitem__("version", "9"),
            "sections": lambda m, c: c[0].__setitem__("sections", {"A": 0}),
            "rules": lambda m, c: c[0].__setitem__("ruleIds", ["X"]),
            "empty": lambda m, c: m.__setitem__("documents", []),
        }
        original_cites = json.loads((corpus / "citations.json").read_text())
        for name, mutate in cases.items():
            m, c = copy.deepcopy(manifest), copy.deepcopy(original_cites)
            mutate(m, c)
            (corpus / "manifest.json").write_text(json.dumps(m))
            (corpus / "citations.json").write_text(json.dumps(c))
            with self.subTest(name), self.assertRaises(setup.SetupError):
                setup.load_sources(self.root)
        (corpus / "manifest.json").write_text("{not json")
        with self.assertRaises(setup.SetupError):
            setup.load_sources(self.root)

    def test_policy_checks_json_is_never_required(self):
        self.assertFalse((self.root / ".tools" / "policy-checks.json").exists())
        self.assertEqual(self.settings["modelDeployment"], "gpt-5")

    # roles fail closed
    def test_preflight_reports_missing_roles_and_apply_makes_no_azure_writes(self):
        fake = self.fake(roles_ok=False)
        report = setup.preflight(fake, self.root)
        self.assertFalse(report["ready"])
        self.assertEqual(len(report["missingRoles"]), len(setup.REQUIREMENTS))
        self.assertTrue(all(m["scopeResourceId"] and m["principalId"] for m in report["missingRoles"]))
        self.assertTrue(all(c[0] == "GET" for c in fake.calls))
        before = (self.root / setup.CONFIG_PATH).read_text()
        result = setup.apply(self.fake(roles_ok=False), self.root)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual((self.root / setup.CONFIG_PATH).read_text(), before)
        self.assertEqual(json.loads((self.root / setup.STATE_PATH).read_text())["status"], "blocked")

    def test_unreadable_role_listing_fails_closed(self):
        fake = self.fake()
        original = fake.request

        def broken(method, url, *a, **k):
            if "roleAssignments" in url:
                return 403, {"error": {"message": "denied"}}, {}
            return original(method, url, *a, **k)
        fake.request = broken
        report = setup.preflight(fake, self.root)
        self.assertFalse(report["ready"])
        self.assertTrue(report["problems"])

    def test_inherited_scope_only_counts_when_it_contains_the_resource(self):
        held = {("caller", "storage"): [{"role": setup.ROLES["Storage Blob Data Contributor"], "scope": "/x"}]}
        self.assertTrue(next(r for r in setup.check_roles(held)
                             if r["principal"] == "caller" and r["scope"] == "storage")["ok"])
        self.assertFalse(any(r["ok"] for r in setup.check_roles({})))

    # metadata projection
    def test_projection_maps_page_range_and_all_metadata_fields(self):
        names = setup.names_for(self.generation)
        skillset = setup.skillset_definition(names, self.generation, self.settings)
        skill = skillset["skills"][0]
        self.assertEqual(skill["chunkingProperties"]["method"], "semantic")
        self.assertEqual(skill["modelDeployment"], "gpt-5")
        self.assertIn("locationMetadata", skill["extractionOptions"])
        selector = skillset["indexProjections"]["selectors"][0]
        mapped = {m["name"]: m["source"] for m in selector["mappings"]}
        index_fields = {f["name"] for f in setup.index_definition(names, self.generation)["fields"]}
        self.assertEqual(set(mapped) | {"id", "parentId"}, index_fields)
        self.assertTrue(mapped["pageTo"].endswith("/pageNumberTo"))
        self.assertTrue(mapped["page"].endswith("/pageNumberFrom"))
        for field in setup.BLOB_METADATA.values():
            self.assertEqual(mapped[field], f"/document/{field}")
        self.assertEqual(setup.indexer_definition(names, self.generation)["fieldMappings"],
                         [{"sourceFieldName": key, "targetFieldName": field}
                          for key, field in setup.BLOB_METADATA.items()])
        self.assertEqual(selector["parentKeyFieldName"], "parentId")
        self.assertEqual(skillset["cognitiveServices"]["subdomainUrl"], FOUNDRY_ROOT)
        datasource = setup.datasource_definition(names, self.generation, self.settings)
        self.assertIn(RESOURCES["storageResourceId"], datasource["credentials"]["connectionString"])
        self.assertNotIn("AccountKey", json.dumps(datasource))

    def test_citation_sections_follow_page_range(self):
        doc = self.sources["documents"][0]
        self.assertEqual(setup.citation_sections(doc, 1, 2), ["1. Scope", "2. Matrix"])
        self.assertEqual(setup.citation_sections(doc, 3, 3), ["3. Figure"])
        self.assertEqual(setup.citation_sections(doc, 4, 5), [])

    def test_chunk_validation_rejects_bad_metadata_and_ranges(self):
        good = good_chunks(self.sources, self.generation)
        chunks = setup.validate_chunks(good, self.sources, self.generation)
        shared = next(c for c in chunks if c["documentId"] == "SHARED-EVIDENCE-002")
        self.assertIn("SHARED", shared["stateCodes"])
        self.assertEqual(shared["citationSections"], ["1. Scope", "2. Matrix"] if shared["page"] == 1 else ["3. Figure"])
        for name, mutate in {
            "range": lambda r: r.update(pageTo=0),
            "sha": lambda r: r.update(sha256="0" * 64),
            "gen": lambda r: r.update(indexFingerprint="x"),
            "content": lambda r: r.update(content=" "),
            "doc": lambda r: r.update(documentId="NOPE"),
            "missing": lambda r: r.pop("pageTo"),
            "beyond-pdf": lambda r: r.update(pageTo=4),
            "boolean-page": lambda r: r.update(page=True),
        }.items():
            rows = copy.deepcopy(good)
            mutate(rows[0])
            with self.subTest(name), self.assertRaises(setup.SetupError):
                setup.validate_chunks(rows, self.sources, self.generation)
        with self.assertRaises(setup.SetupError):  # a cited page no chunk covers
            setup.validate_chunks([r for r in good if not (r["documentId"] == good[0]["documentId"] and r["page"] == 3)],
                                  self.sources, self.generation)
        with self.assertRaises(setup.SetupError):
            setup.validate_chunks([], self.sources, self.generation)

    def test_readback_digest_is_order_independent_and_content_sensitive(self):
        chunks = setup.validate_chunks(good_chunks(self.sources, self.generation), self.sources, self.generation)
        self.assertEqual(setup.digest_chunks(chunks), setup.digest_chunks(list(reversed(chunks))))
        changed = copy.deepcopy(chunks)
        changed[0]["content"] += "!"
        self.assertNotEqual(setup.digest_chunks(chunks), setup.digest_chunks(changed))
        self.assertNotEqual(setup.digest_chunks(chunks), self.generation)

    def test_state_filter_scopes_documents_and_generation(self):
        text = setup.generation_filter(self.sources, self.generation, "TX")
        self.assertIn("TX-RENTAL-002", text)
        self.assertIn("SHARED-EVIDENCE-002", text)
        self.assertNotIn("WA-RENTAL-002", text)
        self.assertIn(self.generation, text)
        with self.assertRaises(setup.SetupError):
            setup.generation_filter(self.sources, self.generation, "ZZ")

    # safe conflict
    def test_existing_unowned_or_changed_objects_conflict(self):
        names = setup.names_for(self.generation)
        for kind, (collection, expected) in setup.definitions(names, self.generation, self.settings).items():
            setup.assert_owned(kind, expected, copy.deepcopy(expected))
            foreign = {**copy.deepcopy(expected), "description": "someone else's"}
            with self.subTest(kind), self.assertRaises(setup.ConflictError):
                setup.assert_owned(kind, expected, foreign)
        _, index = setup.definitions(names, self.generation, self.settings)["index"]
        changed = copy.deepcopy(index)
        changed["fields"][2]["searchable"] = False
        with self.assertRaises(setup.ConflictError):
            setup.assert_owned("index", index, changed)
        fake = self.fake()
        fake.objects[names["index"]] = {"description": "foreign", "fields": []}
        with self.assertRaises(setup.ConflictError):
            setup.ensure_objects(fake, names, self.generation, self.settings)
        self.assertFalse([c for c in fake.calls if c[0] == "PUT"])

    def test_drifted_blob_requires_refresh(self):
        names = setup.names_for(self.generation)
        fake = self.fake()
        setup.upload_sources(fake, self.sources, names, self.generation, False, self.settings)
        fake.blobs[f"{names['container']}/doc0.pdf"]["sha256"] = "drift"
        with self.assertRaises(setup.ConflictError):
            setup.upload_sources(fake, self.sources, names, self.generation, False, self.settings)
        result = setup.upload_sources(fake, self.sources, names, self.generation, True, self.settings)
        self.assertEqual(result["doc0.pdf"], "uploaded")
        self.assertEqual(result["doc1.pdf"], "unchanged")

    # readiness
    def test_indexer_readiness_is_strict(self):
        ok = {"status": "idle", "lastResult": {"status": "success", "itemsProcessed": 3, "itemsFailed": 0}}
        self.assertTrue(setup.indexer_ready(ok, 3)[0])
        self.assertTrue(setup.indexer_ready({**ok, "status": "running"}, 3)[0])
        self.assertFalse(setup.indexer_ready(ok, 4)[0])
        self.assertFalse(setup.indexer_ready({**ok, "lastResult": {**ok["lastResult"], "itemsFailed": 1}}, 3)[0])
        self.assertFalse(setup.indexer_ready({"status": "running", "lastResult": None}, 3)[0])
        self.assertFalse(setup.indexer_ready({"status": "idle", "lastResult": None}, 3)[0])
        self.assertFalse(setup.indexer_ready({"status": "idle", "lastResult": {"status": "transientFailure"}}, 3)[0])

    def test_apply_verifies_then_activates_and_backs_up_layout_config(self):
        fake = self.fake()
        result = setup.apply(fake, self.root, sleep=lambda s: None)
        self.assertEqual(result["status"], "verified")
        config = json.loads((self.root / setup.CONFIG_PATH).read_text())
        self.assertEqual(config["extractionMode"], "standard")
        self.assertEqual(config["indexFingerprint"], self.generation)
        self.assertNotEqual(config["chunkDigest"], config["indexFingerprint"])
        self.assertEqual(config["indexName"], setup.names_for(self.generation)["index"])
        self.assertEqual(json.loads((self.root / setup.BACKUP_PATH).read_text())["indexName"], "legacy-index")
        snapshot = json.loads((self.root / setup.SNAPSHOT_PATH).read_text())
        self.assertEqual(snapshot["chunkDigest"], config["chunkDigest"])
        self.assertTrue(all("citationSections" in c for c in snapshot["chunks"]))
        self.assertFalse([c for c in fake.calls if c[0] == "DELETE"])

    def test_index_only_uses_search_indexer_without_claim_analyzer_or_runtime_changes(self):
        fake = self.fake()
        fake.analyzer = None
        before = (self.root / setup.CONFIG_PATH).read_bytes()
        setup.atomic_json(self.root / setup.SNAPSHOT_PATH, {"existing": "active app snapshot"})
        snapshot_before = (self.root / setup.SNAPSHOT_PATH).read_bytes()
        output = io.StringIO()
        with redirect_stderr(output):
            result = setup.apply(fake, self.root, sleep=lambda s: None, index_only=True)
        logs = output.getvalue()
        for stage in ("Checking policy sources", "uploading", "Preparing Search skillset",
                      "Waiting for indexer", "Search indexer complete", "Read 6 indexed chunks",
                      "Retrieval check 1/3", "Retrieval check 3/3", "Indexing verified"):
            self.assertIn(stage, logs)
        self.assertEqual(result["status"], "verified")
        self.assertTrue(result["figureDescriptions"])
        self.assertFalse(result["runtimeActivated"])
        self.assertEqual(result["extractionMode"], "standard")
        self.assertEqual((self.root / setup.CONFIG_PATH).read_bytes(), before)
        self.assertIsNone(fake.analyzer)
        self.assertFalse(any("/contentunderstanding/analyzers/" in url for _, url in fake.calls))
        self.assertFalse(any("/docs/index" in url for _, url in fake.calls))
        self.assertTrue(any("/search.run" in url for _, url in fake.calls))
        self.assertTrue((self.root / result["snapshotPath"]).exists())
        self.assertEqual((self.root / setup.SNAPSHOT_PATH).read_bytes(), snapshot_before)
        skill = fake.objects[setup.names_for(self.generation)["skillset"]]["skills"][0]
        self.assertEqual(skill["@odata.type"], "#Microsoft.Skills.Util.ContentUnderstandingSkill")
        self.assertEqual(skill["modelName"], self.settings["modelName"])
        self.assertEqual(skill["modelDeployment"], self.settings["modelDeployment"])
        self.assertEqual(skill["chunkingProperties"]["method"], "semantic")

    def test_index_only_preflight_does_not_require_claim_settings(self):
        (self.root / setup.CONFIG_PATH).unlink()
        fake = self.fake()
        fake.analyzer = None
        report = setup.preflight(fake, self.root, seed={
            **RESOURCES, "modelDeployment": "lab-policy", "cuModelName": "gpt-5.2",
        }, index_only=True)
        self.assertTrue(report["ready"], report["problems"])
        self.assertNotIn("claimAnalyzer", report)
        self.assertTrue(all(method == "GET" for method, _ in fake.calls))
        self.assertFalse(any("/contentunderstanding/analyzers/" in url for _, url in fake.calls))

    def test_existing_indexer_run_is_awaited_without_submitting_another_run(self):
        fake = self.fake()
        responses = iter([
            {"status": "running", "lastResult": {"status": "inProgress", "startTime": "same-run"}},
            {"status": "idle", "lastResult": {"status": "success", "startTime": "same-run",
                                              "itemsProcessed": 3, "itemsFailed": 0}},
        ])
        with patch.object(setup, "indexer_status", side_effect=lambda *args: next(responses)):
            result = setup.run_indexer(fake, setup.names_for(self.generation), 3, False,
                                       self.settings, sleep=lambda s: None)
        self.assertEqual(result["lastResult"]["startTime"], "same-run")
        self.assertFalse(any("/search.run" in url for _, url in fake.calls))

    def test_failed_index_only_run_does_not_activate_or_publish_a_snapshot(self):
        before = (self.root / setup.CONFIG_PATH).read_bytes()
        with self.assertRaises(setup.SetupError):
            setup.apply(self.fake(failed=1), self.root, sleep=lambda s: None, index_only=True)
        self.assertEqual((self.root / setup.CONFIG_PATH).read_bytes(), before)
        self.assertFalse((self.root / ".tools" / f"policy-index-{self.generation[:12]}.json").exists())

    def test_failed_indexer_leaves_working_config_untouched(self):
        before = (self.root / setup.CONFIG_PATH).read_text()
        with self.assertRaises(setup.SetupError):
            setup.apply(self.fake(failed=2), self.root, sleep=lambda s: None)
        self.assertEqual((self.root / setup.CONFIG_PATH).read_text(), before)
        self.assertFalse((self.root / setup.SNAPSHOT_PATH).exists())

    def test_reapply_without_refresh_does_not_rerun_ready_indexer(self):
        fake = self.fake()
        setup.apply(fake, self.root, sleep=lambda s: None)
        self.assertEqual(fake.runs, 1)
        setup.apply(fake, self.root, sleep=lambda s: None)
        self.assertEqual(fake.runs, 1)
        setup.apply(fake, self.root, refresh=True, sleep=lambda s: None)
        self.assertEqual(fake.runs, 2)
        self.assertTrue(any("/search.reset" in url for _, url in fake.calls))

    def test_role_pagination_and_case_insensitive_parent_scope(self):
        class Pages:
            def request(self, method, url, scope):
                if "page=2" not in url:
                    return 200, {"value": [], "nextLink": setup.ARM + "/roles?page=2"}, {}
                return 200, {"value": [{"properties": {
                    "scope": RESOURCES["storageResourceId"].upper(),
                    "roleDefinitionId": "/roles/" + setup.ROLES["Storage Blob Data Reader"],
                }}]}, {}
        roles = setup.role_assignments(Pages(), RESOURCES["storageResourceId"], "search-mi")
        self.assertEqual(roles[0]["role"], setup.ROLES["Storage Blob Data Reader"])

    def test_unreadable_search_definitions_block_apply_before_writes(self):
        fake = self.fake()
        request = fake.request
        def denied(method, url, *args, **kwargs):
            if SEARCH_ENDPOINT in url:
                return 403, {"error": {"message": "denied"}}, {}
            return request(method, url, *args, **kwargs)
        fake.request = denied
        self.assertEqual(setup.apply(fake, self.root)["status"], "blocked")
        self.assertFalse(any(method in ("PUT", "POST") for method, _ in fake.calls))

    # fresh clone / analyzer discovery
    def test_fresh_clone_seed_resolves_analyzer_hash_read_only(self):
        (self.root / setup.CONFIG_PATH).unlink()
        with self.assertRaises(setup.SetupError):
            setup.runtime_settings(self.root)
        with self.assertRaises(setup.SetupError):
            setup.runtime_settings(self.root, {"bogus": "x"})
        seed = {**RESOURCES, "modelDeployment": "gpt-5", "claimAnalyzerId": "claim_summary"}
        fake = self.fake()
        report = setup.preflight(fake, self.root, seed=seed)
        self.assertTrue(report["ready"], report["problems"])
        self.assertEqual(report["claimAnalyzer"]["hash"], setup.analyzer_hash(fake.analyzer))
        self.assertTrue(all(c[0] == "GET" for c in fake.calls))
        result = setup.apply(fake, self.root, sleep=lambda s: None, seed=seed)
        self.assertEqual(result["status"], "verified")
        config = json.loads((self.root / setup.CONFIG_PATH).read_text())
        self.assertEqual(config["claimAnalyzerHash"], setup.analyzer_hash(fake.analyzer))
        self.assertFalse((self.root / setup.BACKUP_PATH).exists())

    def test_analyzer_missing_unready_or_unnamed_blocks_before_writes(self):
        for name, mutate in {"missing": lambda f: setattr(f, "analyzer", None),
                             "unready": lambda f: f.analyzer.update(status="failed")}.items():
            fake = self.fake()
            mutate(fake)
            with self.subTest(name):
                self.assertEqual(setup.apply(fake, self.root, sleep=lambda s: None)["status"], "blocked")
                self.assertFalse([c for c in fake.calls if c[0] in ("PUT", "POST")])
        with self.assertRaises(setup.SetupError):
            setup.resolve_analyzer(self.fake(), {**self.settings, "claimAnalyzerId": "bad-id"})

    def test_claim_analyzer_definition_is_extraction_only_and_stable(self):
        definition = setup.claim_evidence_analyzer_definition()
        self.assertEqual(definition["baseAnalyzerId"], "prebuilt-document")
        fields = definition["fieldSchema"]["fields"]
        self.assertIn("LossState", fields)
        self.assertIn("RentalRequested", fields)
        self.assertIn("RequestTypeEvidence", fields)
        self.assertEqual(fields["RentalRequested"]["type"], "boolean")
        self.assertIn("Ignore TOWING REQUESTED", fields["RentalRequested"]["description"])
        self.assertIn("Never copy a repair estimate", fields["RentalTotal"]["description"])
        self.assertTrue(all(field["method"] == "extract" for field in fields.values()))
        self.assertEqual(setup.analyzer_hash(definition), setup.analyzer_hash(setup.claim_evidence_analyzer_definition()))


if __name__ == "__main__":
    unittest.main()