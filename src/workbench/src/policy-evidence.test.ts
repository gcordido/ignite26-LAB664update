import assert from "node:assert/strict";
import { test } from "node:test";
import { checkNames, question, resolveCitations } from "./policy-core.ts";

test("the evidence scenarios lead the five-check contract and retain eligibility safeguards", async () => {
  assert.deepEqual(checkNames, [
    "Amount", "Timing", "Effective terms",
    "Charges and reimbursement calculation", "Authorization and payment readiness",
  ]);
  const prompt = await question();
  assert.match(prompt, /1\. Amount\.\n2\. Timing\.\n3\. Effective terms\./);
  assert.match(prompt, /policy ID AND\ninsured VIN/);
  assert.match(prompt, /blank optional-code cell stays missing\/null/);
  assert.match(prompt, /actual delivery, not an appointment/);
  assert.match(prompt, /Use the actual CU loss date/);
});

test("contract citations open the registered, hash-verified PDF pages", async () => {
  const inputs = [
    { File: "01-revised-declarations.pdf", DocumentId: "DEC-TX-01",
      Version: "2026-02-01", RuleId: "DEC-TX-01", Section: "COVERAGE SCHEDULE" },
    { File: "02-rental-terms-and-diagram.pdf", DocumentId: "RNT-TX-01",
      Version: "2025-09", RuleId: "Figure R-1", Section: "Rental eligibility at a glance" },
    { File: "03-scanned-midterm-endorsement.pdf", DocumentId: "END-02",
      Version: "2026-02-01", RuleId: "END-02", Section: "CARRIER ISSUANCE" },
  ];
  const [citations] = await resolveCitations({ Checks: [{ Citation: inputs }] });
  for (const [index, citation] of citations.entries()) {
    assert.equal(citation.href,
      `/data/policies/rental/ocr-comparison-v2/${inputs[index].File}#page=${index === 1 ? 2 : 1}`);
  }
  const [[wrong]] = await resolveCitations({
    Checks: [{ Citation: [{ ...inputs[0], Section: "Invented heading" }] }],
  });
  assert.equal(wrong.href, null);
});
