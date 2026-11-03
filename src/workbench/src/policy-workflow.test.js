import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import {
  documentLabel,
  fieldLabel,
  fieldRegions,
  policyChecks,
  policyFamily,
  policyProblem,
} from "../web/result-model.js";
import { claimFieldSources } from "../web/policy-evidence-links.js";

const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
const reviewSource = await readFile(new URL("../web/packet-review.js", import.meta.url), "utf8");

function evidenceLinks() {
  const grouped = [], individual = [];
  const context = vm.createContext({
    node: () => ({ dataset: {}, setAttribute() {} }),
    policyFamily,
    documentName: (doc) => doc.id,
    fieldLabel: (field) => field,
    contextFor: (check, doc, field) =>
      check.evidence.find((item) => item.documentId === doc.id && item.field === field),
    showAllEvidence: (entries) => grouped.push(entries),
    showEvidence: (...args) => individual.push(args),
  });
  vm.runInContext(reviewSource.slice(reviewSource.indexOf("  function evidenceLink("),
    reviewSource.indexOf("  function symbol(")), context);
  vm.runInContext(reviewSource.slice(reviewSource.indexOf("  function formulaEntries("),
    reviewSource.indexOf("  function reviewNotes(")), context);
  return { link: context.evidenceLink, entries: context.formulaEntries, grouped, individual };
}

test("repair sum source and formula links highlight every operand from only their own estimate", () => {
  const { link, grouped, individual } = evidenceLinks();
  const doc = { id: "repair" };
  const evidence = [
    { documentId: doc.id, field: "LineItems[0].TotalAmount.Amount", value: 1203.2 },
    { documentId: doc.id, field: "LineItems[1].TotalAmount.Amount", value: 0 },
    { documentId: doc.id, field: "SubtotalAmount.Amount", value: 1203.2 },
    { documentId: doc.id, field: "SubtotalAmount.CurrencyCode", value: "USD" },
    { documentId: doc.id, field: "LineItems[0].UnitPrice.Amount", value: 980 },
    { documentId: "other-shop", field: "LineItems[0].TotalAmount.Amount", value: 445 },
    { documentId: "other-shop", field: "SubtotalAmount.Amount", value: 1753 },
  ];
  const check = { id: "financial.line_items:repair", evidence };
  for (const text of ["Repair Estimate", "USD 1203.20 + 0.00 = 1203.20 (Subtotal)"])
    link(check, doc, "SubtotalAmount.Amount", text).onclick();
  assert.equal(grouped.length, 2);
  for (const entries of grouped) {
    assert.deepEqual(Array.from(entries, ({ item }) => item), evidence.slice(0, 3));
    assert.ok(entries.every((entry) => entry.doc === doc));
  }
  assert.deepEqual(individual, []);
});

test("other checks and explicit missing-field links retain their individual source focus", () => {
  const { link, grouped, individual } = evidenceLinks();
  const doc = { id: "repair" };
  const item = { documentId: doc.id, field: "SubtotalAmount.Amount", value: null, regions: [] };
  for (const [family, missing] of [["cross.repair_estimates", false], ["financial.line_items", true]]) {
    const check = { id: `${family}:repair`, evidence: [item] };
    link(check, doc, item.field, "Subtotal", missing).onclick();
    assert.deepEqual(individual.at(-1), [doc, item, missing ? item.field : undefined]);
  }
  assert.deepEqual(grouped, []);
});

test("repair fallback links highlight both selected component amounts and the subtotal", () => {
  const { link, grouped, individual } = evidenceLinks();
  const doc = { id: "repair" };
  const evidence = [
    { documentId: doc.id, field: "LineItems[0].PartsAmount", value: 0 },
    { documentId: doc.id, field: "LineItems[0].LaborAmount", value: 210.8 },
    { documentId: doc.id, field: "SubtotalAmount.Amount", value: 210.8 },
    { documentId: doc.id, field: "LineItems[0].UnitPrice.Amount", value: 5 },
    { documentId: "other", field: "LineItems[0].PartAmount", value: 50 },
  ];
  link({ id: "financial.line_items:repair", evidence }, doc, "SubtotalAmount.Amount", "Calculation").onclick();
  assert.deepEqual(Array.from(grouped[0], ({ item }) => item), evidence.slice(0, 3));
  assert.deepEqual(individual, []);
});

test("total verification links highlight subtotal, tax and total rather than total alone", () => {
  const { link, grouped, individual } = evidenceLinks();
  const doc = { id: "invoice" };
  const evidence = [
    { documentId: doc.id, field: "SubtotalAmount.Amount", value: 100 },
    { documentId: doc.id, field: "TotalTaxAmount.Amount", value: 5 },
    { documentId: doc.id, field: "TotalAmount.Amount", value: 105 },
    { documentId: doc.id, field: "TotalAmount.CurrencyCode", value: "USD" },
    { documentId: doc.id, field: "LineItems[0].TotalAmount.Amount", value: 100 },
    { documentId: "other", field: "TotalTaxAmount.Amount", value: 10 },
  ];
  for (const text of ["Source document", "Amount equation"])
    link({ id: "financial.total:invoice", evidence }, doc, "TotalAmount.Amount", text).onclick();
  assert.equal(grouped.length, 2);
  for (const entries of grouped)
    assert.deepEqual(Array.from(entries, ({ item }) => item), evidence.slice(0, 3));
  assert.deepEqual(individual, []);
});

test("total verification highlights each tax-detail operand used when total tax is absent", () => {
  const { link, grouped } = evidenceLinks();
  const doc = { id: "invoice" };
  const evidence = [
    { documentId: doc.id, field: "SubtotalAmount.Amount", value: 100 },
    { documentId: doc.id, field: "TaxDetails[0].Amount.Amount", value: 3 },
    { documentId: doc.id, field: "TaxDetails[1].Amount.Amount", value: 2 },
    { documentId: doc.id, field: "TotalAmount.Amount", value: 105 },
  ];
  link({ id: "financial.total:invoice", evidence }, doc, "TotalAmount.Amount", "Calculation").onclick();
  assert.deepEqual(Array.from(grouped[0], ({ item }) => item), evidence);
});

test("updated repair links include present components but other and original links remain formula-only", () => {
  const { link, entries, grouped } = evidenceLinks();
  const doc = { id: "repair", document: { facts: [
    { field: "LineItems[0].PartsAmount", value: 0, regions: [] },
    { field: "LineItems[0].LaborAmount", value: 210.8, regions: [] },
    { field: "LineItems[1].PartsAmount", value: null, regions: [] },
    { field: "LineItems[1].LaborAmount", regions: [] },
    { field: "VendorName", value: "Unrelated", regions: [] },
  ] } };
  const evidence = [
    { documentId: doc.id, field: "SubtotalAmount.Amount", value: 210.8, regions: [] },
    { documentId: doc.id, field: "TotalTaxAmount.Amount", value: 0, regions: [] },
    { documentId: doc.id, field: "TotalAmount.Amount", value: 210.8, regions: [] },
  ];
  const lineEvidence = [
    { documentId: doc.id, field: "LineItems[0].TotalAmount.Amount", value: 210.8, regions: [] },
    evidence[0],
  ];
  const totalCheck = { id: "financial.total:repair", evidence };
  const check = { id: "financial.line_items:repair", evidence: lineEvidence };
  link(totalCheck, doc, "TotalAmount.Amount", "Other rerun", false, false).onclick();
  link(check, doc, "TotalAmount.Amount", "Original").onclick();
  link(check, doc, "TotalAmount.Amount", "Updated", false, true).onclick();
  assert.deepEqual(Array.from(grouped[0], ({ item }) => item), evidence);
  assert.deepEqual(Array.from(grouped[1], ({ item }) => item), lineEvidence);
  assert.deepEqual(Array.from(grouped[2], ({ item }) => item),
    [lineEvidence[0], ...doc.document.facts.slice(0, 2), evidence[0]]);
  const fallback = { id: "financial.line_items:repair", evidence: [
    ...doc.document.facts.slice(0, 2).map(item => ({ ...item, documentId: doc.id })),
    evidence[0],
  ] };
  link(fallback, doc, "SubtotalAmount.Amount", "Fallback", false, true).onclick();
  assert.equal(grouped[3].length, 3);
  const other = { id: "other", document: { facts: [
    { field: "LineItems[0].PartsAmount", value: 999, regions: [] },
  ] } };
  const scoped = entries(check, [doc, other], true);
  assert.equal(scoped.length, 4);
  assert.ok(scoped.every(entry => entry.doc.id === doc.id));
});

test("review fields sort numeric line items and group total, parts and labor before subtotal", () => {
  const { entries } = evidenceLinks();
  const doc = { id: "repair", document: { facts: [
    { field: "LineItems[10].LaborAmount", value: 10, regions: [] },
    { field: "LineItems[2].PartsAmount", value: 2, regions: [] },
    { field: "LineItems[1].LaborAmount", value: 1, regions: [] },
    { field: "LineItems[10].PartsAmount", value: 10, regions: [] },
    { field: "LineItems[1].PartsAmount", value: 1, regions: [] },
  ] } };
  const check = { evidence: [
    { documentId: doc.id, field: "SubtotalAmount.Amount", value: 23, regions: [] },
    { documentId: doc.id, field: "LineItems[10].TotalAmount.Amount", value: 20, regions: [] },
    { documentId: doc.id, field: "LineItems[2].TotalAmount.Amount", value: 2, regions: [] },
    { documentId: doc.id, field: "LineItems[1].TotalAmount.Amount", value: 2, regions: [] },
  ] };
  assert.deepEqual(entries(check, [doc], true).map(({ item }) => item.field), [
    "LineItems[1].TotalAmount.Amount",
    "LineItems[1].PartsAmount",
    "LineItems[1].LaborAmount",
    "LineItems[2].TotalAmount.Amount",
    "LineItems[2].PartsAmount",
    "LineItems[10].TotalAmount.Amount",
    "LineItems[10].PartsAmount",
    "LineItems[10].LaborAmount",
    "SubtotalAmount.Amount",
  ]);
});

function rerunReview() {
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.text = "";
    }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(""); }
    append(...children) {
      for (const value of children) {
        const child = typeof value === "string" ? new Element("#text") : value;
        if (typeof value === "string") child.text = value;
        child.parent = this;
        this.children.push(child);
      }
    }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    matches(selector) {
      if (selector === "button[data-cloud]") return this.tag === "button" && this.dataset.cloud;
      return selector.startsWith(".")
        ? (this.className ?? "").split(" ").includes(selector.slice(1))
        : this.tag === selector;
    }
    descendants() {
      return this.children.flatMap(child => [child, ...child.descendants()]);
    }
    querySelectorAll(selector) {
      return selector.split(" ").reduce((parents, part) =>
        parents.flatMap(parent => parent.descendants().filter(child => child.matches(part))), [this]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0]; }
    closest(selectors) {
      return selectors.split(",").some(selector => this.matches(selector.trim()))
        ? this : this.parent?.closest(selectors);
    }
    click() { return this.onclick?.({ target: this, preventDefault() {} }); }
    reportValidity() { return /^[A-Za-z0-9_.-]{3,128}$/.test(this.value.trim()); }
    scrollIntoView() {}
  }
  const nodes = Object.fromEntries(
    ["packet-review", "policy-checks", "review-title", "review-error", "close-review", "pdf-status"]
      .map(id => [id, new Element("div")]),
  );
  const makeDocument = (id, totals, components = false) => {
    const facts = totals.map((value, index) => ({
      field: `LineItems[${index}].TotalAmount.Amount`, value, status: "present",
      regions: [{ page: 1, polygon: [components ? 0.6 : 0.1, index / 10, 0.8, index / 10] }],
    }));
    facts.push({
      field: "SubtotalAmount.Amount", value: 1600, status: "present",
      regions: [{ page: 1, polygon: [0.1, 0.8, 0.2, 0.8] }],
    }, { field: "TotalAmount.CurrencyCode", value: "USD", regions: [] },
    { field: "IsCredit", value: false, regions: [] });
    if (components)
      for (const [index, [parts, labor]] of [[980, 223.2], [124, 62], [0, 210.8]].entries())
        facts.push({
          field: `LineItems[${index}].PartsAmount`, value: parts,
          regions: [{ page: 1, polygon: [0.2, index / 10, 0.3, index / 10] }],
        }, {
          field: `LineItems[${index}].LaborAmount`, value: labor,
          regions: [{ page: 1, polygon: [0.4, index / 10, 0.5, index / 10] }],
        });
    return {
      id, category: "repair_estimate", start: 1, end: 1, sourceId: "05-estimate",
      analyzerId: id, url: "/packet.pdf", document: { facts, fields: [] },
    };
  };
  const check = (doc, status) => ({
    id: `financial.line_items:${doc.id}`, status, rule: "Line-item sum rule",
    message: "Line items must match subtotal.",
    evidence: doc.document.facts.slice(0, 4).map(item => ({ ...item, documentId: doc.id })),
  });
  const original = makeDocument("original", [980, 124, 0]);
  const originalCheck = check(original, "fail");
  const report = {
    source: { runId: "run-1" }, documents: [original], policies: { checks: [originalCheck] },
    diagnoses: { [originalCheck.id]: { status: "completed", result: { reason: "Legacy LLM review" } } },
  };
  const requests = [], pdf = [], busy = [], notifications = [];
  const context = vm.createContext({
    document: {
      getElementById: id => nodes[id],
      createElement: tag => new Element(tag),
      createElementNS: (namespaceURI, tag) => Object.assign(new Element(tag), { namespaceURI }),
    },
    window: { confirm() { throw new Error("No extra confirmation is allowed."); } },
    documentLabel, fieldLabel, fieldRegions, policyChecks, policyFamily, policyProblem,
    previewPdf: async (...args) => { pdf.push(args); },
  });
  vm.runInContext(reviewSource.slice(reviewSource.indexOf("const get ="))
    .replace("export function packetReviewer", "function packetReviewer"), context);
  const reviewer = context.packetReviewer({
    api: (route, body) => new Promise((resolve, reject) => requests.push({ route, body, resolve, reject })),
    select() {}, getReport: () => report, setBusy: value => busy.push(value),
    notify: error => notifications.push(error), close() { reviewer.hide(); },
  });
  const open = packet => {
    reviewer.open(packet, {
      id: "financial.line_items", label: "Repair line items, SubTotal verification",
    });
    if (nodes["review-error"].hidden === false)
      throw new Error(nodes["review-error"].textContent);
  };
  const table = label => nodes["policy-checks"].querySelectorAll("table")
    .find(element => element.attributes["aria-label"] === label);
  const submit = name => {
    const form = nodes["policy-checks"].querySelector("form");
    const input = form.querySelector("input");
    input.value = name;
    input.oninput();
    return form.onsubmit({ preventDefault() {} });
  };
  const preview = id => {
    const doc = makeDocument(id, [1203.2, 186, 210.8], true);
    return { id, analyzerId: id, persisted: false, documents: [doc], policies: { checks: [check(doc, "pass")] } };
  };
  return { reviewer, nodes, report, original, open, submit, table, preview, requests, pdf, busy, notifications };
}

test("updated review adds component amounts and highlights their source without extra UI or saved changes", async () => {
  const f = rerunReview();
  const original = JSON.stringify(f.report);
  f.open("packet-08");
  assert.doesNotMatch(f.nodes["policy-checks"].textContent, /LLM|Not reviewed/);
  assert.match(f.nodes["policy-checks"].textContent,
    /Repair estimate line items amounts should sum to the explicit SubTotal amount/);
  assert.match(f.nodes["policy-checks"].textContent,
    /Update and build the extractor in CU Studio to improve extraction quality/);
  assert.deepEqual(
    f.table("Original extracted fields").querySelector("tbody").children
      .map(row => row.children.at(-1).textContent),
    ["980", "124", "0", "1600"],
  );
  assert.doesNotMatch(f.table("Original extracted fields").textContent, /Currency|false/);
  assert.equal(f.nodes["policy-checks"].querySelectorAll(".policy-evidence")
    .flatMap(section => section.querySelectorAll("button")).length, 0);
  assert.doesNotMatch(f.nodes["policy-checks"].textContent, /Azure charges apply|Rerun results stay in memory/);
  const pending = f.submit("updated_repair");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].route, "document/packet-08");
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0].body)), {
    live: true, sourceId: "05-estimate", analyzerId: "updated_repair",
  });
  assert.match(f.nodes["policy-checks"].textContent, /Rerunning this source PDF/);
  assert.equal(f.busy.at(-1), true);
  f.requests[0].resolve({ preview: f.preview("updated-1") });
  await pending;
  assert.equal(f.busy.at(-1), false);
  assert.deepEqual(
    f.table("Updated extracted fields").querySelector("tbody").children
      .map(row => row.children.at(-1).textContent),
    ["1203.2", "980", "223.2", "186", "124", "62", "210.8", "0", "210.8", "1600"],
  );
  assert.match(f.table("Updated extracted fields").textContent, /Parts Amount/);
  assert.match(f.table("Updated extracted fields").textContent, /Labor Amount/);
  assert.doesNotMatch(f.table("Updated extracted fields").textContent, /Currency|false/);
  assert.equal(f.pdf.at(-1)[2].length, 10);
  assert.ok(f.pdf.at(-1)[2].some(region => region.polygon[0] === 0.2));
  assert.ok(f.pdf.at(-1)[2].some(region => region.polygon[0] === 0.4));
  assert.equal(f.nodes["policy-checks"].querySelectorAll(".policy-evidence")
    .flatMap(section => section.querySelectorAll("button")).length, 0);
  const rows = f.nodes["policy-checks"].querySelectorAll("tr");
  rows.find(row => row.dataset.result === "original").click();
  const oldBoxes = f.pdf.at(-1)[2];
  rows.find(row => row.dataset.result === "rerun").click();
  const updatedBoxes = f.pdf.at(-1)[2];
  assert.notDeepEqual(oldBoxes, updatedBoxes);
  assert.equal(oldBoxes[0].polygon[0], 0.1);
  assert.equal(updatedBoxes[0].polygon[0], 0.6);
  assert.equal(oldBoxes.length, 4);
  assert.equal(updatedBoxes.length, 10);
  f.reviewer.hide();
  f.open("packet-01");
  assert.equal(f.table("Updated extracted fields"), undefined);
  f.open("packet-08");
  assert.ok(f.table("Original extracted fields"));
  assert.ok(f.table("Updated extracted fields"));
  assert.equal(JSON.stringify(f.report), original);
  f.reviewer.reset();
  f.open("packet-08");
  assert.equal(f.table("Updated extracted fields"), undefined);
});

test("formula-only fields retain component fallback inputs, zero and a missing subtotal", () => {
  const f = rerunReview();
  const check = f.report.policies.checks[0];
  check.status = "not_checkable";
  check.evidence = [
    { documentId: f.original.id, field: "LineItems[0].PartsAmount", value: 0, regions: [] },
    { documentId: f.original.id, field: "LineItems[0].LaborAmount", value: 210.8, regions: [] },
    { documentId: f.original.id, field: "SubtotalAmount.Amount", value: null, regions: [] },
    { documentId: f.original.id, field: "SubtotalAmount.CurrencyCode", value: "USD", regions: [] },
  ];
  f.open("packet-08");
  const table = f.table("Original extracted fields");
  assert.deepEqual(
    table.querySelector("tbody").children.map(row => row.children.at(-1).textContent),
    ["0", "210.8", "not returned"],
  );
  assert.match(table.textContent, /Parts Amount|Part Amount/);
  assert.match(table.textContent, /Labor Amount/);
  assert.doesNotMatch(table.textContent, /Currency|Total Amount|Is Credit/);
});

test("starting another rerun replaces the prior preview and retains explicit failures for that source", async () => {
  const f = rerunReview();
  f.open("packet-08");
  const first = f.submit("updated_one");
  f.requests[0].resolve({ preview: f.preview("updated-1") });
  await first;
  assert.ok(f.table("Updated extracted fields"));
  const second = f.submit("updated_two");
  assert.equal(f.table("Updated extracted fields"), undefined);
  assert.match(f.nodes["policy-checks"].textContent, /Rerunning this source PDF/);
  f.requests[1].reject(new Error("Choose a ready single-document extractor."));
  await second;
  assert.equal(f.table("Updated extracted fields"), undefined);
  assert.match(f.nodes["policy-checks"].textContent, /Choose a ready single-document extractor/);
  f.reviewer.hide();
  f.open("packet-08");
  assert.match(f.nodes["policy-checks"].textContent, /Choose a ready single-document extractor/);
  const third = f.submit("updated_three");
  f.requests[2].resolve({ preview: f.preview("updated-3") });
  await third;
  assert.equal(f.nodes["policy-checks"].querySelectorAll(".policy-preview").length, 1);
  assert.match(f.nodes["policy-checks"].textContent, /Analyzer: updated-3/);
  assert.doesNotMatch(f.nodes["policy-checks"].textContent, /updated-1|Choose a ready/);
});

test("top-level pivots preserve the selected extraction type and share the existing results surface", () => {
  const buttons = ["extract", "policies", "policy"].map((workflow) => ({
    dataset: { workflow }, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  }));
  const nodes = {
    "workflow-pivots": { querySelectorAll: () => buttons },
    "view-types": { hidden: false },
    "extraction-toolbar": { hidden: false },
    "policy-toolbar": { hidden: false },
    "show-confidence": { closest: () => ({ hidden: false }) },
    "results-heading": { textContent: "" },
    "policy-table-intro": { hidden: false },
    batch: { hidden: false },
  };
  let renders = 0;
  const context = vm.createContext({
    get: (id) => nodes[id], clearTimeout() {}, clickTimer: undefined,
    selectionVersion: 0, view: "rental_invoice", lastExtractionView: "classification",
    allFields: false, run: {}, selectedPacket: "", showPolicyPanel() {},
    renderTable() { renders++; }, renderPolicyOutput() {},
    busy: false, policyBusy: false, policyCacheBusy: false,
    policyCaches: async () => {}, fail() {}, showCustomer: async () => {},
  });
  vm.runInContext(source.slice(source.indexOf("function renderWorkflowNavigation()"),
    source.indexOf('for (const button of document.querySelectorAll("[data-view]"))')), context);
  vm.runInContext('activateView("policies")', context);
  assert.equal(nodes["results-heading"].textContent, "Business rules validation");
  assert.equal(nodes["view-types"].hidden, true);
  assert.equal(nodes["extraction-toolbar"].hidden, true);
  assert.equal(buttons[1].attributes["aria-pressed"], "true");
  vm.runInContext('activateView("policy")', context);
  assert.equal(nodes["results-heading"].textContent, "Check Policies: Rental Car");
  assert.equal(context.lastExtractionView, "rental_invoice");
  vm.runInContext("activateView(lastExtractionView)", context);
  assert.equal(nodes["view-types"].hidden, false);
  assert.equal(nodes["extraction-toolbar"].hidden, false);
  assert.equal(context.view, "rental_invoice");
  assert.equal(buttons[0].attributes["aria-pressed"], "true");
  assert.equal(renders, 3);
});

test("Parse and extract customer cells do not add consistency badges", () => {
  const customerBlock = source.slice(
    source.indexOf('const customer = element("div", undefined, "customer-cell")'),
    source.indexOf('if (item.status === "running")'),
  );
  assert.doesNotMatch(customerBlock, /packet-policy-summary|needs-review|showPolicyView|["`]Checks["`]|review/);
  assert.doesNotMatch(source, /\.packet-policy-summary/);
  const policyBlock = source.slice(
    source.indexOf("const checks = policyChecks(result, column)"),
    source.indexOf("const segments =", source.indexOf("const checks = policyChecks(result, column)")),
  );
  assert.match(policyBlock, /policySummary\(checks\)/);
  assert.match(policyBlock, /policy-matrix-button/);
});

test("activity reports actual stage elapsed time and last poll, including interrupted progress", () => {
  const time = {}, connection = {};
  const activity = { querySelector: (selector) =>
    selector === ".policy-activity-time" ? time : connection };
  const now = 1_000_000;
  class Clock extends Date { static now() { return now; } }
  const errors = new Map();
  const context = vm.createContext({
    Date: Clock,
    get: () => ({ querySelector: () => activity }),
    policyMode: "search", selectedPacket: "packet-01",
    policyPolls: new Map([["search", now - 2000]]),
    policyProgressErrors: errors,
    policyResults: new Map([["search", {
      startedAt: new Date(now - 300_000).toISOString(),
      items: [{ id: "packet-01", stageStartedAt: new Date(now - 61_000).toISOString() }],
    }]]),
    renderPolicyRunStatus() {},
  });
  vm.runInContext(source.slice(source.indexOf("function updatePolicyActivity()"),
    source.indexOf("function renderPolicyTable()")), context);
  vm.runInContext("updatePolicyActivity()", context);
  assert.equal(time.textContent, "1m 1s in this stage");
  assert.equal(connection.textContent, "Workbench responded 2s ago.");
  errors.set("search", "Network unavailable");
  vm.runInContext("updatePolicyActivity()", context);
  assert.match(connection.textContent, /Progress updates stopped: Network unavailable/);
  assert.match(connection.textContent, /do not start a duplicate review/);
});

test("policy review and confirmation use saved Parse evidence with no summary preparation stage", async () => {
  const html = await readFile(new URL("../web/workbench.html", import.meta.url), "utf8");
  assert.doesNotMatch(source, /claimSummaryPrepared|Claim fields not prepared|extracting:|status === "extracting"|all five checks/);
  assert.match(source, /Retries the three checks for this case only, using saved Parse fields and selected first-pass page text/);
  assert.match(source, /No claim CU reanalysis is run/);
  const confirmation = html.slice(html.indexOf('<dialog id="policy-confirmation"'));
  assert.match(confirmation, /saved Parse fields and selected first-pass page text; no claim CU reanalysis/);
  assert.match(confirmation, /three comparisons for each remaining case/);
  assert.doesNotMatch(confirmation, /Prepare any missing claim fields|new extraction and agent calls/);
});

test("claim comparisons link preserved text page ranges without guessing fields or adding polygons", async () => {
  class Node {
    children = [];
    isConnected = true;
    classList = { add() {} };
    constructor(tag, textContent = "", className = "") {
      Object.assign(this, { tag, textContent, className });
    }
    get firstChild() { return this.children[0]; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    remove() { this.isConnected = false; }
  }
  const fact = {
    field: "parse.contents[2]", contentPath: "contents[2]", category: "statement",
    status: "present", value: "Vehicle not drivable. Rental starts at loss.",
    pages: { start: 5, end: 7 }, href: "/data/packets/packet-02.pdf", regions: [],
  };
  const calls = [], opened = [], requests = new Map();
  const context = vm.createContext({
    run: { id: "saved-parse" }, policyMode: "search", claimEvidenceRequests: requests,
    claimFieldSources, element: (tag, text, className) => new Node(tag, text, className),
    api: async (route) => { calls.push(route); return { fields: [fact] }; },
    comparisonLink: (text, href, title, open) => Object.assign(new Node("a", text), { href, title, open }),
    openClaimSource: async (...args) => { opened.push(args); },
  });
  vm.runInContext(source.slice(source.indexOf("function addClaimComparisonSources("),
    source.indexOf("function beginPolicySource(")), context);
  const cell = new Node("td");
  context.cell = cell;
  vm.runInContext('addClaimComparisonSources(cell, "parse.contents[2]", "At loss", "packet-02", "review-1")', context);
  await Promise.all(requests.values());
  const link = cell.firstChild.children[0];
  assert.equal(link.href, "/data/packets/packet-02.pdf#page=5");
  assert.match(link.title, /First-pass parsed page text · pages 5–7 · derived interpretation, not a typed CU fact/);
  assert.ok(cell.children.some((node) => /First-pass parsed page text/.test(node.textContent)));
  await link.open(link);
  assert.equal(opened[0][0].pages, fact.pages);
  assert.equal(opened[0][0].page, 5);
  assert.deepEqual(opened[0][0].regions, []);
  const unknown = new Node("td");
  context.cell = unknown;
  vm.runInContext('addClaimComparisonSources(cell, "Drivability", "Not drivable", "packet-02", "review-1")', context);
  await Promise.all(requests.values());
  assert.ok(unknown.children.some((node) => node.textContent === "No supplied source location"));
  assert.ok(!unknown.children.some((node) => node.tag === "a"));
  assert.equal(calls.length, 1);
});
