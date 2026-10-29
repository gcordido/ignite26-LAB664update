"""Offline policy/vehicle isolation checks; no Azure calls."""

import importlib.util
from pathlib import Path
import sys
import unittest

spec = importlib.util.spec_from_file_location(
    "policy_evidence_runtime", Path(__file__).with_name("policy-framework-agent.py"),
)
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)
setup_spec = importlib.util.spec_from_file_location(
    "policy_evidence_setup", Path(__file__).with_name("setup-policy-index.py"),
)
setup = importlib.util.module_from_spec(setup_spec)
setup_spec.loader.exec_module(setup)


class PolicyEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.scope = runtime.PolicyScope(policyId="POLICY-A", vin="7FARW1H55NA510781")
        self.sources = {
            "tx.pdf": dict(documentId="TX", states=["TX"], documentType="state_sop"),
            "wa.pdf": dict(documentId="WA", states=["WA"], documentType="state_sop"),
            "shared.pdf": dict(documentId="SHARED", states=["TX", "WA"], documentType="shared_standard"),
            "contract.pdf": dict(documentId="CONTRACT", states=["TX"], documentType="policy_contract",
                                 policyScope=self.scope.model_dump()),
        }

    def test_contract_requires_both_exact_policy_and_insured_vin(self):
        contract = self.sources["contract.pdf"]
        self.assertTrue(runtime.applicable_source(contract, "TX", self.scope))
        for scope in (None, runtime.PolicyScope(), runtime.PolicyScope(policyId="POLICY-A"),
                      runtime.PolicyScope(vin=self.scope.vin),
                      runtime.PolicyScope(policyId="OTHER", vin=self.scope.vin),
                      runtime.PolicyScope(policyId="POLICY-A", vin="2T1BURHE8JC099321")):
            with self.subTest(scope=scope):
                self.assertFalse(runtime.applicable_source(contract, "TX", scope))
        self.assertFalse(runtime.applicable_source(contract, "WA", self.scope))

    def test_layout_and_standard_filters_keep_sops_without_leaking_contracts(self):
        for mode in ("layout", "standard"):
            config = dict(extractionMode=mode, corpusHash="a" * 64, indexFingerprint="b" * 64)
            with self.subTest(mode=mode):
                scoped = runtime.retrieval_filter(config, self.sources, "TX", self.scope)
                self.assertIn("'TX,SHARED,CONTRACT'", scoped)
                unscoped = runtime.retrieval_filter(config, self.sources, "TX")
                self.assertIn("'TX,SHARED'", unscoped)
                self.assertNotIn("CONTRACT", unscoped)
                self.assertNotIn("'WA", scoped)
                self.assertIn(config["corpusHash"], scoped)
                self.assertIn(config["indexFingerprint"], scoped)

    def test_returned_evidence_is_checked_against_scope(self):
        config = dict(extractionMode="layout", corpusHash="a" * 64, indexFingerprint="b" * 64)
        source = {**self.sources["contract.pdf"], "version": "2026-02-01",
                  "sha256": "c" * 64, "ruleIds": ["R.4"]}
        row = dict(id="contract", file="contract.pdf", documentId="CONTRACT",
                   version=source["version"], sha256=source["sha256"], stateCodes=["TX"],
                   ruleIds=["R.4"], corpusHash=config["corpusHash"],
                   indexFingerprint=config["indexFingerprint"], page=1, section="R.4",
                   content="R.4 Limits and charges\nR.5 Evidence and other payments")
        citations = {"CONTRACT": {"sections": {"R.4": 1, "R.5": 1}}}
        sources = {"contract.pdf": source}
        value = runtime.source_evidence(row, config, sources, citations, "TX", self.scope)
        self.assertEqual(value["citationSections"], ["R.4", "R.5"])
        with self.assertRaises(ValueError):
            runtime.source_evidence(row, config, sources, citations, "TX")

    def test_first_three_check_names_are_the_evidence_scenarios(self):
        self.assertEqual(runtime.CHECKS[:3], ["Amount", "Timing", "Effective terms"])
        self.assertEqual(len(runtime.CHECKS), 5)
        self.assertIn("policyScope", runtime.Turn.model_fields)

    def test_flat_claim_schema_uses_literal_facts_without_boolean_defaults(self):
        definition = setup.claim_evidence_analyzer_definition()
        fields = definition["fieldSchema"]["fields"]
        self.assertTrue({"PolicyId", "InsuredVIN", "LossDate", "DrivabilityEvidence",
                         "ActualRepairDelivery", "ActualRepairCompletion", "RentalRequested",
                         "RentalUsed", "RequestTypeEvidence"} <= set(fields))
        self.assertTrue(all(field["method"] == "extract" for field in fields.values()))
        self.assertTrue(all(field["type"] in ("string", "number", "boolean") for field in fields.values()))
        self.assertTrue(all("default" not in field for field in fields.values()))
        self.assertEqual(fields["RentalRequested"]["type"], "boolean")
        self.assertEqual(fields["RentalUsed"]["type"], "boolean")
        self.assertIn("neither true nor false", fields["RentalRequested"]["description"])
        self.assertIn("TOWING REQUESTED", fields["RentalRequested"]["description"])
        self.assertIn("field label", fields["RequestTypeEvidence"]["description"])
        for name, field in fields.items():
            if name.startswith("Rental") and name not in ("RentalRequested", "RentalUsed"):
                with self.subTest(field=name):
                    self.assertIn("Never copy a repair estimate", field["description"])
        self.assertNotIn("$85", str(fields))
        self.assertNotIn("Danielle", str(fields))


if __name__ == "__main__":
    unittest.main()
