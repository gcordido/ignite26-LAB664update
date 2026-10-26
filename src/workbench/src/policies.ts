import type { Document, Fact, ResultField } from "./results.ts";

export type PolicyDocument = {
  id: string;
  category: string;
  analyzerId: string;
  start: number;
  end: number;
  document: Document;
  markdown: string;
  sourceId?: string;
};

export type PolicyEvidence = {
  documentId: string;
  category: string;
  analyzerId: string;
  start: number;
  end: number;
  field: string;
  value: Fact["value"];
  confidence?: number;
  regions: Fact["regions"];
};

export type PolicyCheck = {
  id: string;
  rule: string;
  status: "pass" | "fail" | "not_checkable";
  message: string;
  evidence: PolicyEvidence[];
};

type EvidenceFact = { document: PolicyDocument; fact: Fact };
type Money = EvidenceFact & {
  cents: number;
  currency: string;
  currencyFact: Fact;
};

const financialCategories = new Set([
  "repair_estimate",
  "towing_invoice",
  "rental_invoice",
]);
const comparisonCategories = new Set([
  "repair_estimate",
  "towing_invoice",
  "rental_invoice",
  "statement",
]);

function hasValue(fact: Fact | undefined): fact is Fact {
  return (
    fact?.status === "present" &&
    fact.value !== null &&
    (typeof fact.value !== "string" || fact.value.trim().length > 0)
  );
}

function findFact(document: PolicyDocument, field: string) {
  return document.document.facts.find((fact) => fact.field === field);
}

function evidence({ document, fact }: EvidenceFact): PolicyEvidence {
  return {
    documentId: document.id,
    category: document.category,
    analyzerId: document.analyzerId,
    start: document.start,
    end: document.end,
    field: fact.field,
    value: fact.value,
    ...(fact.confidence === undefined ? {} : { confidence: fact.confidence }),
    regions: fact.regions,
  };
}

function result(
  id: string,
  rule: string,
  status: PolicyCheck["status"],
  message: string,
  facts: EvidenceFact[],
): PolicyCheck {
  return { id, rule, status, message, evidence: facts.map(evidence) };
}

function cents(value: number) {
  if (!Number.isFinite(value)) return undefined;
  const rounded = Math.round(value * 100);
  return Number.isSafeInteger(rounded) ? rounded : undefined;
}

function currencyPath(amountPath: string) {
  return amountPath.replace(/\.Amount$/, ".CurrencyCode");
}

function readMoney(
  document: PolicyDocument,
  facts: Fact[],
  field: string,
): { money?: Money; problem?: string; evidence: EvidenceFact[] } {
  const amount = facts.find((fact) => fact.field === field);
  const currency = facts.find((fact) => fact.field === currencyPath(field));
  const available = [amount, currency]
    .filter((fact): fact is Fact => fact !== undefined)
    .map((fact) => ({ document, fact }));
  if (!hasValue(amount))
    return {
      problem: `${field} is missing`,
      evidence: available,
    };
  if (typeof amount.value !== "number" || cents(amount.value) === undefined)
    return {
      problem: `${field} is not a finite currency amount`,
      evidence: available,
    };
  if (
    !hasValue(currency) ||
    typeof currency.value !== "string" ||
    !/^[A-Za-z]{3}$/.test(currency.value.trim())
  )
    return {
      problem: `${currencyPath(field)} is missing or unknown`,
      evidence: available,
    };
  return {
    money: {
      document,
      fact: amount,
      cents: cents(amount.value)!,
      currency: currency.value.trim().toUpperCase(),
      currencyFact: currency,
    },
    evidence: available,
  };
}

function moneyEvidence(values: Money[]) {
  return values.flatMap((value) => [
    { document: value.document, fact: value.fact },
    { document: value.document, fact: value.currencyFact },
  ]);
}

function formatMoney(value: number, currency: string) {
  return `${currency} ${(value / 100).toFixed(2)}`;
}

function safeSum(values: number[]) {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function arrayField(document: PolicyDocument, field: string) {
  return document.document.fields.find(
    (item): item is Extract<ResultField, { kind: "array" }> =>
      item.kind === "array" && item.field === field,
  );
}

function arrayMoney(
  document: PolicyDocument,
  array: string,
  suffix: string,
): { values?: Money[]; problem?: string; evidence: EvidenceFact[] } {
  const source = arrayField(document, array);
  if (
    !source ||
    source.items.length === 0 ||
    source.count !== source.items.length
  )
    return {
      problem: `${array} is missing, empty, or structurally incomplete`,
      evidence: [],
    };
  const values: Money[] = [];
  const found: EvidenceFact[] = [];
  for (let index = 0; index < source.items.length; index += 1) {
    const field = `${array}[${index}].${suffix}`;
    const item = readMoney(document, source.items[index], field);
    found.push(...item.evidence);
    if (!item.money)
      return {
        problem: `${array} is incomplete: ${item.problem}`,
        evidence: found,
      };
    values.push(item.money);
  }
  const currencies = new Set(values.map((value) => value.currency));
  if (currencies.size !== 1)
    return {
      problem: `${array} contains mixed currencies`,
      evidence: moneyEvidence(values),
    };
  return { values, evidence: moneyEvidence(values) };
}

function lineItemCheck(document: PolicyDocument) {
  const rule = "Line-item totals must sum to the explicit subtotal.";
  const subtotal = readMoney(
    document,
    document.document.facts,
    "SubtotalAmount.Amount",
  );
  const items = arrayMoney(document, "LineItems", "TotalAmount.Amount");
  if (!subtotal.money || !items.values)
    return result(
      `financial.line_items:${document.id}`,
      rule,
      "not_checkable",
      `Document ${document.id} cannot be checked: ${[
        subtotal.problem,
        items.problem,
      ]
        .filter(Boolean)
        .join("; ")}.`,
      [...subtotal.evidence, ...items.evidence],
    );
  if (items.values[0].currency !== subtotal.money.currency)
    return result(
      `financial.line_items:${document.id}`,
      rule,
      "not_checkable",
      `Document ${document.id} cannot be checked because line items and subtotal use different currencies.`,
      [...moneyEvidence(items.values), ...moneyEvidence([subtotal.money])],
    );
  const expected = safeSum(items.values.map((item) => item.cents));
  const observed = subtotal.money.cents;
  if (expected === undefined)
    return result(
      `financial.line_items:${document.id}`,
      rule,
      "not_checkable",
      `Document ${document.id} cannot be checked because the line-item cents sum exceeds safe integer precision.`,
      [...moneyEvidence(items.values), ...moneyEvidence([subtotal.money])],
    );
  const status = Math.abs(expected - observed) <= 1 ? "pass" : "fail";
  return result(
    `financial.line_items:${document.id}`,
    rule,
    status,
    `Document ${document.id}: line items sum to ${formatMoney(expected, subtotal.money.currency)}; subtotal is ${formatMoney(observed, subtotal.money.currency)}.`,
    [...moneyEvidence(items.values), ...moneyEvidence([subtotal.money])],
  );
}

function unsupportedAdjustment(document: PolicyDocument) {
  return document.document.facts.find(
    (fact) =>
      !fact.field.includes("[") &&
      hasValue(fact) &&
      typeof fact.value === "number" &&
      fact.value !== 0 &&
      (fact.field === "BalanceForward.Amount" ||
        /(?:Fee|Charge|Adjustment|Shipping|Freight|Tip|Gratuity).*\.Amount$/i.test(
          fact.field,
        )),
  );
}

function totalCheck(document: PolicyDocument) {
  const rule =
    "Subtotal plus tax must equal total when no unsupported adjustment is present. Discounts and deductibles are not subtracted.";
  const adjustment = unsupportedAdjustment(document);
  if (adjustment)
    return result(
      `financial.total:${document.id}`,
      rule,
      "not_checkable",
      `Document ${document.id} has unsupported adjustment ${adjustment.field}; total reconciliation was not assumed.`,
      [{ document, fact: adjustment }],
    );
  const paths = [
    "SubtotalAmount.Amount",
    "TotalTaxAmount.Amount",
    "TotalAmount.Amount",
  ];
  const reads = paths.map((path) =>
    readMoney(document, document.document.facts, path),
  );
  if (reads.some((read) => !read.money))
    return result(
      `financial.total:${document.id}`,
      rule,
      "not_checkable",
      `Document ${document.id} cannot be checked: ${reads
        .map((read) => read.problem)
        .filter(Boolean)
        .join("; ")}. Missing values were not treated as zero.`,
      reads.flatMap((read) => read.evidence),
    );
  const values = reads.map((read) => read.money!);
  if (new Set(values.map((value) => value.currency)).size !== 1)
    return result(
      `financial.total:${document.id}`,
      rule,
      "not_checkable",
      `Document ${document.id} cannot be checked because subtotal, tax, and total do not share one currency.`,
      moneyEvidence(values),
    );
  const [subtotal, tax, total] = values;
  const expected = safeSum([subtotal.cents, tax.cents]);
  if (expected === undefined)
    return result(
      `financial.total:${document.id}`,
      rule,
      "not_checkable",
      `Document ${document.id} cannot be checked because the aggregate cents calculation exceeds safe integer precision.`,
      moneyEvidence(values),
    );
  const status = Math.abs(expected - total.cents) <= 1 ? "pass" : "fail";
  return result(
    `financial.total:${document.id}`,
    rule,
    status,
    `Document ${document.id}: ${formatMoney(subtotal.cents, total.currency)} + ${formatMoney(tax.cents, total.currency)} tax = ${formatMoney(expected, total.currency)} expected; total is ${formatMoney(total.cents, total.currency)}.`,
    moneyEvidence(values),
  );
}

function taxCheck(document: PolicyDocument) {
  const rule = "Tax-detail amounts must sum to the explicit total tax.";
  const total = readMoney(
    document,
    document.document.facts,
    "TotalTaxAmount.Amount",
  );
  const details = arrayMoney(document, "TaxDetails", "Amount.Amount");
  if (!total.money || !details.values)
    return result(
      `financial.tax_details:${document.id}`,
      rule,
      "not_checkable",
      `Document ${document.id} cannot be checked: ${[
        total.problem,
        details.problem,
      ]
        .filter(Boolean)
        .join("; ")}.`,
      [...total.evidence, ...details.evidence],
    );
  if (details.values[0].currency !== total.money.currency)
    return result(
      `financial.tax_details:${document.id}`,
      rule,
      "not_checkable",
      `Document ${document.id} cannot be checked because tax details and total tax use different currencies.`,
      [...moneyEvidence(details.values), ...moneyEvidence([total.money])],
    );
  const expected = safeSum(details.values.map((item) => item.cents));
  if (expected === undefined)
    return result(
      `financial.tax_details:${document.id}`,
      rule,
      "not_checkable",
      `Document ${document.id} cannot be checked because the tax-detail cents sum exceeds safe integer precision.`,
      [...moneyEvidence(details.values), ...moneyEvidence([total.money])],
    );
  const status = Math.abs(expected - total.money.cents) <= 1 ? "pass" : "fail";
  return result(
    `financial.tax_details:${document.id}`,
    rule,
    status,
    `Document ${document.id}: tax details sum to ${formatMoney(expected, total.money.currency)}; total tax is ${formatMoney(total.money.cents, total.money.currency)}.`,
    [...moneyEvidence(details.values), ...moneyEvidence([total.money])],
  );
}

function requiredCheck(
  document: PolicyDocument,
  kind: "id" | "repair" | "statement",
) {
  const fields =
    kind === "id"
      ? [
          ["first name", "FirstName"],
          ["last name", "LastName"],
          ["document number", "DocumentNumber"],
        ]
      : kind === "repair"
        ? [
            ["vendor", "VendorName"],
            ["vehicle", "vehicle"],
            ["VIN", "vin"],
            ["total", "TotalAmount.Amount"],
          ]
        : [
            ["claimant name", "claimant_name"],
            ["incident date", "incident_date"],
            ["vehicle", "vehicle"],
          ];
  const facts = fields
    .map(([, field]) => findFact(document, field))
    .filter((fact): fact is Fact => fact !== undefined);
  const missing = fields
    .filter(([, field]) => !hasValue(findFact(document, field)))
    .map(([label, field]) => `${label} (${field})`);
  const rule =
    kind === "id"
      ? "Named-holder ID extraction requires FirstName, LastName, and DocumentNumber (schema assumption; advisory)."
      : kind === "repair"
        ? "Repair estimates require vendor, vehicle, VIN, and total."
        : "Statements require claimant name, incident date, and vehicle.";
  const missingMessage =
    kind === "id"
      ? `Document ${document.id} is missing configured required field(s): ${missing.join(", ")}. This is a schema assumption and advisory, not a person mismatch.`
      : `Document ${document.id} is missing required field(s): ${missing.join(", ")}.`;
  return result(
    `required.${kind}:${document.id}`,
    rule,
    missing.length ? "fail" : "pass",
    missing.length
      ? missingMessage
      : `Document ${document.id} contains all configured required fields.`,
    facts.map((fact) => ({ document, fact })),
  );
}

function normalizedText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function comparison(
  id: string,
  rule: string,
  label: string,
  entries: { document: PolicyDocument; value: string; facts: Fact[] }[],
  normalize: (value: string) => string,
) {
  const facts = entries.flatMap((entry) =>
    entry.facts.map((fact) => ({ document: entry.document, fact })),
  );
  if (entries.length < 2)
    return result(
      id,
      rule,
      "not_checkable",
      `${label} consistency needs at least two explicit values; found ${entries.length}.`,
      facts,
    );
  const groups = new Set(entries.map((entry) => normalize(entry.value)));
  const observed = entries
    .map((entry) => `${entry.document.id}="${entry.value}"`)
    .join("; ");
  return result(
    id,
    rule,
    groups.size === 1 ? "pass" : "fail",
    `${label} values ${groups.size === 1 ? "are consistent" : "conflict"}: ${observed}.`,
    facts,
  );
}

function claimantCheck(documents: PolicyDocument[]) {
  const entries: {
    document: PolicyDocument;
    value: string;
    facts: Fact[];
  }[] = [];
  for (const document of documents) {
    if (document.category === "id_document") {
      const first = findFact(document, "FirstName");
      const last = findFact(document, "LastName");
      if (
        hasValue(first) &&
        hasValue(last) &&
        typeof first.value === "string" &&
        typeof last.value === "string"
      )
        entries.push({
          document,
          value: `${first.value.trim()} ${last.value.trim()}`,
          facts: [first, last],
        });
    } else if (comparisonCategories.has(document.category)) {
      const field =
        document.category === "statement" ? "claimant_name" : "CustomerName";
      const fact = findFact(document, field);
      if (hasValue(fact) && typeof fact.value === "string")
        entries.push({ document, value: fact.value.trim(), facts: [fact] });
    }
  }
  return comparison(
    "cross.claimant_name",
    "Claimant names must agree across ID, customer, and statement fields only.",
    "Claimant name",
    entries,
    normalizedText,
  );
}

function explicitField(
  document: PolicyDocument,
  fields: string[],
): { value: string; facts: Fact[] } | undefined {
  for (const field of fields) {
    const fact = findFact(document, field);
    if (hasValue(fact) && typeof fact.value === "string")
      return { value: fact.value.trim(), facts: [fact] };
  }
  return undefined;
}

function vehicleChecks(documents: PolicyDocument[]) {
  const eligible = documents.filter((document) =>
    comparisonCategories.has(document.category),
  );
  const vins = eligible.flatMap((document) => {
    const found = explicitField(document, ["vin", "VIN"]);
    return found ? [{ document, ...found }] : [];
  });
  const vehicles = eligible.flatMap((document) => {
    const found = explicitField(document, ["vehicle", "Vehicle"]);
    return found ? [{ document, ...found }] : [];
  });
  return [
    comparison(
      "cross.vin",
      "Explicit VIN values must match after removing separators and normalizing case.",
      "VIN",
      vins,
      (value) => value.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    ),
    comparison(
      "cross.vehicle",
      "Explicit vehicle values must match after case, spacing, and punctuation normalization.",
      "Vehicle",
      vehicles,
      normalizedText,
    ),
  ];
}

export function evaluatePolicies(documents: PolicyDocument[]): {
  version: string;
  checks: PolicyCheck[];
  counts: { pass: number; fail: number; not_checkable: number };
} {
  const ordered = [...documents].sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.start - right.start ||
      left.end - right.end,
  );
  const checks: PolicyCheck[] = [];
  for (const document of ordered) {
    if (financialCategories.has(document.category))
      checks.push(
        lineItemCheck(document),
        totalCheck(document),
        taxCheck(document),
      );
    if (document.category === "repair_estimate")
      checks.push(requiredCheck(document, "repair"));
    if (document.category === "id_document")
      checks.push(requiredCheck(document, "id"));
    if (document.category === "statement")
      checks.push(requiredCheck(document, "statement"));
  }
  checks.push(claimantCheck(ordered), ...vehicleChecks(ordered));
  const counts = { pass: 0, fail: 0, not_checkable: 0 };
  for (const check of checks) counts[check.status] += 1;
  return { version: "1.1.0", checks, counts };
}
