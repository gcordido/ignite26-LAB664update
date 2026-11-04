"""Original Parse projection and verified diagram scope; no Azure requests."""

import importlib.util
import json
from pathlib import Path
import sys
import unittest

from policy_check_inputs import check_analysis, check_evidence, check_prompt, check_questions

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("repair_runtime", ROOT / "infra" / "policy-framework-agent.py")
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)


class RepairCheckTests(unittest.TestCase):
    def test_original_eleven_gross_totals_are_not_net_amounts_or_summed_tax(self):
        expected = [[2233.8], [1842], [1699.04, 1827.24], [2002.38], [1310.13],
                    [2728.13], [13219.35], [1691.08], [3614.16], [3711.7]]
        for number, totals in enumerate(expected, 1):
            raw = json.loads((ROOT / "data" / "results" / "c12569eb-cf4b-479a-9f57-d6bf57fb5732"
                              / f"packet-{number:02}.cu.json").read_text(encoding="utf-8"))
            analysis = {"contents": raw["result"]["contents"]}
            projected = check_analysis(analysis, "Repair estimate")
            quotes = [doc for doc in projected["contents"] if doc.get("category") == "repair_estimate"]
            self.assertEqual([doc["fields"]["TotalAmount"]["valueObject"]["Amount"]["valueNumber"]
                              for doc in quotes], totals)
            for doc in quotes:
                self.assertEqual(doc["fields"]["TotalAmount"]["valueObject"]["CurrencyCode"]["valueString"], "USD")
                self.assertIn("InvoiceId", doc["fields"])
                self.assertIn("vin", doc["fields"])
                self.assertIn("TotalTaxAmount", doc["fields"])
            self.assertFalse(any(doc.get("category") in ("rental_invoice", "towing_invoice")
                                 for doc in projected["contents"]))

    def test_unknown_currency_zero_false_and_quote_identity_are_preserved(self):
        fields = {
            "TotalAmount": {"type": "object", "valueObject": {
                "Amount": {"type": "number", "valueNumber": 0},
                "CurrencyCode": {"type": "string", "valueString": None}}},
            "InvoiceId": {"type": "string", "valueString": "Q-1"},
            "RentalRequested": {"type": "boolean", "valueBoolean": False},
        }
        source = {"contents": [{"category": "repair_estimate", "contentPath": "input1/segment1",
                                "pages": {"start": 2, "end": 3}, "fields": fields}]}
        projected = check_analysis(source, "Repair estimate")
        self.assertEqual(projected["contents"][0], source["contents"][0])
        self.assertNotIn("TotalAmount", check_analysis(source, "Daily rate")["contents"][0]["fields"])

    def test_state_rule_pages_are_whole_and_never_rental_authority(self):
        source = {"role": "repair_review", "documentType": "repair_review_sop",
                  "stateRules": {"TX": {"page": 1, "ruleId": "REPAIR-TX-01"},
                                 "IL": {"page": 2, "ruleId": "REPAIR-IL-01"}}}
        evidence = [dict(file="repair.pdf", page=n, pageTo=n, content=f"Entire diagram {n}")
                    for n in (1, 2)]
        sources = {"repair.pdf": source}
        self.assertEqual(check_evidence(evidence, sources, "Repair estimate", "TX"), evidence[:1])
        self.assertEqual(check_evidence(evidence, sources, "Repair estimate", "IL"), evidence[1:])
        self.assertEqual(check_evidence(evidence, sources, "Repair estimate", None), evidence)
        self.assertEqual(check_evidence(evidence, sources, "Repair estimate", "AK"), [])
        for name in runtime.CHECKS[:-1]:
            self.assertEqual(check_evidence(evidence, sources, name, "TX"), [])

    def test_unknown_state_retrieves_only_common_scope_without_substitution(self):
        source = {"documentId": "REPAIR", "role": "repair_review", "states": ["TX", "WA"]}
        sources = {"repair.pdf": source, "contract.pdf": {
            "documentId": "CONTRACT", "documentType": "policy_contract", "states": ["TX"]}}
        config = dict(extractionMode="layout", corpusHash="a" * 64, indexFingerprint="b" * 64)
        selected = runtime.retrieval_filter(config, sources, None)
        self.assertIn("'REPAIR'", selected)
        self.assertNotIn("CONTRACT", selected)
        self.assertNotIn("stateCodes/any", selected)
        self.assertFalse(runtime.applicable_source(source, "AK"))

    def test_repair_prompt_is_independent_and_requires_exact_gross_quote_semantics(self):
        questions = check_questions(ROOT / "docs" / "rental-review-agent-question-v2.md", runtime.CHECKS)
        prompt = check_prompt({"contents": []}, "Repair estimate", questions,
                             {"status": "nonrental", "reason": "No rental", "sourceReferences": []})
        self.assertNotIn("Shared rental applicability (derived interpretation", prompt)
        normalized = " ".join(prompt.split())
        for phrase in ("BEFORE deductible", "exact decimal cents", "inclusive state threshold",
                       "alternate quotes SEPARATELY", "Duplicate pages", "supplement",
                       "Business rules validation", "actual CLAIM LOSS STATE", "NotApplicable requires",
                       "Currency must be established as USD", "genuinely different VIN",
                       "return InProgress even when each visible amount separately fits"):
            self.assertIn(phrase, normalized)
        self.assertNotIn("2,500", prompt, "Thresholds must come from indexed diagram, not a prompt table.")

    def test_scoped_output_schema_uses_verified_identifiers_not_printed_ocr_labels(self):
        analysis = {"textEvidence": [{"id": "parse.original-quote"}]}
        evidence = [dict(file="repair.pdf", documentId="REPAIR", version="1.0",
                         ruleIds=["REPAIR-TX-01"], citationSections=["Figure RE-1"])]
        schema = runtime.check_schema("Repair estimate", analysis, evidence, True)
        value = dict(
            Check="Repair estimate", Outcome="Satisfied", ReviewRequired=False,
            Headline="Quote is within routine authority", ExpectedValue="At most the state threshold",
            ActualValue="Original gross total", Reason="Gross total fits", Citation=[
                dict(File="repair.pdf", DocumentId="REPAIR", Version="1.0",
                     RuleId="REPAIR-TX-01", Section="Figure RE-1")],
            Comparisons=[dict(ClaimField="parse.original-quote", ClaimLabel="Quote total",
                              ClaimValue="USD 2,500.00", PolicyField="REPAIR-TX-01",
                              PolicyLabel="Inclusive routine authority", PolicyValue="USD 2,500.00")])
        parsed = schema.model_validate(value)
        runtime.check_citations(parsed, evidence, "search")
        runtime.check_claim_references(parsed, analysis)
        for field, replacement in (("RuleId", "REPAIR-WA-01"), ("Section", "OCR node label"),
                                   ("File", "another.pdf"), ("Version", "2.0")):
            changed = json.loads(json.dumps(value))
            changed["Citation"][0][field] = replacement
            with self.subTest(field=field), self.assertRaises(ValueError):
                schema.model_validate(changed)
        value["Comparisons"][0]["ClaimField"] = "parse.invented"
        with self.assertRaises(ValueError):
            schema.model_validate(value)
        no_rules = runtime.check_schema("Repair estimate", analysis, [], True)
        value["Comparisons"][0]["ClaimField"] = "parse.original-quote"
        with self.assertRaises(ValueError):
            no_rules.model_validate(value)


if __name__ == "__main__":
    unittest.main()
