"""Offline contract checks for the Framework runtime; no model requests."""

import importlib.util
import asyncio
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
from pydantic import ValidationError
from policy_check_inputs import check_analysis, check_prompt, check_questions, fields_frontmatter

spec = importlib.util.spec_from_file_location(
    "policy_framework", Path(__file__).with_name("policy-framework-agent.py"),
)
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)


class FrameworkTests(unittest.TestCase):
    def test_check_projection_preserves_missing_false_zero_and_array_rows(self):
        source = {"contents": [
            {"category": "claim_summary", "fields": {
                "RentalRequested": {"type": "boolean", "valueBoolean": False},
                "RentalTaxes": {"type": "number", "valueNumber": 0},
                "ActualRepairCompletion": {"type": "date"},
                "PolicyDailyBaseCap": {"type": "number", "valueNumber": 54},
                "Rental": {"type": "object", "valueObject": {
                    "DailyRates": {"type": "array", "valueArray": [
                        {"type": "object", "valueObject": {
                            "StartDate": {"type": "date", "valueDate": "2026-03-01"},
                            "Rate": {"type": "number", "valueNumber": 50},
                        }},
                        {"type": "object", "valueObject": {
                            "StartDate": {"type": "date"},
                            "Rate": {"type": "number", "valueNumber": 55},
                        }},
                    ]},
                }},
            }},
            {"category": "id_document", "fields": {
                "FullName": {"type": "string", "valueString": "Irrelevant ID"},
            }},
        ]}
        timing = check_analysis(source, "Timing")
        self.assertEqual(len(timing["contents"]), 1)
        fields = timing["contents"][0]["fields"]
        self.assertNotIn("RentalTaxes", fields)
        self.assertNotIn("PolicyDailyBaseCap", fields)
        rows = fields["Rental"]["valueObject"]["DailyRates"]["valueArray"]
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1]["valueObject"], {"StartDate": {"type": "date"}})
        text = fields_frontmatter(timing)
        self.assertIn("RentalRequested: false", text)
        self.assertIn("ActualRepairCompletion", text)
        self.assertIn("Rental.DailyRates[1].StartDate", text)
        self.assertNotIn("Irrelevant ID", text)
        amount = fields_frontmatter(check_analysis(source, "Amount"))
        self.assertIn("RentalTaxes: 0", amount)
        self.assertNotIn("ActualRepairCompletion", amount)
        questions = check_questions(runtime.ROOT / "docs" / "rental-review-agent-question-v2.md", runtime.CHECKS)
        prompt = check_prompt(source, "Amount", questions)
        self.assertIn(questions["Amount"], prompt)
        self.assertNotIn(questions["Timing"], prompt)
        self.assertIn("RentalTaxes: 0", prompt)
        self.assertNotIn("ActualRepairCompletion", prompt)

    def test_per_check_questions_are_complete_and_independent(self):
        questions = check_questions(
            runtime.ROOT / "docs" / "rental-review-agent-question-v2.md", runtime.CHECKS,
        )
        self.assertEqual(set(questions), {"Shared", *runtime.CHECKS})
        for name in runtime.CHECKS:
            self.assertIn(name, questions[name])
        self.assertIn("Decide applicability BEFORE", questions["Shared"])
        self.assertIn("NotApplicable with ReviewRequired=false", questions["Shared"])
        self.assertIn("A false RentalUsed alone", questions["Shared"])
        self.assertIn("three-branch gate", questions["Shared"])
        self.assertIn("Neither established: immediately return InProgress", questions["Shared"])
        self.assertIn("This includes Effective", questions["Shared"])
        self.assertIn("towing question is not a rental request", questions["Shared"])

    def test_explicit_no_rental_evidence_is_shared_with_every_check(self):
        source = {"contents": [{"category": "claim_summary", "fields": {
            "RentalRequested": {"type": "boolean", "valueBoolean": False},
            "RentalUsed": {"type": "boolean", "valueBoolean": False},
            "RequestTypeEvidence": {"type": "string", "valueString": "Rental requested: No"},
            "RentalPickup": {"type": "string", "valueString": "2026-03-01"},
            "RentalTotal": {"type": "number", "valueNumber": 120},
        }}]}
        for check in runtime.CHECKS:
            with self.subTest(check=check):
                text = fields_frontmatter(check_analysis(source, check))
                self.assertIn("RentalRequested: false", text)
                self.assertIn("RentalUsed: false", text)
                self.assertIn("Rental requested: No", text)
                # Contradictory actual-use/billing signals must not be hidden.
                self.assertIn("RentalPickup:", text)
                self.assertIn("RentalTotal: 120", text)

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

    def test_waiting_for_claim_data_is_distinct_from_review_and_pass(self):
        value = self.review()
        value.Checks[0].Outcome = "InProgress"
        value.Checks[0].ReviewRequired = False
        with self.assertRaises(ValueError):
            runtime.check_citations(value, [], "search")
        value.Checks[0].Citation = [runtime.Citation(
            File="tx.pdf", DocumentId="TX", Version="2.0", RuleId="TX-R2", Section="Schedule",
        )]
        evidence = [dict(file="tx.pdf", documentId="TX", version="2.0",
                         ruleIds=["TX-R2"], citationSections=["Schedule"])]
        runtime.check_citations(value, evidence, "search")
        with self.assertRaises(ValueError):
            runtime.check_citations(value, evidence, "ungrounded")
        value.Checks[0].ReviewRequired = True
        with self.assertRaises(ValueError):
            runtime.check_citations(value, evidence, "search")

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


class ParallelFrameworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_parallel_calls_order_shared_auth_and_sibling_cancellation(self):
        manifest = runtime.ROOT / "data" / "policies" / "rental" / "ocr-comparison-v2" / "manifest.json"
        config = dict(
            schemaVersion=1, provider="agent-framework",
            azureOpenAIEndpoint="https://example.services.ai.azure.com",
            searchEndpoint="https://example.search.windows.net", indexName="offline-test-index",
            modelDeployment="gpt-5", corpusHash=hashlib.sha256(manifest.read_bytes()).hexdigest(),
            indexFingerprint="a" * 64, extractionMode="layout",
        )
        questions = check_questions(
            runtime.ROOT / "docs" / "rental-review-agent-question-v2.md", runtime.CHECKS,
        )
        analysis = {"contents": [{"category": "claim_summary", "fields": {
            "RentalRequested": {"type": "boolean", "valueBoolean": True},
            "RentalTaxes": {"type": "number", "valueNumber": 0},
            "ActualRepairCompletion": {"type": "date"},
        }}]}
        with tempfile.TemporaryDirectory() as folder:
            config_file = Path(folder) / "config.json"
            config_file.write_text(json.dumps(config), encoding="utf-8")
            for fail in (False, True):
                with self.subTest(failing_call=fail):
                    active = maximum = 0
                    cancelled, prompts = [], {}
                    barrier = asyncio.Event()

                    async def respond(messages, options):
                        nonlocal active, maximum
                        prompt = messages[-1].text
                        name = next(n for n in runtime.CHECKS if questions[n] in prompt)
                        prompts[name] = prompt
                        self.assertEqual(options["reasoning"], {"effort": "low"})
                        self.assertFalse(options["store"])
                        active += 1
                        maximum = max(maximum, active)
                        try:
                            if active == 5:
                                barrier.set()
                            await asyncio.wait_for(barrier.wait(), 2)
                            if fail:
                                if name == "Amount":
                                    raise RuntimeError("offline model failure")
                                await asyncio.sleep(10)
                            await asyncio.sleep((5 - runtime.CHECKS.index(name)) * 0.002)
                            value = dict(
                                Check=name, Outcome="ReviewRequired", ReviewRequired=True,
                                ExpectedValue="Not retrieved", ActualValue="Not provided",
                                Reason="Offline fixture", Citation=[],
                            )
                            return SimpleNamespace(text=json.dumps(value), usage_details={})
                        except asyncio.CancelledError:
                            cancelled.append(name)
                            raise
                        finally:
                            active -= 1

                    token = MagicMock(return_value="offline-token")
                    with patch.object(runtime, "AzureCliCredential"), \
                            patch.object(runtime, "get_bearer_token_provider", return_value=token), \
                            patch.object(runtime, "AsyncOpenAI"), \
                            patch.object(runtime, "OpenAIChatClient"), \
                            patch.object(runtime, "Agent") as agent:
                        agent.return_value.run.side_effect = respond
                        turn = runtime.Turn(
                            mode="ungrounded", prompt="Offline review", configPath=str(config_file),
                            claimAnalysis=analysis, reviewStrategy="parallel", reasoningEffort="low",
                        )
                        if fail:
                            with self.assertRaisesRegex(ValueError, "Amount failed: offline model failure"):
                                await runtime.run(turn)
                            self.assertEqual(len(cancelled), 4)
                        else:
                            value = await runtime.run(turn)
                            self.assertEqual([c["Check"] for c in value["result"]["Checks"]], runtime.CHECKS)
                            self.assertEqual(value["timings"]["modelRequests"], 5)
                            self.assertNotIn("RentalTaxes", prompts["Timing"])
                            self.assertIn("RentalTaxes: 0", prompts["Amount"])
                            for name, prompt in prompts.items():
                                for other in runtime.CHECKS:
                                    if other != name:
                                        self.assertNotIn(questions[other], prompt)
                        self.assertEqual(maximum, 5)
                        self.assertEqual(active, 0)
                        token.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
