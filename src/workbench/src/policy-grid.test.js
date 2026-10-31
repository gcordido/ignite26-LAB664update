import test from "node:test";
import assert from "node:assert/strict";
import {
  availableTypes,
  fieldColumns,
  policyChecks,
  policyColumns,
  policySummary,
  readableReferences,
  policyProblem,
} from "../web/result-model.js";

const check = (family, document, status = "pass") => ({
  id: `${family}:${document}`,
  status,
  rule: `Full description of ${family}; keep this text available in the tooltip.`,
  message: `${document}: ${status}`,
  evidence: [],
});
const result = (...checks) => ({ policies: { checks } });

test("problem presentation keeps zero evidence valid and removes repeated document prefixes", () => {
  const value = {
    ...check("financial.total", "8-9:0"),
    message:
      "Document 8-9:0: USD 0.00 + USD 0.00 tax = USD 0.00 expected; total is USD 0.00.",
    evidence: [
      {
        documentId: "8-9:0",
        field: "TotalAmount.Amount",
        value: 0,
        regions: [],
      },
    ],
  };
  const problem = policyProblem(value, [
    { id: "8-9:0", category: "rental_invoice", start: 8, end: 9 },
  ]);
  assert.deepEqual(problem.missing, []);
  assert.equal(
    problem.text,
    "USD 0.00 + USD 0.00 tax = USD 0.00 expected; total is USD 0.00.",
  );
});

test("missing currency metadata is not shown as a missing field but missing amounts remain visible", () => {
  const value = {
    ...check("financial.total", "repair", "not_checkable"),
    evidence: [
      { field: "SubtotalAmount.CurrencyCode", value: null },
      { field: "TotalTaxAmount.CurrencyCode", value: "" },
      { field: "TotalAmount.Amount", value: null },
    ],
  };
  assert.deepEqual(policyProblem(value, []).missing, ["TotalAmount.Amount"]);
});

test("a passing comparison does not report optional empty evidence as a missing required field", () => {
  const value = {
    ...check("financial.total", "repair"),
    message: "Amounts are consistent.",
    evidence: [
      { documentId: "id", field: "LastName", value: null, regions: [] },
    ],
  };
  assert.deepEqual(policyProblem(value, []).missing, []);
});

function lineItemResult(status, subtotal) {
  return {
    ...check("financial.line_items", "repair", status),
    message: "Original cached check message.",
    evidence: [
      { field: "LineItems[0].TotalAmount.Amount", value: 0.1 },
      { field: "LineItems[1].TotalAmount.Amount", value: 0.2 },
      { field: "LineItems[2].TotalAmount.Amount", value: 0 },
      { field: "SubtotalAmount.Amount", value: subtotal },
      { field: "SubtotalAmount.CurrencyCode", value: "USD" },
    ],
  };
}

test("line-item evidence shows the extracted addends, including zero, without changing the saved check", () => {
  const value = lineItemResult("pass", 0.3);
  assert.equal(
    policyProblem(value, []).text,
    "USD 0.10 + 0.20 + 0.00 = 0.30 (Subtotal)",
  );
  assert.equal(value.message, "Original cached check message.");
  assert.equal(value.status, "pass");
});

test("mismatched and cent-tolerated calculations never display a false equality to subtotal", () => {
  for (const [status, subtotal] of [["fail", 0.32], ["pass", 0.31]]) {
    const value = lineItemResult(status, subtotal);
    assert.equal(
      policyProblem(value, []).text,
      `USD 0.10 + 0.20 + 0.00 = 0.30; Subtotal = ${subtotal.toFixed(2)}`,
    );
    assert.equal(value.status, status);
  }
  const incomplete = lineItemResult("not_checkable", 0.3);
  assert.equal(policyProblem(incomplete, []).text, incomplete.message);
});

test("line-item expressions do not invent a currency when metadata is missing", () => {
  const value = lineItemResult("pass", 0.3);
  value.evidence = value.evidence.filter(
    (item) => !item.field.endsWith("CurrencyCode"),
  );
  assert.equal(
    policyProblem(value, []).text,
    "0.10 + 0.20 + 0.00 = 0.30 (Subtotal)",
  );
});

test("component fallback equations show the selected operands without a false missing-total warning", () => {
  const value = {
    ...check("financial.line_items", "repair"),
    evidence: [
      { field: "LineItems[0].PartsAmount", value: 980 },
      { field: "LineItems[0].LaborAmount", value: 223.2 },
      { field: "LineItems[1].TotalAmount.Amount", value: 186 },
      { field: "LineItems[2].PartAmount", value: 0 },
      { field: "LineItems[2].LaborAmount", value: 210.8 },
      { field: "SubtotalAmount.Amount", value: 1600 },
    ],
  };
  assert.deepEqual(policyProblem(value, []), {
    missing: [],
    text: "(980.00 + 223.20) + 186.00 + (0.00 + 210.80) = 1600.00 (Subtotal)",
  });
  value.status = "fail";
  value.evidence.at(-1).value = 1601;
  assert.deepEqual(policyProblem(value, []), {
    missing: [],
    text: "(980.00 + 223.20) + 186.00 + (0.00 + 210.80) = 1600.00; Subtotal = 1601.00",
  });
});

test("only the three renamed checks appear, even when legacy cached checks have errors", () => {
  const values = [
    result(
      check("financial.total", "repair"),
      check("cross.claimant_name", "packet"),
      check("financial.line_items", "repair"),
      check("cross.repair_estimates", "repair"),
      check("cross.vin", "packet"),
    ),
    result(
      check("financial.total", "rental"),
      check("cross.claimant_name", "packet"),
      check("financial.line_items", "rental"),
      check("cross.repair_estimates", "repair"),
      check("cross.vin", "packet", "not_checkable"),
      check("required.id", "card", "fail"),
    ),
  ];
  const primary = policyColumns(values);
  assert.deepEqual(primary.map((column) => [column.id, column.label]), [
    ["financial.total", "Total Amount, SubTotal, Tax verification"],
    ["financial.line_items", "Repair line items, SubTotal verification"],
    ["cross.repair_estimates", "Multiple Estimates Warning"],
  ]);
  assert.equal(policyChecks(values[1], "required.id").length, 0);
  assert.equal(policyChecks(values[1]).length, 3);
  assert.ok(
    primary.every(
      (column) =>
        column.label.split(" ").every((word) => word.length <= 12) &&
        column.summary.endsWith("?") &&
        column.description.includes("Full description"),
    ),
  );
});

test("review prose uses document types and pages instead of internal IDs without replacing partial identifiers", () => {
  const documents = [
    { id: "1-1:0", category: "repair_estimate", start: 1, end: 1 },
    { id: "11-11:0", category: "rental_invoice", start: 11, end: 12 },
  ];
  assert.equal(
    readableReferences(
      "Document 1-1:0: compare with document 11-11:0, then rerun document 1-1:0.",
      documents,
    ),
    "Repair Estimate (p1): compare with Rental Invoice (p11-12), then rerun Repair Estimate (p1).",
  );
  assert.equal(
    readableReferences(
      "Unknown ID 1-1:01 and key1-1:0 remain unchanged.",
      documents,
    ),
    "Unknown ID 1-1:01 and key1-1:0 remain unchanged.",
  );
});

test("one column groups every document instance and reports the worst outcome without hiding warnings", () => {
  const packet = result(
    check("financial.total", "repair", "pass"),
    check("financial.total", "rental", "not_checkable"),
    check("financial.total", "second", "fail"),
    check("financial.line_items", "repair"),
  );
  const checks = policyChecks(packet, "financial.total");
  assert.equal(checks.length, 3);
  const summary = policySummary(checks);
  assert.equal(summary.status, "fail");
  assert.deepEqual(summary.counts, { pass: 1, warn: 0, not_checkable: 1, fail: 1 });
  assert.equal(summary.total, 3);
  assert.equal(
    policySummary(checks.filter((check) => check.status !== "fail")).status,
    "not_checkable",
  );
  assert.equal(
    policyColumns([packet]).filter(
      (column) => column.id === "financial.total",
    ).length,
    1,
  );
});

test("known advisory warnings remain visible and distinct from uncheckable evidence and errors", () => {
  const advisory = check("cross.repair_estimates", "packet", "warn");
  const summary = policySummary([
    advisory,
    check("cross.repair_estimates", "other", "not_checkable"),
  ]);
  assert.equal(summary.status, "warn");
  assert.equal(summary.counts.warn, 1);
  assert.equal(summary.counts.not_checkable, 1);
  assert.equal(
    policySummary([advisory, check("cross.repair_estimates", "bad", "fail")]).status,
    "fail",
  );
  assert.equal(
    policyColumns([result(advisory)])[0].label,
    "Multiple Estimates Warning",
  );
});

test("missing and invalid check evidence never becomes a green pass", () => {
  assert.equal(
    policySummary(policyChecks(undefined, "financial.total")),
    undefined,
  );
  assert.equal(policySummary([]), undefined);
  assert.equal(
    policySummary([check("financial.total", "packet", "not_checkable")]).status,
    "not_checkable",
  );
  assert.throws(
    () => policySummary([check("financial.total", "packet", "invalid")]),
    /Unknown policy status/,
  );
});

test("unknown cached rule families cannot reintroduce removed checks", () => {
  const packet = result(
    check("custom.long_new_check_name", "document", "fail"),
  );
  const columns = policyColumns([packet]);
  assert.deepEqual(columns, []);
  assert.deepEqual(policyChecks(packet), []);
});

test("policy columns coexist with the existing native extraction views and empty-column behavior", () => {
  const native = {
    review: {
      segments: [
        {
          category: "statement",
          start: 1,
          end: 1,
          documents: [
            {
              fields: [
                {
                  kind: "scalar",
                  field: "claimant_name",
                  status: "present",
                  value: "Synthetic claimant",
                },
              ],
              facts: [],
            },
          ],
        },
      ],
    },
  };
  const withChecks = {
    ...native,
    ...result(check("financial.total", "repair")),
  };
  assert.ok(availableTypes([withChecks]).includes("policies"));
  assert.ok(availableTypes([withChecks]).includes("statement"));
  assert.deepEqual(
    fieldColumns([withChecks], "statement", false),
    fieldColumns([native], "statement", false),
  );
  assert.deepEqual(policyColumns([]), []);
});
