import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");

test("top-level pivots preserve the selected extraction type and share the existing results surface", () => {
  const buttons = ["extract", "policies", "policy"].map((workflow) => ({
    dataset: { workflow }, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  }));
  const nodes = {
    "workflow-pivots": { querySelectorAll: () => buttons },
    "view-types": { hidden: false },
    "extraction-toolbar": { hidden: false },
    "results-heading": { textContent: "" },
  };
  let renders = 0;
  const context = vm.createContext({
    get: (id) => nodes[id], clearTimeout() {}, clickTimer: undefined,
    selectionVersion: 0, view: "rental_invoice", lastExtractionView: "classification",
    allFields: false, run: {}, selectedPacket: "", showPolicyPanel() {},
    renderTable() { renders++; }, renderPolicyOutput() {},
    busy: false, policyBusy: false, policyCacheBusy: false,
    policyCaches: async () => {}, fail() {},
  });
  vm.runInContext(source.slice(source.indexOf("function renderWorkflowNavigation()"),
    source.indexOf('for (const button of document.querySelectorAll("[data-view]"))')), context);
  vm.runInContext('activateView("policies")', context);
  assert.equal(nodes["results-heading"].textContent, "Check consistency");
  assert.equal(nodes["view-types"].hidden, true);
  assert.equal(nodes["extraction-toolbar"].hidden, true);
  assert.equal(buttons[1].attributes["aria-pressed"], "true");
  vm.runInContext('activateView("policy")', context);
  assert.equal(nodes["results-heading"].textContent, "Check policies");
  assert.equal(context.lastExtractionView, "rental_invoice");
  vm.runInContext("activateView(lastExtractionView)", context);
  assert.equal(nodes["view-types"].hidden, false);
  assert.equal(nodes["extraction-toolbar"].hidden, false);
  assert.equal(context.view, "rental_invoice");
  assert.equal(buttons[0].attributes["aria-pressed"], "true");
  assert.equal(renders, 3);
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
