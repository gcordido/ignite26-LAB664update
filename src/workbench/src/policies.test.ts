import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePolicies, type PolicyDocument } from "./policies.ts";
import type { Fact, ResultField } from "./results.ts";

const regions = [{ page: 1, polygon: [0, 0, 1, 0, 1, 1, 0, 1] }];

function fact(field: string, value: Fact["value"]): Fact {
  return {
    field,
    value,
    status: value === null ? "missing" : "present",
    regions,
  };
}

function money(field: string, value: number | null, currency = "USD") {
  return [
    fact(field, value),
    fact(field.replace(/\.Amount$/, ".CurrencyCode"), currency),
  ];
}

function array(
  field: string,
  items: Fact[][],
): Extract<ResultField, { kind: "array" }> {
  return { kind: "array", field, count: items.length, items };
}

function document(
  id: string,
  category: string,
  facts: Fact[],
  fields: ResultField[] = [],
): PolicyDocument {
  return {
    id,
    category,
    analyzerId: `${category}-analyzer`,
    start: 1,
    end: 1,
    markdown: "",
    document: {
      analyzerId: `${category}-analyzer`,
      category,
      facts: [
        ...facts,
        ...fields.flatMap((field) =>
          field.kind === "array" ? field.items.flat() : [],
        ),
      ],
      fields,
    },
  };
}

function check(documents: PolicyDocument[], id: string) {
  const found = evaluatePolicies(documents).checks.find(
    (item) => item.id === id,
  );
  assert.ok(found, `missing check ${id}`);
  return found;
}

test("reports missing required fields and incomplete arrays without inventing zero", () => {
  const lineItems = array("LineItems", [
    [
      fact("LineItems[0].TotalAmount.Amount", null),
      fact("LineItems[0].TotalAmount.CurrencyCode", "USD"),
    ],
  ]);
  const repair = document(
    "repair-1",
    "repair_estimate",
    [
      ...money("SubtotalAmount.Amount", 10),
      ...money("TotalAmount.Amount", 10),
      fact("VendorName", "Body Shop"),
    ],
    [lineItems],
  );

  assert.equal(
    check([repair], "financial.line_items:repair-1").status,
    "not_checkable",
  );
  const required = check([repair], "required.repair:repair-1");
  assert.equal(required.status, "fail");
  assert.match(required.message, /vehicle \(vehicle\), VIN \(vin\)/);
});

test("uses integer cents and a one-cent reconciliation tolerance", () => {
  const nearItems = array("LineItems", [
    money("LineItems[0].TotalAmount.Amount", 0.1),
    money("LineItems[1].TotalAmount.Amount", 0.2),
  ]);
  const farItems = array("LineItems", [
    money("LineItems[0].TotalAmount.Amount", 0.1),
    money("LineItems[1].TotalAmount.Amount", 0.2),
  ]);
  const near = document(
    "near",
    "rental_invoice",
    [...money("SubtotalAmount.Amount", 0.31)],
    [nearItems],
  );
  const far = document(
    "far",
    "rental_invoice",
    [...money("SubtotalAmount.Amount", 0.32)],
    [farItems],
  );

  assert.equal(check([near], "financial.line_items:near").status, "pass");
  assert.equal(check([far], "financial.line_items:far").status, "fail");
});

test("reconciles subtotal plus tax without subtracting a deductible extracted as discount", () => {
  const repair = document("repair-2", "repair_estimate", [
    ...money("SubtotalAmount.Amount", 3454.8),
    ...money("TotalTaxAmount.Amount", 159.36),
    ...money("TotalDiscountAmount.Amount", 250),
    ...money("TotalAmount.Amount", 3614.16),
  ]);

  const total = check([repair], "financial.total:repair-2");
  assert.equal(total.status, "pass");
  assert.match(
    total.message,
    /USD 3454\.80 \+ USD 159\.36 tax = USD 3614\.16 expected; total is USD 3614\.16/,
  );
  assert.ok(total.evidence.every((item) => !item.field.includes("Discount")));
});

test("amount balance needs no discount but still requires explicit tax and respects cent tolerance", () => {
  const near = document("near-total", "rental_invoice", [
    ...money("SubtotalAmount.Amount", 0.1),
    ...money("TotalTaxAmount.Amount", 0.2),
    ...money("TotalAmount.Amount", 0.31),
  ]);
  const far = document("far-total", "rental_invoice", [
    ...money("SubtotalAmount.Amount", 0.1),
    ...money("TotalTaxAmount.Amount", 0.2),
    ...money("TotalAmount.Amount", 0.32),
  ]);
  const missing = document("missing-tax", "rental_invoice", [
    ...money("SubtotalAmount.Amount", 10),
    ...money("TotalAmount.Amount", 10),
  ]);
  assert.equal(check([near], "financial.total:near-total").status, "pass");
  assert.equal(check([far], "financial.total:far-total").status, "fail");
  assert.equal(
    check([missing], "financial.total:missing-tax").status,
    "not_checkable",
  );
});

test("makes mixed-currency and partial tax detail evidence not checkable", () => {
  const items = array("LineItems", [
    money("LineItems[0].TotalAmount.Amount", 10, "USD"),
    money("LineItems[1].TotalAmount.Amount", 5, "EUR"),
  ]);
  const taxes = array("TaxDetails", [
    money("TaxDetails[0].Amount.Amount", 1, "USD"),
    [
      fact("TaxDetails[1].Amount.Amount", null),
      fact("TaxDetails[1].Amount.CurrencyCode", "USD"),
    ],
  ]);
  const invoice = document(
    "invoice-1",
    "towing_invoice",
    [
      ...money("SubtotalAmount.Amount", 15, "USD"),
      ...money("TotalTaxAmount.Amount", 1, "USD"),
    ],
    [items, taxes],
  );

  assert.equal(
    check([invoice], "financial.line_items:invoice-1").status,
    "not_checkable",
  );
  assert.equal(
    check([invoice], "financial.tax_details:invoice-1").status,
    "not_checkable",
  );
});

test("normalizes claimant, VIN, and vehicle comparisons conservatively", () => {
  const id = document("id-1", "id_document", [
    fact("FirstName", "Jane"),
    fact("LastName", "Doe"),
  ]);
  const repair = document("repair-3", "repair_estimate", [
    fact("CustomerName", " jane-doe "),
    fact("VendorName", "Jane's Auto"),
    fact("vehicle", "2024 Ford F-150 XLT"),
    fact("vin", "1ab-cd 234"),
    ...money("TotalAmount.Amount", 100),
  ]);
  const statement = document("statement-1", "statement", [
    fact("claimant_name", "JANE DOE"),
    fact("incident_date", "2026-10-01"),
    fact("vehicle", "2024 ford f150, xlt"),
    fact("vin", "1ABCD234"),
  ]);
  const documents = [id, repair, statement];

  assert.equal(check(documents, "cross.claimant_name").status, "pass");
  assert.equal(check(documents, "cross.vin").status, "pass");
  assert.equal(check(documents, "cross.vehicle").status, "pass");
  assert.equal(
    check(documents, "required.statement:statement-1").status,
    "pass",
  );
});

test("excludes tax parties and vendor names from cross-document identity checks", () => {
  const id = document("id-2", "id_document", [
    fact("FirstName", "Alex"),
    fact("LastName", "Kim"),
  ]);
  const repair = document("repair-4", "repair_estimate", [
    fact("CustomerName", "Alex Kim"),
    fact("VendorName", "Someone Else LLC"),
    fact("vehicle", "2023 Toyota Camry"),
    fact("vin", "JT123"),
    ...money("TotalAmount.Amount", 250),
  ]);
  const tax = document("tax-1", "tax_1099a", [
    fact("Borrower.Name", "Wrong Person"),
    fact("CustomerName", "Also Wrong"),
    fact("vehicle", "Wrong Vehicle"),
    fact("vin", "WRONGVIN"),
  ]);
  const documents = [tax, repair, id];

  assert.equal(check(documents, "cross.claimant_name").status, "pass");
  assert.equal(check(documents, "cross.vin").status, "not_checkable");
  assert.equal(check(documents, "cross.vehicle").status, "not_checkable");
});

test("reports missing configured ID schema fields without splitting a full first name", () => {
  const id = document("id-priya", "id_document", [
    fact("FirstName", "Priya Raman"),
    fact("LastName", null),
    fact("DocumentNumber", "D12345"),
  ]);

  const required = check([id], "required.id:id-priya");
  assert.equal(required.status, "fail");
  assert.match(required.message, /last name \(LastName\)/);
  assert.match(required.message, /schema assumption and advisory/);
  assert.match(required.message, /not a person mismatch/);
  assert.deepEqual(
    required.evidence.map((item) => [item.field, item.value]),
    [
      ["FirstName", "Priya Raman"],
      ["LastName", null],
      ["DocumentNumber", "D12345"],
    ],
  );
});

test("allows zero unsupported adjustments and rejects unsafe aggregate cents", () => {
  const zeroBalance = document("zero-balance", "rental_invoice", [
    ...money("SubtotalAmount.Amount", 100),
    ...money("TotalTaxAmount.Amount", 10),
    ...money("TotalDiscountAmount.Amount", 5),
    ...money("TotalAmount.Amount", 110),
    fact("BalanceForward.Amount", 0),
  ]);
  const hugeItems = array("LineItems", [
    money("LineItems[0].TotalAmount.Amount", 46_000_000_000_000),
    money("LineItems[1].TotalAmount.Amount", 46_000_000_000_000),
  ]);
  const huge = document(
    "huge",
    "towing_invoice",
    [...money("SubtotalAmount.Amount", 46_000_000_000_000)],
    [hugeItems],
  );

  assert.equal(
    check([zeroBalance], "financial.total:zero-balance").status,
    "pass",
  );
  const overflow = check([huge], "financial.line_items:huge");
  assert.equal(overflow.status, "not_checkable");
  assert.match(overflow.message, /exceeds safe integer precision/);
});
