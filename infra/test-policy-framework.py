"""Offline contract checks for the Framework runtime; no model requests."""

import importlib.util
import asyncio
import hashlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
from pydantic import ValidationError
from policy_check_inputs import (
    check_analysis, check_prompt, check_questions, fields_frontmatter, claim_references,
    claim_fields, claim_document_text,
)

spec = importlib.util.spec_from_file_location(
    "policy_framework", Path(__file__).with_name("policy-framework-agent.py"),
)
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)


class FrameworkTests(unittest.TestCase):
    def test_followup_reads_saved_packet_fields_and_whole_text_without_mutation(self):
        source = {"contents": [{
            "category": "rental_invoice", "pages": {"start": 2, "end": 3},
            "fields": {"Rate": {"type": "number", "valueNumber": 0},
                       "Requested": {"type": "boolean", "valueBoolean": False},
                       "Return": {"type": "date"}},
        }], "textEvidence": [{
            "id": "parse.input1", "category": "rental_invoice",
            "pages": {"start": 2, "end": 3}, "text": "<table>Complete original table</table>",
        }]}
        documents = claim_fields(source, "rental_invoice")["documents"]
        self.assertEqual(documents, source["contents"])
        documents[0]["fields"].clear()
        self.assertIn("Rate", source["contents"][0]["fields"])
        self.assertIn("reason", claim_fields(source, "packet-02"))
        listed = claim_document_text(source)["documents"]
        self.assertNotIn("text", listed[0])
        self.assertEqual(claim_document_text(source, listed[0]["id"])["documents"], source["textEvidence"])
        self.assertIn("reason", claim_document_text(source, "../../packet-02.pdf"))
        self.assertEqual(claim_document_text({}, "parse.input1")["documents"], [])

    def test_check_projection_preserves_missing_false_zero_and_array_rows(self):
        source = {"contents": [
            {"category": "claim_summary", "fields": {
                "RentalRequested": {"type": "boolean", "valueBoolean": False},
                "RentalDailyBaseRate": {"type": "number", "valueNumber": 0},
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
        amount = check_analysis(source, "Daily rate")
        self.assertEqual(len(amount["contents"]), 1)
        fields = amount["contents"][0]["fields"]
        self.assertEqual(fields["RentalDailyBaseRate"]["valueNumber"], 0)
        self.assertEqual(fields["PolicyDailyBaseCap"]["valueNumber"], 54)
        rows = fields["Rental"]["valueObject"]["DailyRates"]["valueArray"]
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1]["valueObject"]["StartDate"], {"type": "date"})
        text = fields_frontmatter(amount)
        self.assertIn("RentalRequested: false", text)
        self.assertNotIn("ActualRepairCompletion", text)
        self.assertIn("Rental.DailyRates[1].StartDate", text)
        self.assertNotIn("Irrelevant ID", text)
        amount = fields_frontmatter(check_analysis(source, "Daily rate"))
        self.assertIn("RentalDailyBaseRate: 0", amount)
        self.assertNotIn("ActualRepairCompletion", amount)
        questions = check_questions(runtime.ROOT / "docs" / "rental-review-agent-question-v2.md", runtime.CHECKS)
        prompt = check_prompt(source, "Daily rate", questions)
        self.assertIn(questions["Daily rate"], prompt)
        self.assertNotIn("Rental start", questions)
        with self.assertRaisesRegex(ValueError, "Unknown policy check"):
            check_analysis(source, "Rental start")
        self.assertIn("RentalDailyBaseRate: 0", prompt)
        self.assertNotIn("ActualRepairCompletion", prompt)

    def test_per_check_questions_are_complete_and_independent(self):
        questions = check_questions(
            runtime.ROOT / "docs" / "rental-review-agent-question-v2.md", runtime.CHECKS,
        )
        self.assertEqual(set(questions), {"Shared", *runtime.CHECKS})
        for name in runtime.CHECKS:
            self.assertIn(name, questions[name])
        self.assertIn("shared rental applicability decision", " ".join(questions["Shared"].split()))
        self.assertIn("NotApplicable with ReviewRequired=false", questions["Shared"])
        self.assertIn("RentalUsed=false alone", questions["Shared"])
        self.assertIn("Effective terms is independent", questions["Shared"])
        self.assertIn("A towing Yes isn't rental Yes", questions["Shared"])
        self.assertIn("prior usage", questions["Daily rate"])
        self.assertIn("effective-boundary ambiguity", questions["Effective terms"])

    def test_original_parse_segments_and_typed_provenance_need_no_summary(self):
        table = "<table><tr><th>Drivable</th><th>Start basis</th></tr>" \
                "<tr><td></td><td>Appointment isn't delivery</td></tr></table>"
        source = {"context": {"packetId": "packet"}, "contents": [{
            "kind": "document", "category": "intake_notes", "path": "/contents/3",
            "content_path": "/contents/3", "pages": {"start": 7, "end": 9},
            "fields": {
                "LossDate": {"type": "date", "valueDate": None, "source": "D(7,1,2,3,4)",
                             "confidence": 0.8},
                "RentalRequested": {"type": "boolean", "valueBoolean": False},
                "Rental": {"type": "object", "source": "D(8,1,2,3,4)", "valueObject": {
                    "Pickup": {"type": "date", "valueDate": "2026-03-01"},
                }},
            },
        }], "textEvidence": [{
            "id": "parse./contents/3", "category": "intake_notes",
            "contentPath": "/contents/3", "pages": {"start": 7, "end": 9}, "text": table,
        }, {"id": "parse./contents/4", "category": "id_document", "text": "Unrelated ID OCR"}]}
        questions = check_questions(
            runtime.ROOT / "docs" / "rental-review-agent-question-v2.md", runtime.CHECKS,
        )
        for check in runtime.CHECKS:
            projected = check_analysis(source, check)
            doc = projected["contents"][0]
            self.assertEqual(doc["pages"], {"start": 7, "end": 9})
            self.assertEqual(doc["path"], "/contents/3")
            self.assertEqual(doc["fields"]["LossDate"], source["contents"][0]["fields"]["LossDate"])
            self.assertEqual(projected["context"], source["context"])
            self.assertEqual(projected["textEvidence"], source["textEvidence"][:1])
            prompt = check_prompt(source, check, questions, {
                "status": "conflicting", "reason": "Supplied evidence conflicts",
                "sourceReferences": ["RentalRequested", "parse./contents/3"],
            })
            self.assertIn(table, prompt)
            self.assertIn("UNTRUSTED first-pass parsed page text with provenance", prompt)
            if check != "Daily rate":
                self.assertNotIn("Shared rental applicability (derived interpretation", prompt)
            else:
                self.assertIn("NOT a new extracted CU field", prompt)
            self.assertNotIn("Unrelated ID OCR", prompt)
        self.assertEqual(source["textEvidence"][0]["text"], table)
        refs = claim_references(source)
        self.assertTrue({"LossDate", "Rental.Pickup", "parse./contents/3"} <= refs)
        self.assertNotIn("Packet OCR", refs)

    def test_empty_null_false_zero_are_not_conflated(self):
        source = {"contents": [{"category": "statement", "fields": {
            "LossDate": {"type": "string", "valueString": ""},
            "LossTime": {"type": "string", "valueString": None},
            "RentalRequested": {"type": "boolean", "valueBoolean": False},
            "RentalTotal": {"type": "number", "valueNumber": 0},
        }}]}
        text = fields_frontmatter(check_analysis(source, "Daily rate"))
        self.assertIn("LossDate", text)
        self.assertIn("LossTime", text)
        self.assertIn("RentalRequested: false", text)
        self.assertIn("RentalTotal: 0", text)

    def test_applicability_references_only_supplied_parse_fields_or_page_ids(self):
        analysis = {"contents": [{"fields": {
            "RentalRequested": {"type": "boolean", "valueBoolean": True},
        }}], "textEvidence": [{"id": "parse./contents/1", "text": "Rental agreement"}]}
        for references in (["RentalRequested"], ["parse./contents/1"]):
            runtime.validate_applicability(runtime.RentalApplicability(
                status="rental", reason="Supplied rental evidence", sourceReferences=references,
            ), analysis)
        runtime.validate_applicability(runtime.RentalApplicability(
            status="unknown", reason="No request established", sourceReferences=[],
        ), analysis)
        for references in ([], ["Packet OCR"], ["parse.invented"], ["Rental.Amount"]):
            with self.subTest(references=references), self.assertRaises(ValueError):
                runtime.validate_applicability(runtime.RentalApplicability(
                    status="rental", reason="Unsupported reference", sourceReferences=references,
                ), analysis)

    def test_dynamic_applicability_schema_constrains_exact_input_ids_and_aliases(self):
        analysis = {"contents": [{
            "category": "rental_invoice", "contentPath": "/contents/1", "pages": {"start": 2, "end": 2},
            "fields": {"LineItems": {"type": "array", "valueArray": [{
                "type": "object", "valueObject": {
                    "UnitPrice": {"type": "number", "valueNumber": 50},
                },
            }]}},
        }], "textEvidence": [{
            "id": "parse.input1/contents/1", "contentPath": "/contents/1",
            "pages": {"start": 2, "end": 2}, "text": "Rental base daily price: 50",
        }]}
        permitted = claim_references(analysis)
        self.assertIn("LineItems[0].UnitPrice", permitted)
        self.assertIn("rental_invoice.LineItems[0].UnitPrice", permitted)
        self.assertIn("parse.input1/contents/1", permitted)
        self.assertNotIn("rental_invoice.parse.input1/contents/1", permitted)
        self.assertNotIn("parse./contents/1", permitted)
        schema = runtime.applicability_schema(analysis)
        items = schema.model_json_schema()["properties"]["sourceReferences"]["items"]
        self.assertEqual(items["enum"], sorted(permitted))
        for reference in permitted:
            value = schema.model_validate({
                "status": "rental", "reason": "Supplied reference", "sourceReferences": [reference],
            })
            runtime.validate_applicability(value, analysis)
        for reference in ("parse./contents/1", "rental_invoice.UnitPrice", "Packet OCR"):
            with self.subTest(reference=reference), self.assertRaises(ValidationError):
                schema.model_validate({
                    "status": "rental", "reason": "Invented reference", "sourceReferences": [reference],
                })
            with self.assertRaisesRegex(ValueError, reference.replace(".", r"\.")):
                runtime.validate_applicability(runtime.RentalApplicability(
                    status="rental", reason="Invented reference", sourceReferences=[reference],
                ), analysis)
        # Every input gets its own schema; prior turn IDs aren't retained.
        next_schema = runtime.applicability_schema({"textEvidence": [{"id": "parse.input2/contents/0"}]})
        with self.assertRaises(ValidationError):
            next_schema.model_validate({
                "status": "rental", "reason": "Prior turn", "sourceReferences": ["parse.input1/contents/1"],
            })

    def test_empty_applicability_schema_allows_only_empty_references(self):
        schema = runtime.applicability_schema({"contents": [], "textEvidence": []})
        self.assertEqual(schema.model_json_schema()["properties"]["sourceReferences"]["maxItems"], 0)
        value = schema.model_validate({"status": "unknown", "reason": "Missing evidence", "sourceReferences": []})
        runtime.validate_applicability(value, {})
        with self.assertRaises(ValidationError):
            schema.model_validate({"status": "unknown", "reason": "Missing evidence",
                                   "sourceReferences": ["parse.invented"]})

    def test_check_prompt_lists_projected_exact_references_not_guessed_content_paths(self):
        analysis = {"contents": [{
            "kind": "document", "category": "statement", "contentPath": "/contents/1",
            "pages": {"start": 2, "end": 3},
            "fields": {"RentalRequested": {"type": "boolean", "valueBoolean": True},
                       "RentalDailyBaseRate": {"type": "number", "valueNumber": 50}},
        }], "textEvidence": [{
            "id": "parse.input1/contents/1", "category": "statement",
            "contentPath": "/contents/1", "pages": {"start": 2, "end": 3}, "text": "Rental requested: Yes",
        }]}
        questions = check_questions(
            runtime.ROOT / "docs" / "rental-review-agent-question-v2.md", runtime.CHECKS,
        )
        for check in runtime.CHECKS:
            prompt = check_prompt(analysis, check, questions)
            self.assertIn("Permitted exact claim references for sourceReferences and ClaimField", prompt)
            self.assertIn(json.dumps(sorted(claim_references(check_analysis(analysis, check)))), prompt)
            self.assertIn('"parse.input1/contents/1"', prompt)
            self.assertIn('"statement.RentalRequested"', prompt)
            self.assertNotIn('"parse./contents/1"', prompt)

    def test_compact_comparison_accepts_exact_typed_or_parse_references_only(self):
        analysis = {"contents": [{"fields": {
            "Rental": {"type": "object", "valueObject": {
                "DailyRates": {"type": "array", "valueArray": [
                    {"type": "number", "valueNumber": 50},
                ]},
            }},
        }}], "textEvidence": [{"id": "parse./contents/2", "text": "Base price 50 per day"}]}
        check = runtime.CompactCheck(
            **self.review().Checks[0].model_dump(), Headline="Daily price is within the limit",
            Comparisons=[runtime.Comparison(
                ClaimField="Rental.DailyRates[0]", ClaimLabel="Base daily price", ClaimValue="$50/day",
                PolicyField="Not retrieved", PolicyLabel="Policy cap", PolicyValue="Not established",
            )],
        )
        runtime.check_claim_references(check, analysis)
        check.Comparisons[0].ClaimField = "parse./contents/2"
        runtime.check_claim_references(check, analysis)
        for reference in ("Packet OCR", "InventedRentalRate", "parse./contents/9"):
            check.Comparisons[0].ClaimField = reference
            with self.subTest(reference=reference), self.assertRaises(ValueError):
                runtime.check_claim_references(check, analysis)

    def test_nonrental_gate_does_not_block_effective_terms(self):
        value = self.review()
        citation = runtime.Citation(
            File="tx.pdf", DocumentId="TX", Version="2.0", RuleId="TX-R2", Section="Schedule",
        )
        evidence = [dict(file="tx.pdf", documentId="TX", version="2.0",
                         ruleIds=["TX-R2"], citationSections=["Schedule"])]
        for check in value.Checks[:1]:
            check.Outcome = "NotApplicable"
            check.ReviewRequired = False
            check.Citation = [citation]
        value.Checks[1].Outcome = "Satisfied"
        value.Checks[1].ReviewRequired = False
        value.Checks[1].Citation = [citation]
        decision = runtime.RentalApplicability(
            status="nonrental", reason="Explicit no request", sourceReferences=["RentalRequested"],
        )
        runtime.check_shared_applicability(value, decision, "search")
        runtime.check_citations(value, evidence, "search")
        value.Checks[1].Outcome = "NotApplicable"
        with self.assertRaisesRegex(ValueError, "independent"):
            runtime.check_citations(value, evidence, "search")

    def test_shared_applicability_rejects_inconsistent_rental_outcomes(self):
        cases = {
            "rental": ("Satisfied", "InProgress"),
            "unknown": ("InProgress", "ReviewRequired"),
            "conflicting": ("ReviewRequired", "ReviewRequired"),
            "nonrental": ("NotApplicable", "NotApplicable"),
        }
        for status, outcomes in cases.items():
            value = self.review()
            decision = runtime.RentalApplicability(
                status=status, reason="Supplied source interpretation", sourceReferences=[],
            )
            for check, outcome in zip(value.Checks, outcomes):
                check.Outcome = outcome
                check.ReviewRequired = outcome == "ReviewRequired"
            runtime.check_shared_applicability(value, decision, "search")
            value.Checks[0].Outcome = "Satisfied" if status != "rental" else "NotApplicable"
            with self.subTest(status=status), self.assertRaises(ValueError):
                runtime.check_shared_applicability(value, decision, "search")
        # No-retrieval still cannot establish policy rules, even for nonrental.
        runtime.check_shared_applicability(self.review(), decision, "ungrounded")

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

    def test_model_schema_requires_exact_check_names_and_three_results(self):
        schema = runtime.Review.model_json_schema()
        self.assertEqual(schema["$defs"]["Check"]["properties"]["Check"]["enum"], runtime.CHECKS)
        self.assertEqual(schema["properties"]["Checks"]["minItems"], 3)
        self.assertEqual(schema["properties"]["Checks"]["maxItems"], 3)
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
        self.assertNotIn("ruleSections", value, "Initial-review evidence retains its existing schema.")
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


class FollowupFrameworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_followup_requires_server_selected_claim_evidence(self):
        with self.assertRaisesRegex(ValueError, "requires saved evidence"):
            await runtime.run(runtime.Turn(mode="search", chat=True, prompt="Follow-up",
                                          configPath="unused-config.json"))

    async def chat(self, respond, mode="search", page_to=1):
        manifest = runtime.ROOT / "data" / "policies" / "rental" / "ocr-comparison-v2" / "manifest.json"
        config = dict(
            schemaVersion=1, provider="agent-framework",
            azureOpenAIEndpoint="https://example.services.ai.azure.com",
            searchEndpoint="https://example.search.windows.net", indexName="offline-test-index",
            modelDeployment="gpt-5", corpusHash=hashlib.sha256(manifest.read_bytes()).hexdigest(),
            indexFingerprint="a" * 64, extractionMode="standard",
        )
        source = next(item for item in json.loads(manifest.read_text(encoding="utf-8"))["documents"]
                      if item.get("role") == "repair_review")
        row = dict(id="same-figure", file=source["pdf"], documentId=source["documentId"],
                   version=source["version"], sha256=source["sha256"],
                   corpusHash=config["corpusHash"], indexFingerprint=config["indexFingerprint"],
                   page=1, pageTo=page_to, content="Offline complete diagram fixture")
        analysis = {"contents": [{"category": "rental_invoice", "fields": {
            "DailyRate": {"type": "number", "valueNumber": 45},
        }}], "textEvidence": [{
            "id": "parse.invoice", "category": "rental_invoice",
            "pages": {"start": 2, "end": 3}, "text": "Saved complete invoice",
        }]}
        config_file = runtime.ROOT / "offline-chat-config.json"
        read_text = Path.read_text

        def read_config(path, *args, **kwargs):
            return json.dumps(config) if path == config_file else read_text(path, *args, **kwargs)

        with patch.object(Path, "read_text", read_config), \
                patch.object(runtime, "AzureCliCredential"), \
                patch.object(runtime, "get_bearer_token_provider", return_value=lambda: "offline-token"), \
                patch.object(runtime, "AsyncOpenAI"), patch.object(runtime, "OpenAIChatClient"), \
                patch.object(runtime, "SearchClient") as search, patch.object(runtime, "Agent") as agent:
            search.return_value.search.return_value = [row]

            async def answer(messages, options):
                tools = {fn.name: fn.func for fn in agent.call_args.kwargs["tools"]}
                self.assertNotIn("Evaluate only Daily rate", agent.call_args.kwargs["instructions"])
                self.assertNotIn("Saved complete invoice", messages[-1].text)
                value = respond(tools)
                return SimpleNamespace(text=json.dumps(value), usage_details={})

            agent.return_value.run.side_effect = answer
            turn = runtime.Turn(
                mode=mode, chat=True, prompt="Follow-up", lossState="WA",
                policyScope=runtime.PolicyScope(policyId="WA-ONLY", vin="ACTUAL-VIN"),
                claimAnalysis=analysis, configPath=str(config_file),
            )
            value = await runtime.run(turn)
            self.assertEqual(turn.lossState, "WA")
            return value, search.return_value.search.call_args_list

    async def test_hypothetical_az_and_actual_wa_keep_both_current_turn_citations(self):
        def respond(tools):
            az = json.loads(tools["search_policy_rules"]("repair routine authority", "AZ"))
            wa = json.loads(tools["search_policy_rules"]("repair routine authority"))
            self.assertTrue(az["hypothetical"])
            self.assertEqual(az["actualLossState"], "WA")
            self.assertEqual(az["retrievalState"], "AZ")
            self.assertFalse(wa["hypothetical"])
            citations = []
            for retrieved, state in ((az, "AZ"), (wa, "WA")):
                doc = retrieved["documents"][0]
                self.assertIn(f"REPAIR-{state}-01", doc["ruleIds"])
                self.assertIn("REPAIR-SCOPE-01", doc["ruleIds"])
                self.assertNotIn("REPAIR-IL-01", doc["ruleIds"])
                citations.append(dict(File=doc["file"], DocumentId=doc["documentId"],
                                      Version=doc["version"], RuleId=f"REPAIR-{state}-01",
                                      Section=doc["citationSections"][-1]))
            return dict(Answer="Hypothetical Arizona differs from the actual WA claim.", Citation=citations)
        value, searches = await self.chat(respond)
        self.assertEqual(value["retrievalCalls"], 2)
        self.assertEqual(len(value["retrieved"]), 2)
        for search in searches:
            self.assertNotIn("DEC-AZ", search.kwargs["filter"])
            self.assertIn("indexFingerprint", search.kwargs["filter"])

    async def test_claim_only_question_does_not_require_policy_search(self):
        def respond(tools):
            fields = json.loads(tools["get_claim_fields"]("rental_invoice"))
            self.assertEqual(fields["documents"][0]["fields"]["DailyRate"]["valueNumber"], 45)
            listed = json.loads(tools["get_claim_document_text"]())
            text = json.loads(tools["get_claim_document_text"](listed["documents"][0]["id"]))
            self.assertEqual(text["documents"][0]["text"], "Saved complete invoice")
            return dict(Answer="The saved invoice states 45.", Citation=[])
        value, searches = await self.chat(respond)
        self.assertEqual(value["retrievalCalls"], 0)
        self.assertEqual(searches, [])

    async def test_unsupported_hypothetical_reports_missing_evidence(self):
        def respond(tools):
            retrieved = json.loads(tools["search_policy_rules"]("repair authority", "NV"))
            self.assertEqual(retrieved["documents"], [])
            self.assertIn("reason", retrieved)
            return dict(Answer="No Nevada rule is represented in the policy index.", Citation=[])
        value, searches = await self.chat(respond)
        self.assertEqual(value["retrievalCalls"], 1)
        self.assertEqual(searches, [])

    async def test_ungrounded_chat_can_read_claims_but_not_search_policies(self):
        def respond(tools):
            self.assertNotIn("search_policy_rules", tools)
            self.assertIn("get_claim_fields", tools)
            self.assertIn("get_claim_document_text", tools)
            return dict(Answer="Policy rules cannot be established in this baseline.", Citation=[])
        await self.chat(respond, "ungrounded")

    async def test_followup_still_rejects_unretrieved_rules_and_invalid_states(self):
        manifest = runtime.ROOT / "data" / "policies" / "rental" / "ocr-comparison-v2"
        source = next(item for item in json.loads((manifest / "manifest.json").read_text(encoding="utf-8"))["documents"]
                      if item.get("role") == "repair_review")
        entry = next(item for item in json.loads((manifest / "citations.json").read_text(encoding="utf-8"))
                     if item["documentId"] == source["documentId"])

        def invented(tools):
            return dict(Answer="Invented threshold", Citation=[dict(
                File=source["pdf"], DocumentId=source["documentId"], Version=source["version"],
                RuleId="REPAIR-AZ-01", Section=next(iter(entry["sections"])),
            )])
        with self.assertRaisesRegex(ValueError, "not returned by this turn"):
            await self.chat(invented)

        def invalid(tools):
            tools["search_policy_rules"]("repair", "AZ' or true")
        with self.assertRaisesRegex(ValueError, "two-letter code"):
            await self.chat(invalid)

    async def test_followup_rejects_section_titles_invented_from_document_text(self):
        def invented_section(tools):
            doc = json.loads(tools["search_policy_rules"]("repair routine authority", "AZ"))["documents"][0]
            return dict(Answer="Hypothetical Arizona threshold", Citation=[dict(
                File=doc["file"], DocumentId=doc["documentId"], Version=doc["version"],
                RuleId="REPAIR-AZ-01", Section="Invented section title",
            )])

        with self.assertRaisesRegex(ValueError, "not returned by this turn"):
            await self.chat(invented_section)

    async def test_followup_can_cite_another_state_on_the_retrieved_shared_page(self):
        def respond(tools):
            doc = json.loads(tools["search_policy_rules"]("repair routine authority"))["documents"][0]
            self.assertIn("REPAIR-AZ-01", doc["ruleIds"])
            self.assertIn("REPAIR-WA-01", doc["ruleIds"])
            self.assertNotIn("REPAIR-IL-01", doc["ruleIds"])
            return dict(Answer="Hypothetical Arizona differs from the actual Washington claim.", Citation=[dict(
                File=doc["file"], DocumentId=doc["documentId"], Version=doc["version"],
                RuleId="REPAIR-AZ-01", Section=doc["ruleSections"]["REPAIR-AZ-01"][0],
            )])

        value, _ = await self.chat(respond)
        self.assertEqual(value["result"]["Citation"][0]["RuleId"], "REPAIR-AZ-01")

    async def test_followup_rejects_rules_on_an_unretrieved_page(self):
        def respond(tools):
            doc = json.loads(tools["search_policy_rules"]("repair routine authority"))["documents"][0]
            return dict(Answer="Unsupported Illinois threshold", Citation=[dict(
                File=doc["file"], DocumentId=doc["documentId"], Version=doc["version"],
                RuleId="REPAIR-IL-01", Section=doc["citationSections"][0],
            )])

        with self.assertRaisesRegex(ValueError, "not returned by this turn"):
            await self.chat(respond)

    async def test_claim_document_provenance_cannot_be_a_policy_citation(self):
        def respond(tools):
            tools["get_claim_document_text"]("statement-1")
            return dict(Answer="WA from saved statement page 2", Citation=[dict(
                File="claim_packet", DocumentId="statement-1", Version="n/a",
                RuleId="n/a", Section="Statement page 2",
            )])

        with self.assertRaisesRegex(ValueError, "not returned by this turn"):
            await self.chat(respond)
        self.assertIn("Empty for claim-only answers",
                      runtime.Answer.model_json_schema()["properties"]["Citation"]["description"])

    async def test_followup_preserves_rule_section_pairs_in_a_multi_page_chunk(self):
        def respond(tools):
            doc = json.loads(tools["search_policy_rules"]("repair routine authority", "AZ"))["documents"][0]
            self.assertIn("REPAIR-IL-01", doc["ruleIds"])
            return dict(Answer="Arizona rule with the wrong page", Citation=[dict(
                File=doc["file"], DocumentId=doc["documentId"], Version=doc["version"],
                RuleId="REPAIR-AZ-01", Section=doc["ruleSections"]["REPAIR-IL-01"][0],
            )])

        with self.assertRaisesRegex(ValueError, "not returned by this turn"):
            await self.chat(respond, page_to=2)


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
            "RentalDailyBaseRate": {"type": "number", "valueNumber": 0},
            "ActualRepairCompletion": {"type": "date"},
        }}]}
        config_file = runtime.ROOT / "offline-policy-framework-config.json"
        read_text = Path.read_text

        def read_config(path, *args, **kwargs):
            return json.dumps(config) if path == config_file else read_text(path, *args, **kwargs)

        with patch.object(Path, "read_text", read_config):
            for fail in (False, True, "reference"):
                with self.subTest(failing_call=fail):
                    active = maximum = 0
                    cancelled, prompts = [], {}
                    barrier = asyncio.Event()

                    async def respond(messages, options):
                        nonlocal active, maximum
                        prompt = messages[-1].text
                        if "Resolve rental applicability ONCE" in prompt:
                            self.assertIn("Permitted exact claim references", prompt)
                            schema = options["response_format"].model_json_schema()
                            self.assertEqual(
                                schema["properties"]["sourceReferences"]["items"]["enum"],
                                sorted(claim_references(analysis)),
                            )
                            return SimpleNamespace(text=json.dumps({
                                "status": "rental", "reason": "Explicit rental request",
                                "sourceReferences": ["parse.invented-input1"] if fail == "reference"
                                    else ["RentalRequested"],
                            }), usage_details={})
                        name = next(n for n in runtime.CHECKS if questions[n] in prompt)
                        prompts[name] = prompt
                        self.assertEqual(options["reasoning"], {"effort": "low"})
                        self.assertFalse(options["store"])
                        active += 1
                        maximum = max(maximum, active)
                        try:
                            if active == 3:
                                barrier.set()
                            await asyncio.wait_for(barrier.wait(), 2)
                            if fail:
                                if name == "Daily rate":
                                    raise RuntimeError("offline model failure")
                                await asyncio.sleep(10)
                            await asyncio.sleep((3 - runtime.CHECKS.index(name)) * 0.002)
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
                        if fail == "reference":
                            with self.assertRaisesRegex(
                                ValueError,
                                r"Rental applicability failed: .*unsupplied Parse evidence:.*parse\.invented-input1",
                            ):
                                await runtime.run(turn)
                            self.assertEqual(prompts, {})
                            self.assertEqual(cancelled, [])
                        elif fail:
                            with self.assertRaisesRegex(ValueError, "Daily rate failed: offline model failure"):
                                await runtime.run(turn)
                            self.assertEqual(len(cancelled), 2)
                        else:
                            value = await runtime.run(turn)
                            self.assertEqual([c["Check"] for c in value["result"]["Checks"]], runtime.CHECKS)
                            self.assertEqual(value["timings"]["modelRequests"], 4)
                            self.assertEqual(value["rentalApplicability"]["status"], "rental")
                            self.assertEqual(value["timings"]["applicability"]["modelDeployment"], "gpt-5")
                            self.assertNotIn("RentalDailyBaseRate", prompts["Repair estimate"])
                            self.assertIn("RentalDailyBaseRate: 0", prompts["Daily rate"])
                            for name, prompt in prompts.items():
                                if name != "Daily rate":
                                    self.assertNotIn("Shared rental applicability (derived interpretation", prompt)
                                else:
                                    self.assertIn("Shared rental applicability (derived interpretation", prompt)
                            for name, prompt in prompts.items():
                                for other in runtime.CHECKS:
                                    if other != name:
                                        self.assertNotIn(questions[other], prompt)
                        self.assertEqual(maximum, 0 if fail == "reference" else 3)
                        self.assertEqual(active, 0)
                        token.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
