"""Offline contract checks for the Framework runtime; no model requests."""

import importlib.util
from pathlib import Path
import sys
import unittest
from pydantic import ValidationError

spec = importlib.util.spec_from_file_location(
    "policy_framework", Path(__file__).with_name("policy-framework-agent.py"),
)
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)


class FrameworkTests(unittest.TestCase):
    def test_model_schema_requires_exact_check_names_and_five_results(self):
        schema = runtime.Review.model_json_schema()
        self.assertEqual(schema["$defs"]["Check"]["properties"]["Check"]["enum"], runtime.CHECKS)
        self.assertEqual(schema["properties"]["Checks"]["minItems"], 5)
        self.assertEqual(schema["properties"]["Checks"]["maxItems"], 5)
        value = self.review().model_dump()
        value["Checks"][0]["Check"] += "."
        with self.assertRaises(ValidationError):
            runtime.Review.model_validate(value)
        value = self.review().model_dump()
        value["Checks"].pop()
        with self.assertRaises(ValidationError):
            runtime.Review.model_validate(value)

    def review(self):
        return runtime.Review(Checks=[
            runtime.Check(
                Check=name, Outcome="ReviewRequired", ReviewRequired=True,
                ExpectedValue="SOP not retrieved", ActualValue="Unknown",
                Reason="No rule evidence", Citation=[],
            ) for name in runtime.CHECKS
        ])

    def test_no_retrieval_never_establishes_rules(self):
        value = self.review()
        runtime.check_citations(value, [], "ungrounded")
        value.Checks[0].Outcome = "Satisfied"
        value.Checks[0].ReviewRequired = False
        with self.assertRaises(ValueError):
            runtime.check_citations(value, [], "ungrounded")

    def test_citations_require_exact_per_turn_evidence(self):
        citation = runtime.Citation(
            File="tx.pdf", DocumentId="TX", Version="v2.0", RuleId="TX-R2", Section="Schedule",
        )
        answer = runtime.Answer(Answer="Rate evidence", Citation=[citation])
        doc = dict(file="tx.pdf", documentId="TX", version="2.0", ruleIds=["TX-R2"], citationSections=["Schedule"])
        runtime.check_citations(answer, [doc], "search")
        with self.assertRaises(ValueError):
            runtime.check_citations(answer, [], "search")
        citation.Section = "Wrong section"
        with self.assertRaises(ValueError):
            runtime.check_citations(answer, [doc], "search")

    def test_order_and_outcome_consistency(self):
        value = self.review()
        value.Checks.reverse()
        with self.assertRaises(ValueError):
            runtime.check_citations(value, [], "search")
        value = self.review()
        value.Checks[0].ReviewRequired = False
        with self.assertRaises(ValueError):
            runtime.check_citations(value, [], "search")

    def test_resource_roots_and_filters_are_validated_before_auth(self):
        config = dict(
            schemaVersion=1, provider="agent-framework",
            azureOpenAIEndpoint="https://example.services.ai.azure.com",
            searchEndpoint="https://example.search.windows.net", indexName="test-index",
            modelDeployment="gpt-5", corpusHash="a" * 64, indexFingerprint="b" * 64,
            extractionMode="standard",
        )
        runtime.validate_config(config)
        for field, value in (
            ("searchEndpoint", "https://example.search.windows.net@untrusted.example"),
            ("azureOpenAIEndpoint", "http://example.services.ai.azure.com"),
            ("corpusHash", "' or true"),
            ("indexName", "other/index"),
        ):
            with self.subTest(field=field), self.assertRaises(ValueError):
                runtime.validate_config({**config, field: value})

    def test_managed_chunks_use_verified_page_ranges_not_model_chosen_sections(self):
        config = dict(extractionMode="standard", corpusHash="a" * 64, indexFingerprint="b" * 64)
        source = dict(pdf="tx.pdf", documentId="TX", version="2.0", sha256="c" * 64,
                      states=["TX"], ruleIds=["TX-R2"], documentType="state_sop")
        citations = {"TX": {"sections": {"Scope": 1, "Matrix": 2, "Schedule": 3, "Worksheet": 4}}}
        row = dict(
            id="managed-chunk", file="tx.pdf", documentId="TX", version="2.0",
            sha256="c" * 64,
            corpusHash=config["corpusHash"], indexFingerprint=config["indexFingerprint"],
            page=2, pageTo=3, content="<table><tr><td></td></tr></table>",
        )
        value = runtime.source_evidence(row, config, {"tx.pdf": source}, citations, "TX")
        self.assertEqual(value["citationSections"], ["Matrix", "Schedule"])
        self.assertEqual(value["content"], row["content"])
        self.assertEqual(value["stateCodes"], ["TX"])
        self.assertEqual(value["ruleIds"], ["TX-R2"])
        for patch in (
            {"pageTo": 5}, {"pageTo": 1}, {"page": None}, {"sha256": "d" * 64},
            {"content": ""}, {"file": "../tx.pdf"},
            {"indexFingerprint": "e" * 64},
        ):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                runtime.source_evidence({**row, **patch}, config, {"tx.pdf": source}, citations, "TX")
        with self.assertRaises(ValueError):
            runtime.source_evidence(row, config, {"tx.pdf": source}, citations, "WA")

    def test_managed_filter_scopes_scalar_document_ids_from_local_manifest(self):
        config = dict(extractionMode="standard", corpusHash="a" * 64, indexFingerprint="b" * 64)
        sources = {
            "tx.pdf": dict(documentId="TX", states=["TX"]),
            "wa.pdf": dict(documentId="WA", states=["WA"]),
            "shared.pdf": dict(documentId="SHARED", states=["TX", "WA"]),
        }
        filtered = runtime.retrieval_filter(config, sources, "TX")
        self.assertIn("search.in(documentId, 'TX,SHARED', ',')", filtered)
        self.assertNotIn("stateCodes", filtered)
        self.assertIn(config["indexFingerprint"], filtered)
        with self.assertRaises(ValueError):
            runtime.retrieval_filter(config, sources, "AZ")

    def test_current_layout_index_remains_explicitly_identified(self):
        config = dict(extractionMode="layout", corpusHash="a" * 64, indexFingerprint="b" * 64)
        source = dict(pdf="tx.pdf", documentId="TX", version="2.0", sha256="c" * 64,
                      states=["TX"], ruleIds=["TX-R2"], documentType="state_sop")
        citations = {"TX": {"sections": {"Scope": 1, "Schedule": 3}}}
        row = dict(
            id="layout-chunk", file="tx.pdf", documentId="TX", version="2.0", sha256="c" * 64,
            stateCodes=["TX"], ruleIds=["TX-R2"], corpusHash=config["corpusHash"],
            indexFingerprint=config["indexFingerprint"], page=3, section="Schedule", content="Rate table",
        )
        value = runtime.source_evidence(row, config, {"tx.pdf": source}, citations, "TX")
        self.assertEqual(value["citationSections"], ["Schedule"])
        self.assertEqual(value["pageTo"], 3)
        with self.assertRaises(ValueError):
            runtime.source_evidence({**row, "section": "Invented"}, config, {"tx.pdf": source}, citations, "TX")


if __name__ == "__main__":
    unittest.main()
