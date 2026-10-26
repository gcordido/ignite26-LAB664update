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

test("problem presentation identifies required fields even when no missing-field fact was returned", () => {
  const value = {
    ...check("required.id", "1-1:0", "fail"),
    message:
      "Document 1-1:0 is missing configured required field(s): last name (LastName). This is a schema assumption and advisory, not a person mismatch.",
    evidence: [
      {
        documentId: "1-1:0",
        field: "FirstName",
        value: "Priya Raman",
        regions: [],
      },
    ],
  };
  const problem = policyProblem(value, [
    { id: "1-1:0", category: "id_document", start: 1, end: 1 },
  ]);
  assert.deepEqual(problem.missing, ["LastName"]);
  assert.equal(value.evidence.length, 1);
});

test("problem presentation keeps zero evidence valid and removes repeated document prefixes", () => {
  const value = {
    ...check("financial.tax_details", "8-9:0"),
    message:
      "Document 8-9:0: tax details sum to USD 0.00; total tax is USD 0.00.",
    evidence: [
      {
        documentId: "8-9:0",
        field: "TotalTaxAmount.Amount",
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
    "tax details sum to USD 0.00; total tax is USD 0.00.",
  );
});

test("a passing comparison does not report optional empty evidence as a missing required field", () => {
  const value = {
    ...check("cross.claimant_name", "packet"),
    message: "Claimant names are consistent.",
    evidence: [
      { documentId: "id", field: "LastName", value: null, regions: [] },
    ],
  };
  assert.deepEqual(policyProblem(value, []).missing, []);
});

test("primary columns keep core checks and every warning/error, hiding other entirely clean checks", () => {
  const values = [
    result(
      check("financial.total", "repair"),
      check("cross.claimant_name", "packet"),
      check("financial.line_items", "repair"),
      check("required.repair", "repair"),
      check("cross.vin", "packet"),
    ),
    result(
      check("financial.total", "rental"),
      check("cross.claimant_name", "packet"),
      check("financial.line_items", "rental"),
      check("required.repair", "repair"),
      check("cross.vin", "packet", "not_checkable"),
      check("required.id", "card", "fail"),
    ),
  ];
  const primary = policyColumns(values);
  assert.ok(primary.some((column) => column.id === "financial.total"));
  assert.ok(primary.some((column) => column.id === "cross.claimant_name"));
  assert.ok(primary.some((column) => column.id === "cross.vin"));
  assert.ok(primary.some((column) => column.id === "required.id"));
  assert.equal(
    primary.some((column) => column.id === "financial.line_items"),
    false,
  );
  assert.equal(
    primary.some((column) => column.id === "required.repair"),
    false,
  );
  const all = policyColumns(values, true);
  assert.equal(all.length, 6);
  assert.ok(
    all.every(
      (column) =>
        column.label.split(" ").every((word) => word.length <= 12) &&
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
  assert.deepEqual(summary.counts, { pass: 1, not_checkable: 1, fail: 1 });
  assert.equal(summary.total, 3);
  assert.equal(
    policySummary(checks.filter((check) => check.status !== "fail")).status,
    "not_checkable",
  );
  assert.equal(
    policyColumns([packet], true).filter(
      (column) => column.id === "financial.total",
    ).length,
    1,
  );
});

test("missing and invalid check evidence never becomes a green pass", () => {
  assert.equal(
    policySummary(policyChecks(undefined, "financial.total")),
    undefined,
  );
  assert.equal(policySummary([]), undefined);
  assert.equal(
    policySummary([check("cross.vin", "packet", "not_checkable")]).status,
    "not_checkable",
  );
  assert.throws(
    () => policySummary([check("cross.vin", "packet", "invalid")]),
    /Unknown policy status/,
  );
});

test("new warning-bearing rule families are not silently dropped from the primary grid", () => {
  const packet = result(
    check("custom.long_new_check_name", "document", "fail"),
  );
  const columns = policyColumns([packet]);
  assert.equal(columns.length, 1);
  assert.equal(columns[0].id, "custom.long_new_check_name");
  assert.ok(columns[0].label.length <= 12);
  assert.equal(columns[0].description, packet.policies.checks[0].rule);
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
    ...result(check("required.statement", "statement")),
  };
  assert.ok(availableTypes([withChecks]).includes("policies"));
  assert.ok(availableTypes([withChecks]).includes("statement"));
  assert.deepEqual(
    fieldColumns([withChecks], "statement", false),
    fieldColumns([native], "statement", false),
  );
  assert.deepEqual(policyColumns([]), []);
});
