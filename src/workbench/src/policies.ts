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
  status: "pass" | "warn" | "fail" | "not_checkable";
  message: string;
  evidence: PolicyEvidence[];
};

type EvidenceFact = { document: PolicyDocument; fact: Fact };
type Money = EvidenceFact & {
  cents: number;
  currency?: string;
  currencyFact?: Fact;
};

const financialCategories = new Set([
  "repair_estimate",
  "towing_invoice",
  "rental_invoice",
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

function readCurrency(
  facts: Fact[],
  amountPath: string,
): { fact?: Fact; code?: string; problem?: string } {
  const field = amountPath.endsWith(".Amount")
    ? currencyPath(amountPath)
    : undefined;
  const fact = field ? facts.find((fact) => fact.field === field) : undefined;
  if (!hasValue(fact)) return {};
  if (
    typeof fact.value !== "string" ||
    !/^[A-Za-z]{3}$/.test(fact.value.trim())
  )
    return { fact, problem: `${field} is invalid` };
  return { fact, code: fact.value.trim().toUpperCase() };
}

function readMoney(
  document: PolicyDocument,
  facts: Fact[],
  field: string,
): { money?: Money; problem?: string; evidence: EvidenceFact[] } {
  const amount = facts.find((fact) => fact.field === field);
  const currency = readCurrency(facts, field);
  const available = [amount, currency.fact]
    .filter(
      (fact): fact is Fact =>
        fact !== undefined && (fact === amount || hasValue(fact)),
    )
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
  if (currency.problem)
    return { problem: currency.problem, evidence: available };
  return {
    money: {
      document,
      fact: amount,
      cents: cents(amount.value)!,
      currency: currency.code,
      currencyFact: currency.fact,
    },
    evidence: available,
  };
}

function moneyEvidence(values: Money[]) {
  return values.flatMap((value) => [
    { document: value.document, fact: value.fact },
    ...(value.currencyFact
      ? [{ document: value.document, fact: value.currencyFact }]
      : []),
  ]);
}

function moneyCurrencies(values: Money[]) {
  return new Set(
    values.flatMap((value) => (value.currency ? [value.currency] : [])),
  );
}

function formatMoney(value: number, currency?: string) {
  return `${currency ? `${currency} ` : ""}${(value / 100).toFixed(2)}`;
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

function readLineItemMoney(
  document: PolicyDocument,
  facts: Fact[],
  field: string,
): { values?: Money[]; problem?: string; evidence: EvidenceFact[] } {
  if (hasValue(facts.find((fact) => fact.field === field))) {
    const total = readMoney(document, facts, field);
    return {
      values: total.money ? [total.money] : undefined,
      problem: total.problem,
      evidence: total.evidence,
    };
  }
  const prefix = field.replace(/TotalAmount\.Amount$/, "");
  const partField = facts.some((fact) => fact.field === `${prefix}PartsAmount`)
    ? `${prefix}PartsAmount`
    : `${prefix}PartAmount`;
  const part = readMoney(document, facts, partField);
  const labor = readMoney(document, facts, `${prefix}LaborAmount`);
  const currency = readCurrency(facts, field);
  const found = [
    ...part.evidence,
    ...labor.evidence,
    ...(currency.fact ? [{ document, fact: currency.fact }] : []),
  ];
  if (!part.money || !labor.money || currency.problem)
    return {
      problem: [part.problem, labor.problem, currency.problem]
        .filter(Boolean)
        .join("; "),
      evidence: found,
    };
  const values = [
    { ...part.money, currency: currency.code, currencyFact: currency.fact },
    { ...labor.money, currency: currency.code },
  ];
  return { values, evidence: moneyEvidence(values) };
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
    let item: ReturnType<typeof readLineItemMoney>;
    if (array === "LineItems" && suffix === "TotalAmount.Amount")
      item = readLineItemMoney(document, source.items[index], field);
    else {
      const amount = readMoney(document, source.items[index], field);
      item = {
        values: amount.money ? [amount.money] : undefined,
        problem: amount.problem,
        evidence: amount.evidence,
      };
    }
    found.push(...item.evidence);
    if (!item.values)
      return {
        problem: `${array} is incomplete: ${item.problem}`,
        evidence: found,
      };
    values.push(...item.values);
  }
  if (moneyCurrencies(values).size > 1)
    return {
      problem: `${array} contains mixed currencies`,
      evidence: moneyEvidence(values),
    };
  return { values, evidence: moneyEvidence(values) };
}

function lineItemCheck(document: PolicyDocument) {
  const rule =
    "Line-item totals, or PartAmount + LaborAmount when a total is missing, must sum to the explicit subtotal.";
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
  const currencies = moneyCurrencies([...items.values, subtotal.money]);
  if (currencies.size > 1)
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
  const currency = currencies.values().next().value;
  return result(
    `financial.line_items:${document.id}`,
    rule,
    status,
    `Document ${document.id}: line items sum to ${formatMoney(expected, currency)}; subtotal is ${formatMoney(observed, currency)}.`,
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
    "Subtotal plus total tax must equal total when no unsupported adjustment is present. If total tax is absent, sum all tax-detail amounts instead. Discounts and deductibles are not subtracted.";
  const adjustment = unsupportedAdjustment(document);
  if (adjustment)
    return result(
      `financial.total:${document.id}`,
      rule,
      "not_checkable",
      `Document ${document.id} has unsupported adjustment ${adjustment.field}; total reconciliation was not assumed.`,
      [{ document, fact: adjustment }],
    );
  const subtotal = readMoney(
    document,
    document.document.facts,
    "SubtotalAmount.Amount",
  );
  const total = readMoney(
    document,
    document.document.facts,
    "TotalAmount.Amount",
  );
  const explicitTax = readMoney(
    document,
    document.document.facts,
    "TotalTaxAmount.Amount",
  );
  const taxFromDetails = !hasValue(
    findFact(document, "TotalTaxAmount.Amount"),
  );
  const tax = taxFromDetails
    ? arrayMoney(document, "TaxDetails", "Amount.Amount")
    : {
        values: explicitTax.money ? [explicitTax.money] : undefined,
        problem: explicitTax.problem,
        evidence: explicitTax.evidence,
      };
  const reads = [subtotal, tax, total];
  if (!subtotal.money || !tax.values || !total.money)
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
  const values = [subtotal.money, ...tax.values, total.money];
  const currencies = moneyCurrencies(values);
  if (currencies.size > 1)
    return result(
      `financial.total:${document.id}`,
      rule,
      "not_checkable",
      `Document ${document.id} cannot be checked because subtotal, tax, and total contain conflicting currencies.`,
      moneyEvidence(values),
    );
  const taxCents = safeSum(tax.values.map((value) => value.cents));
  const expected =
    taxCents === undefined
      ? undefined
      : safeSum([subtotal.money.cents, taxCents]);
  if (taxCents === undefined || expected === undefined)
    return result(
      `financial.total:${document.id}`,
      rule,
      "not_checkable",
      `Document ${document.id} cannot be checked because the aggregate cents calculation exceeds safe integer precision.`,
      moneyEvidence(values),
    );
  const status =
    Math.abs(expected - total.money.cents) <= 1 ? "pass" : "fail";
  const currency = currencies.values().next().value;
  const taxLabel = taxFromDetails ? "tax (sum of tax details)" : "tax";
  return result(
    `financial.total:${document.id}`,
    rule,
    status,
    `Document ${document.id}: ${formatMoney(subtotal.money.cents, currency)} + ${formatMoney(taxCents, currency)} ${taxLabel} = ${formatMoney(expected, currency)} expected; total is ${formatMoney(total.money.cents, currency)}.`,
    moneyEvidence(values),
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

function multipleEstimatesCheck(documents: PolicyDocument[]) {
  const repairs = documents.filter(
    (document) => document.category === "repair_estimate",
  );
  if (!repairs.length) return undefined;
  const id = "cross.repair_estimates";
  const rule =
    "Compare repair-estimate totals within the packet. Different quoted amounts require review, not an extraction-error finding.";
  const quotes = repairs.map((document) => ({
    document,
    shop: explicitField(document, ["VendorName"]),
    reference: explicitField(document, ["InvoiceId"]),
    total: readMoney(document, document.document.facts, "TotalAmount.Amount"),
  }));
  const facts = quotes.flatMap((quote) => [
    ...quote.total.evidence,
    ...[...(quote.shop?.facts ?? []), ...(quote.reference?.facts ?? [])].map(
      (fact) => ({ document: quote.document, fact }),
    ),
  ]);
  if (quotes.length === 1)
    return result(
      id,
      rule,
      "pass",
      "One repair estimate was found; there is no competing quote to compare.",
      facts,
    );
  const observed = quotes
    .map((quote) => {
      const shop =
        quote.shop?.value.replace(/\s+/g, " ") ?? "shop name not extracted";
      const reference = quote.reference
        ? `, quote ${quote.reference.value}`
        : "";
      const amount = quote.total.money
        ? formatMoney(quote.total.money.cents, quote.total.money.currency)
        : `total unavailable (${quote.total.problem})`;
      return `Document ${quote.document.id} (${shop}${reference}): ${amount}`;
    })
    .join("; ");
  const amounts = quotes.flatMap((quote) =>
    quote.total.money ? [quote.total.money] : [],
  );
  if (amounts.length !== quotes.length || moneyCurrencies(amounts).size > 1)
    return result(
      id,
      rule,
      "not_checkable",
      `Repair estimates cannot be fully compared because totals are missing, invalid, or use conflicting currencies: ${observed}.`,
      facts,
    );
  const different = new Set(amounts.map((amount) => amount.cents)).size > 1;
  return result(
    id,
    rule,
    different ? "warn" : "pass",
    `${different ? "Different repair estimate totals; compare the quotes before selecting the repair amount" : "Repair estimate totals match"}: ${observed}.`,
    facts,
  );
}

export function evaluatePolicies(documents: PolicyDocument[]): {
  version: string;
  checks: PolicyCheck[];
  counts: Record<PolicyCheck["status"], number>;
} {
  const ordered = [...documents].sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.start - right.start ||
      left.end - right.end,
  );
  const checks: PolicyCheck[] = [];
  for (const document of ordered) {
    if (document.category === "repair_estimate")
      checks.push(lineItemCheck(document));
    if (financialCategories.has(document.category))
      checks.push(totalCheck(document));
  }
  const multipleEstimates = multipleEstimatesCheck(ordered);
  if (multipleEstimates) checks.push(multipleEstimates);
  const counts = { pass: 0, warn: 0, fail: 0, not_checkable: 0 };
  for (const check of checks) counts[check.status] += 1;
  return { version: "1.1.0", checks, counts };
}
