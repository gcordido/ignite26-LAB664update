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

function money(
  field: string,
  value: number | null,
  currency: string | null = "USD",
) {
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

test("reports incomplete line items without inventing zero or requiring repair completeness", () => {
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
  assert.ok(
    evaluatePolicies([repair]).checks.every(
      (item) => !item.id.startsWith("required.repair:"),
    ),
  );
});

test("differing repair estimates warn with both shops, quote references and amounts", () => {
  const first = document("repair-a", "repair_estimate", [
    fact("VendorName", "Desert Gate Auto Works"),
    fact("InvoiceId", "Q-AZ-16611"),
    ...money("TotalAmount.Amount", 1699.04),
  ]);
  const second = document("repair-b", "repair_estimate", [
    fact("VendorName", "Sonoran Ridge\nAuto Repair"),
    fact("InvoiceId", "SR-250723-0487"),
    ...money("TotalAmount.Amount", 1827.24),
  ]);
  const towing = document("towing", "towing_invoice", [
    fact("VendorName", "Recovery Tow"),
    ...money("TotalAmount.Amount", 200),
  ]);
  const report = evaluatePolicies([second, towing, first]);
  const comparison = report.checks.find(
    (item) => item.id === "cross.repair_estimates",
  );
  assert.ok(comparison);
  assert.equal(comparison.status, "warn");
  assert.match(comparison.message, /Desert Gate Auto Works.*Q-AZ-16611.*USD 1699\.04/);
  assert.match(comparison.message, /Sonoran Ridge Auto Repair.*SR-250723-0487.*USD 1827\.24/);
  assert.deepEqual(
    [...new Set(comparison.evidence.map((item) => item.documentId))],
    ["repair-a", "repair-b"],
  );
  assert.ok(comparison.evidence.every((item) => item.regions.length === 1));
  assert.equal(report.counts.warn, 1);
  assert.equal(report.counts.fail, 0);
});

test("one repair estimate or matching totals do not produce a multiple-estimate warning", () => {
  const first = document("first", "repair_estimate", [
    fact("VendorName", "First Shop"),
    ...money("TotalAmount.Amount", 100),
  ]);
  const second = document("second", "repair_estimate", [
    fact("VendorName", "Second Shop"),
    ...money("TotalAmount.Amount", 100),
  ]);
  assert.equal(check([first], "cross.repair_estimates").status, "pass");
  assert.equal(check([first, second], "cross.repair_estimates").status, "pass");
  assert.ok(
    evaluatePolicies([document("invoice", "rental_invoice", [])]).checks.every(
      (item) => item.id !== "cross.repair_estimates",
    ),
  );
});

test("missing or conflicting-currency quote totals are not treated as an equal comparison", () => {
  const first = document("first", "repair_estimate", [
    fact("VendorName", "First Shop"),
    ...money("TotalAmount.Amount", 100, "USD"),
  ]);
  for (const [amount, currency] of [[null, "USD"], [100, "EUR"]] as const) {
    const second = document("second", "repair_estimate", [
      fact("VendorName", "Second Shop"),
      ...money("TotalAmount.Amount", amount, currency),
    ]);
    const comparison = check([first, second], "cross.repair_estimates");
    assert.equal(comparison.status, "not_checkable");
    assert.match(comparison.message, /First Shop/);
    assert.match(comparison.message, /Second Shop/);
  }
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
    "repair_estimate",
    [...money("SubtotalAmount.Amount", 0.31)],
    [nearItems],
  );
  const far = document(
    "far",
    "repair_estimate",
    [...money("SubtotalAmount.Amount", 0.32)],
    [farItems],
  );

  assert.equal(check([near], "financial.line_items:near").status, "pass");
  assert.equal(check([far], "financial.line_items:far").status, "fail");
});

test("repair sums fall back to both components only when the row total is missing", () => {
  const items = array("LineItems", [
    [
      ...money("LineItems[0].TotalAmount.Amount", null),
      fact("LineItems[0].PartAmount", 980),
      fact("LineItems[0].LaborAmount", 223.2),
    ],
    [
      ...money("LineItems[1].TotalAmount.Amount", 186),
      fact("LineItems[1].PartAmount", 500),
      fact("LineItems[1].LaborAmount", 500),
    ],
    [
      ...money("LineItems[2].TotalAmount.Amount", 0),
      fact("LineItems[2].PartAmount", 9),
      fact("LineItems[2].LaborAmount", 9),
    ],
  ]);
  const repair = document("components", "repair_estimate", money("SubtotalAmount.Amount", 1389.2), [items]);
  const value = check([repair], "financial.line_items:components");
  assert.equal(value.status, "pass");
  assert.ok(value.evidence.some((item) => item.field === "LineItems[0].PartAmount"));
  assert.ok(value.evidence.some((item) => item.field === "LineItems[0].LaborAmount"));
  assert.ok(value.evidence.every((item) => item.field !== "LineItems[0].TotalAmount.Amount"));
  assert.ok(value.evidence.every((item) => !/^LineItems\[[12]\]\.(PartAmount|LaborAmount)$/.test(item.field)));
  assert.equal(items.items[0][0].value, null);
  assert.equal(items.items[2][0].value, 0);
});

test("explicit invalid or mismatched row totals are not hidden by component fallback", () => {
  for (const [total, status] of [[50, "fail"], [Infinity, "not_checkable"]] as const) {
    const repair = document("explicit", "repair_estimate", money("SubtotalAmount.Amount", 100), [
      array("LineItems", [[
        ...money("LineItems[0].TotalAmount.Amount", total),
        fact("LineItems[0].PartAmount", 50),
        fact("LineItems[0].LaborAmount", 50),
      ]]),
    ]);
    assert.equal(check([repair], "financial.line_items:explicit").status, status);
  }
});

test("component fallback accepts PartsAmount and preserves the actual source field name", () => {
  const repair = document("parts", "repair_estimate", money("SubtotalAmount.Amount", 1203.2), [
    array("LineItems", [[
      ...money("LineItems[0].TotalAmount.Amount", null),
      fact("LineItems[0].PartsAmount", 980),
      fact("LineItems[0].LaborAmount", 223.2),
    ]]),
  ]);
  const value = check([repair], "financial.line_items:parts");
  assert.equal(value.status, "pass");
  assert.ok(value.evidence.some((item) => item.field === "LineItems[0].PartsAmount"));
  assert.ok(value.evidence.every((item) => item.field !== "LineItems[0].PartAmount"));
});

test("component fallback requires both finite amounts and a subtotal", () => {
  for (const [part, labor, subtotal] of [
    [null, 10, 10], [10, null, 10], [NaN, 10, 10],
    [10, Infinity, 10], [0, 10, null],
  ] as const) {
    const repair = document("missing-component", "repair_estimate", money("SubtotalAmount.Amount", subtotal), [
      array("LineItems", [[
        ...money("LineItems[0].TotalAmount.Amount", null),
        fact("LineItems[0].PartAmount", part),
        fact("LineItems[0].LaborAmount", labor),
      ]]),
    ]);
    assert.equal(check([repair], "financial.line_items:missing-component").status, "not_checkable");
  }
});

test("component fallback preserves currency validation, cent tolerance and safe precision", () => {
  for (const [currency, part, labor, subtotal, subtotalCurrency, status] of [
    [null, 0.1, 0.2, 0.31, null, "pass"],
    [null, 0.1, 0.2, 0.32, null, "fail"],
    ["EUR", 5, 5, 10, "USD", "not_checkable"],
    ["invalid", 5, 5, 10, "USD", "not_checkable"],
    [null, 46_000_000_000_000, 46_000_000_000_000, 0, null, "not_checkable"],
  ] as const) {
    const repair = document("component-currency", "repair_estimate", money("SubtotalAmount.Amount", subtotal, subtotalCurrency), [
      array("LineItems", [[
        ...money("LineItems[0].TotalAmount.Amount", null, currency),
        fact("LineItems[0].PartAmount", part),
        fact("LineItems[0].LaborAmount", labor),
      ]]),
    ]);
    const value = check([repair], "financial.line_items:component-currency");
    assert.equal(value.status, status);
    if (currency === null && subtotalCurrency === null)
      assert.doesNotMatch(value.message, /USD|undefined/);
  }
});

test("checks repair-only item sums, retains amount balances, and ignores tax-detail sums", () => {
  const documents = [
    "repair_estimate",
    "towing_invoice",
    "rental_invoice",
  ].map((category) =>
    document(
      category,
      category,
      [
        ...money("SubtotalAmount.Amount", 10),
        ...money("TotalTaxAmount.Amount", 1),
        ...money("TotalAmount.Amount", 11),
      ],
      [
        array("LineItems", [money("LineItems[0].TotalAmount.Amount", 5)]),
        array("TaxDetails", [money("TaxDetails[0].Amount.Amount", 9)]),
      ],
    ),
  );
  const checks = evaluatePolicies(documents).checks;
  const lineItems = checks.filter((check) =>
    check.id.startsWith("financial.line_items:"),
  );
  assert.deepEqual(
    lineItems.map((check) => check.id),
    ["financial.line_items:repair_estimate"],
  );
  assert.equal(lineItems[0].status, "fail");
  for (const { id } of documents)
    assert.equal(
      checks.find((check) => check.id === `financial.total:${id}`)?.status,
      "pass",
    );
  assert.equal(
    checks.some((check) => check.id.startsWith("financial.tax_details:")),
    false,
  );
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

test("amount balance needs no discount, requires tax evidence, and respects cent tolerance", () => {
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

test("amount balance sums all tax details when total tax is absent or null", () => {
  for (const missing of [[], money("TotalTaxAmount.Amount", null)]) {
    for (const [amount, status] of [
      [110, "pass"],
      [111, "fail"],
    ] as const) {
      const invoice = document(
        "tax-fallback",
        "rental_invoice",
        [
          ...money("SubtotalAmount.Amount", 100),
          ...money("TotalAmount.Amount", amount),
          ...missing,
        ],
        [
          array("TaxDetails", [
            money("TaxDetails[0].Amount.Amount", 6),
            money("TaxDetails[1].Amount.Amount", 4),
          ]),
        ],
      );
      const total = check([invoice], "financial.total:tax-fallback");
      assert.equal(total.status, status);
      assert.match(total.message, /USD 10\.00 tax \(sum of tax details\)/);
      assert.deepEqual(
        total.evidence
          .filter(
            (item) =>
              item.field.startsWith("TaxDetails") &&
              item.field.endsWith(".Amount"),
          )
          .map((item) => item.value),
        [6, 4],
      );
      assert.ok(
        total.evidence.every(
          (item) => !item.field.startsWith("TotalTaxAmount"),
        ),
      );
    }
  }
});

test("amount balance prefers explicit total tax including zero and does not replace invalid tax", () => {
  const details = array("TaxDetails", [
    money("TaxDetails[0].Amount.Amount", 9),
  ]);
  for (const tax of [0, 2]) {
    const invoice = document(
      "explicit-tax",
      "rental_invoice",
      [
        ...money("SubtotalAmount.Amount", 100),
        ...money("TotalTaxAmount.Amount", tax),
        ...money("TotalAmount.Amount", 100 + tax),
      ],
      [details],
    );
    const total = check([invoice], "financial.total:explicit-tax");
    assert.equal(total.status, "pass");
    assert.ok(
      total.evidence.every((item) => !item.field.startsWith("TaxDetails")),
    );
  }
  const invalid = document(
    "invalid-tax",
    "rental_invoice",
    [
      ...money("SubtotalAmount.Amount", 100),
      fact("TotalTaxAmount.Amount", "unknown"),
      ...money("TotalAmount.Amount", 109),
    ],
    [details],
  );
  assert.equal(
    check([invalid], "financial.total:invalid-tax").status,
    "not_checkable",
  );
});

test("amount balance rejects empty, incomplete and overflowing fallback tax details", () => {
  for (const items of [
    [],
    [
      money("TaxDetails[0].Amount.Amount", 1),
      money("TaxDetails[1].Amount.Amount", null),
    ],
    [
      money("TaxDetails[0].Amount.Amount", 46_000_000_000_000),
      money("TaxDetails[1].Amount.Amount", 46_000_000_000_000),
    ],
  ]) {
    const invoice = document(
      "bad-tax-details",
      "rental_invoice",
      [
        ...money("SubtotalAmount.Amount", 100),
        ...money("TotalAmount.Amount", 101),
      ],
      [array("TaxDetails", items)],
    );
    assert.equal(
      check([invoice], "financial.total:bad-tax-details").status,
      "not_checkable",
    );
  }
});

test("missing currency metadata does not block arithmetic or invent a currency", () => {
  const repair = document(
    "no-currency",
    "repair_estimate",
    [
      ...money("SubtotalAmount.Amount", 100, null),
      ...money("TotalTaxAmount.Amount", 10, null),
      ...money("TotalAmount.Amount", 110, null),
    ],
    [
      array("LineItems", [
        money("LineItems[0].TotalAmount.Amount", 100, null),
      ]),
    ],
  );
  for (const family of ["financial.total", "financial.line_items"]) {
    const value = check([repair], `${family}:no-currency`);
    assert.equal(value.status, "pass");
    assert.doesNotMatch(value.message, /undefined|USD|CurrencyCode/);
    assert.ok(
      value.evidence.every((item) => !item.field.endsWith("CurrencyCode")),
    );
  }
});

test("explicit currency conflicts remain not checkable when other codes are missing", () => {
  const repair = document(
    "currency-conflict",
    "repair_estimate",
    [
      ...money("SubtotalAmount.Amount", 100, "USD"),
      ...money("TotalTaxAmount.Amount", 10, null),
      ...money("TotalAmount.Amount", 110, "EUR"),
    ],
    [
      array("LineItems", [
        money("LineItems[0].TotalAmount.Amount", 50, null),
        money("LineItems[1].TotalAmount.Amount", 50, "EUR"),
      ]),
    ],
  );
  for (const family of ["financial.total", "financial.line_items"])
    assert.equal(
      check([repair], `${family}:currency-conflict`).status,
      "not_checkable",
    );
});

test("makes mixed-currency repair line items not checkable", () => {
  const items = array("LineItems", [
    money("LineItems[0].TotalAmount.Amount", 10, "USD"),
    money("LineItems[1].TotalAmount.Amount", 5, "EUR"),
  ]);
  const repair = document(
    "repair-currency",
    "repair_estimate",
    money("SubtotalAmount.Amount", 15, "USD"),
    [items],
  );

  assert.equal(
    check([repair], "financial.line_items:repair-currency").status,
    "not_checkable",
  );
});

test("consistency evaluation contains only the three financial and estimate rule families", () => {
  const repair = document("repair", "repair_estimate", [
    ...money("SubtotalAmount.Amount", 100),
    ...money("TotalTaxAmount.Amount", 0),
    ...money("TotalAmount.Amount", 100),
  ], [array("LineItems", [money("LineItems[0].TotalAmount.Amount", 100)])]);
  const report = evaluatePolicies([
    document("id", "id_document", [fact("LastName", null)]),
    document("statement", "statement", [fact("claimant_name", null)]),
    repair,
  ]);
  assert.deepEqual(report.checks.map((item) => item.id.split(":")[0]).sort(), [
    "cross.repair_estimates", "financial.line_items", "financial.total",
  ]);
  assert.deepEqual(report.counts, { pass: 3, warn: 0, fail: 0, not_checkable: 0 });
  assert.deepEqual(evaluatePolicies([]).checks, []);
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
    "repair_estimate",
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
