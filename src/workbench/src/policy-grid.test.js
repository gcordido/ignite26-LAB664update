import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { resultChatText } from "../web/policy-chat.js";
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

test("numeric row totals show the same calculation and preserve mismatched arithmetic", () => {
  const value = lineItemResult("pass", 0.3);
  value.evidence = value.evidence.map((item) => ({
    ...item, field: item.field.replace(/\.TotalAmount\.Amount$/, ".TotalAmount"),
  }));
  assert.equal(policyProblem(value, []).text, "USD 0.10 + 0.20 + 0.00 = 0.30 (Subtotal)");
  value.status = "fail";
  value.evidence.find((item) => item.field === "SubtotalAmount.Amount").value = 0.32;
  assert.equal(policyProblem(value, []).text, "USD 0.10 + 0.20 + 0.00 = 0.30; Subtotal = 0.32");
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
        (column.id === "financial.line_items" ||
          column.description.includes("Full description")),
    ),
  );
});

test("legacy repair-rule tooltips describe the check without revealing the schema fix", () => {
  const legacy = {
    ...check("financial.line_items", "repair", "fail"),
    rule: "Line-item totals, or PartAmount + LaborAmount when a total is missing, must sum to the explicit subtotal.",
  };
  const original = JSON.stringify(legacy);
  const other = check("financial.total", "repair");
  const columns = policyColumns([result(legacy, other)]);
  assert.equal(columns.find(column => column.id === "financial.line_items").description,
    "Line-item totals must sum to the explicit subtotal.");
  assert.equal(columns.find(column => column.id === "financial.total").description, other.rule);
  assert.equal(JSON.stringify(legacy), original);
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

test("claim grid keeps all ten packets and exactly three named full-cell check buttons", async () => {
  const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
  class Node {
    children = [];
    dataset = {};
    style = {};
    attributes = {};
    classList = { toggle() {} };
    constructor(tag, textContent = "", className = "") {
      Object.assign(this, { tag, textContent, className });
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  const sections = Object.fromEntries(["colgroup", "thead", "tbody"].map((tag) => [tag, new Node(tag)]));
  const table = new Node("table");
  table.parentElement = { clientWidth: 620 };
  table.querySelector = (selector) => sections[selector];
  const names = ["Daily rate", "Effective terms", "Repair estimate"];
  const packets = Array.from({ length: 10 }, (_, index) => ({ id: `packet-${String(index + 1).padStart(2, "0")}` }));
  const items = packets.map(({ id }, index) => ({
    id, status: "completed",
    result: { Checks: [
      { Check: "Repair estimate", Outcome: index === 8 ? "ReviewRequired" : "Satisfied", ReviewRequired: index === 8 },
      { Check: "Effective terms", Outcome: "Satisfied", ReviewRequired: false },
      { Check: "Daily rate", Outcome: index === 9 ? "NotApplicable" : "Satisfied", ReviewRequired: false },
    ] },
  }));
  let mounted;
  const context = vm.createContext({
    get: (id) => id === "packet-table" ? table : {},
    element: (tag, text, className) => new Node(tag, text, className),
    columnWidths: new Map(), policyMode: "search",
    policyResults: new Map([["search", { items, source: "bundled" }]]),
    run: { items: packets }, selectedPacket: "packet-01",
    results: new Map(), customerName: () => "", resizeColumns() {},
    mountDetails: (count) => { mounted = count; },
  });
  vm.runInContext(source.slice(source.indexOf("const policyCheckNames ="),
    source.indexOf("let focusedPolicyCheck =")), context);
  vm.runInContext(source.slice(source.indexOf("function renderPolicyTable()"),
    source.indexOf("function openAgentCheck(")), context);
  vm.runInContext("renderPolicyTable()", context);
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(policyCheckNames)", context)), names);
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(policyShortNames)", context)), names);
  assert.equal(mounted, 3);
  assert.equal(sections.colgroup.children.length, 4);
  assert.ok(parseFloat(table.style.width) <= table.parentElement.clientWidth);
  assert.ok(table.parentElement.clientWidth - parseFloat(table.style.width) < 4,
    "the three policy checks fill the available table width without a removed column's blank space");
  assert.deepEqual(sections.thead.children[0].children.slice(1).map((cell) => cell.children[0].textContent), names);
  assert.equal(sections.thead.children[0].children[3].children[1].textContent,
    "Is each supplied repair-estimate total within this state's routine review authority?");
  assert.equal(sections.tbody.children.length, 10);
  const buttons = sections.tbody.children.flatMap((row) => row.children.slice(1).map((cell) => cell.children[0]));
  assert.equal(buttons.length, 30);
  assert.ok(buttons.every((button) => button.className === "cell-content"));
  assert.ok(buttons.every((button) => button.tag === "button" &&
    typeof button.onclick === "function" && button.attributes["aria-expanded"] === "false"));
  assert.deepEqual(buttons.slice(0, 3).map((button) => button.dataset.agentCheck), ["0", "1", "2"]);
  assert.deepEqual(buttons.slice(0, 3).map((button) => button.children[0].textContent),
    ["Satisfied", "Satisfied", "Satisfied"]);
  assert.deepEqual(buttons.slice(-3).map((button) => button.children[0].textContent),
    ["N/A", "Satisfied", "Satisfied"]);
  assert.equal(buttons[8 * 3 + 2].children[0].textContent, "Review required");
  table.parentElement.clientWidth = 360;
  vm.runInContext("renderPolicyTable()", context);
  assert.ok(parseFloat(table.style.width) <= 360);
  assert.ok(sections.tbody.children.every((row) => row.children[0].children.length === 1));
});

test("chat uses the three runtime check IDs without obsolete payment or timing labels", () => {
  const checks = ["Daily rate", "Effective terms", "Repair estimate"].map((Check) => ({
    Check, Outcome: "Satisfied", ReviewRequired: false,
    ExpectedValue: "Effective matched policy evidence", ActualValue: "Saved Parse evidence",
    Reason: "Supported comparison, conditional on eligibility; not payment approval.",
  }));
  const text = resultChatText({ Checks: checks });
  for (const { Check } of checks) assert.ok(text.includes(`${Check}\nSatisfied\n`));
  assert.doesNotMatch(text, /Daily cost|Rental start|Rental dates|Active policy|Covered charges|Payment approval/);
  checks[1].Outcome = "InProgress";
  assert.match(resultChatText({ Checks: checks }), /Effective terms\nWaiting for info - missing claim evidence for this comparison/);
});
