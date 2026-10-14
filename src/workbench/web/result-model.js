/** @typedef {import("../src/results.ts").Fact} Fact */
/** @typedef {import("../src/results.ts").ResultField} ResultField */
/** @typedef {{category: string, start: number, end: number, documents: import("../src/results.ts").Document[]}} Segment */
/** @typedef {{review?: {segments: Segment[]} | null}} PacketResult */

export const typeNames = {
  classification: "Classification",
  id_document: "ID",
  tax_1099a: "1099-A",
  repair_estimate: "Repair Estimate",
  towing_invoice: "Towing Invoice",
  rental_invoice: "Rental Invoice",
};
const invoiceDefaults = [
  "VendorName",
  "InvoiceId",
  "InvoiceDate",
  "TotalAmount.Amount",
  "TotalTaxAmount.Amount",
  "LineItems",
];
const defaults = {
  id_document: [
    "FirstName",
    "LastName",
    "DocumentNumber",
    "IssueDate",
    "ExpirationDate",
  ],
  tax_1099a: [
    "TaxYear",
    "Borrower.Name",
    "Lender.Name",
    "Box1",
    "Box2",
    "Box4",
  ],
  repair_estimate: [
    "VendorName",
    "vehicle",
    "vin",
    "TotalAmount.Amount",
    "TotalTaxAmount.Amount",
    "LineItems",
  ],
  towing_invoice: invoiceDefaults,
  rental_invoice: invoiceDefaults,
};
const labels = {
  vehicle: "Vehicle",
  vin: "VIN",
  odometer: "Odometer",
  "TotalAmount.Amount": "Total",
  "TotalTaxAmount.Amount": "Tax",
  "TaxAmount.Amount": "Tax",
  "UnitPrice.Amount": "Unit Price",
  LineItems: "Line Items",
  TaxYear: "Tax Year",
  "Borrower.Name": "Borrower",
  "Lender.Name": "Lender",
  Box1: "Acquisition Date",
  Box2: "Balance",
  Box4: "Fair Market Value",
  Box5: "Personally Liable",
  Box6: "Property",
  Form1099ACopies: "Copies",
};
/** @param {string} field */
export function fieldLabel(field) {
  return (
    labels[field] ??
    field
      .replace(/\.Amount$/, "")
      .replace(/\./g, " / ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
  );
}
/** @param {number} value @param {string} [currency] */
export function formatCurrency(value, currency = "USD") {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
/** @param {Fact} field @param {Fact[]} [facts] */
export function formatValue(field, facts = []) {
  if (typeof field.value !== "number") return String(field.value);
  if (/(?:^|\.)TaxYear$/.test(field.field)) return String(field.value);
  if (/Amount$/.test(field.field) || /(?:^|\.)Box[24]$/.test(field.field)) {
    const code = facts.find(
      (item) =>
        item.field === field.field.replace(/Amount$/, "CurrencyCode") &&
        hasValue(item),
    );
    return formatCurrency(
      field.value,
      typeof code?.value === "string" ? code.value : "USD",
    );
  }
  return field.value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
/** @param {import("../src/results.ts").Document} document @param {string} category @returns {import("../src/results.ts").Document} */
function displayDocument(document, category) {
  if (category !== "tax_1099a") return document;
  const copies = document.fields.find(
    (field) => field.kind === "array" && field.field === "Form1099ACopies",
  );
  if (!copies || copies.kind !== "array" || !copies.items.length)
    return document;
  return {
    ...document,
    fields: [
      ...copies.items[0].map((fact) => ({
        ...fact,
        kind: "scalar",
        field: itemField(fact.field, copies.field),
      })),
      copies,
    ],
  };
}
/** @param {Fact | ResultField | undefined} field */
export function hasValue(field) {
  if (!field) return false;
  if ("kind" in field && field.kind === "array") return true;
  return (
    field.status === "present" &&
    field.value !== null &&
    (typeof field.value !== "string" || field.value.trim().length > 0)
  );
}
/** @param {Fact | ResultField} field */
function visibleField(field) {
  return hasValue(field) && !/(?:^|\.)CurrencyCode$/.test(field.field);
}
/** @param {PacketResult | undefined} result @param {string} category */
export function firstEntry(result, category) {
  const segments = (result?.review?.segments ?? []).filter(
    (s) => s.category === category,
  );
  const entries = segments.flatMap((segment) =>
    segment.documents.map((document) => ({ segment, document })),
  );
  const first = entries[0];
  const copies =
    category === "tax_1099a"
      ? first?.document.fields.find(
          (field) =>
            field.kind === "array" && field.field === "Form1099ACopies",
        )
      : undefined;
  return {
    entry: first
      ? { ...first, document: displayDocument(first.document, category) }
      : undefined,
    count: Math.max(
      segments.length,
      entries.length,
      copies?.kind === "array" ? copies.count : 0,
    ),
  };
}
/** @param {PacketResult[]} results */
export function availableTypes(results) {
  return Object.keys(typeNames).filter(
    (category) =>
      category === "classification" ||
      results.some((result) =>
        firstEntry(result, category).entry?.document.fields.some(hasValue),
      ),
  );
}
/** @param {PacketResult[]} results @param {string} category @param {boolean} all */
export function fieldColumns(results, category, all) {
  const fields = [
    ...new Set(
      results.flatMap((result) =>
        (firstEntry(result, category).entry?.document.fields ?? [])
          .filter(visibleField)
          .map((field) => field.field),
      ),
    ),
  ];
  if (all) return fields;
  const chosen = (defaults[category] ?? []).filter((field) =>
    fields.includes(field),
  );
  return chosen.length ? chosen : fields.slice(0, 6);
}
/** @param {PacketResult | undefined} result */
export function customerName(result) {
  const documents = result?.review?.segments ?? [];
  const idFacts = documents
    .filter((s) => s.category === "id_document")
    .flatMap((s) => s.documents.flatMap((d) => d.facts));
  const name = ["FirstName", "LastName"]
    .map(
      (field) =>
        idFacts.find((f) => f.field === field && hasValue(f))?.value ?? "",
    )
    .filter(Boolean)
    .join(" ");
  if (name) return name;
  const customer = documents
    .flatMap((s) => s.documents.flatMap((d) => d.facts))
    .find((f) => f.field === "CustomerName" && hasValue(f));
  return customer ? String(customer.value) : "";
}
/** @param {string} path @param {string} array */
export function itemField(path, array) {
  return path.slice(`${array}[`.length).replace(/^\d+\]\.?/, "") || "Value";
}
/** @param {Extract<ResultField, {kind: "array"}>} field */
export function itemColumns(field) {
  return [
    ...new Set(
      field.items.flatMap((item) =>
        item
          .filter(visibleField)
          .map((fact) => itemField(fact.field, field.field)),
      ),
    ),
  ];
}
/** @param {Fact | ResultField | undefined} field @param {import("../src/results.ts").Document} [document] */
export function fieldRegions(field, document) {
  if (!field) return [];
  const fields = [field];
  if (field.field === "TotalTaxAmount.Amount") {
    const details = document?.fields.find(
      (item) => item.field === "TaxDetails",
    );
    if (details) fields.push(details);
  }
  const regions = fields.flatMap((item) => {
    const leaves =
      "kind" in item && item.kind === "array" ? item.items.flat() : [item];
    return leaves.filter(visibleField).flatMap((leaf) => leaf.regions);
  });
  const seen = new Set();
  return regions.filter((region) => {
    const key = `${region.page}:${region.polygon.join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
/** @param {Extract<ResultField, {kind: "array"}>} field */
export function monetarySum(field) {
  if (!field.items.length) return undefined;
  for (const suffix of ["TotalAmount.Amount", "Amount.Amount"]) {
    const amounts = field.items.map(
      (item) =>
        item.find((fact) => fact.field.endsWith(`.${suffix}`) && hasValue(fact))
          ?.value,
    );
    const currencies = field.items.map(
      (item) =>
        item.find(
          (fact) =>
            fact.field.endsWith(
              `.${suffix.replace(/Amount$/, "CurrencyCode")}`,
            ) && hasValue(fact),
        )?.value,
    );
    if (
      amounts.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      ) &&
      currencies.every(
        (value) => typeof value === "string" && /^[A-Z]{3}$/.test(value),
      ) &&
      new Set(currencies).size === 1
    ) {
      return {
        amount: amounts.reduce((sum, value) => sum + value, 0),
        currency: currencies[0],
      };
    }
  }
  return undefined;
}
