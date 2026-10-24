import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

test("policy checks show bold Expected and Actual, italic reasoning and an in-pane source", async () => {
  const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
  class Node {
    children: Node[] = [];
    id = "";
    href = "";
    onclick?: (event: { preventDefault: () => void }) => void;
    constructor(public tag: string, public textContent = "", public className = "") {}
    append(...nodes: Node[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Node[]) { this.children = nodes; }
  }
  const panel = new Node("div");
  const check = {
    Check: "Daily rate", Outcome: "ReviewRequired", ReviewRequired: true,
    ExpectedValue: "Policy <= $85/day; WA routine <= $60/day",
    ActualValue: "$61/day",
    Reason: "<b>Not HTML</b>: WA routine threshold exceeded; obtain exception approval.",
  };
  const citation = { href: "/data/policies/rental/wa-rental-review-sop.pdf#page=2",
    DocumentId: "WA-RENTAL-001", Version: "v1.0", RuleId: "WA-R2", Section: "2. Five-rule decision matrix" };
  let opened: unknown, prevented = false;
  const context = vm.createContext({
    get: () => panel,
    element: (tag: string, text?: string, className?: string) => new Node(tag, text, className),
    view: "policy", policySource: null, policyPaneMode: "result", selectedPacket: "packet-02", policyMode: "search",
    policyResults: new Map([["search", { items: [{
      id: "packet-02", completedAt: "2026-01-01", result: { Checks: [check] }, citations: [[citation]],
    }] }]]),
    results: new Map(),
    showPolicyPanel: () => {},
    customerName: () => "Sample customer",
    policyModeLabel: () => "Azure Search retrieval",
    openPolicySource: async (value: unknown) => { opened = value; },
    fail: (error: unknown) => { throw error; },
  });
  const renderer = source.slice(source.indexOf("function renderPolicyOutput("), source.indexOf("async function openPolicySource("));
  vm.runInContext(`${renderer}\nrenderPolicyOutput();`, context);
  const section = panel.children.find((node) => node.tag === "section")!;
  assert.equal(section.children[0].textContent, "1. Daily rate");
  assert.equal(section.children[1].textContent, "Review required");
  assert.match(section.children[1].className, /policy-review/);
  const values = section.children[2];
  assert.equal(values.tag, "dl");
  assert.deepEqual(values.children.map((node) => node.tag), ["dt", "dd", "dt", "dd"]);
  assert.deepEqual(values.children.filter((node) => node.tag === "dt").map((node) => node.textContent), ["Expected:", "Actual:"]);
  assert.deepEqual(values.children.filter((node) => node.tag === "dd").map((node) => [node.children[0].tag, node.children[0].textContent]),
    [["strong", check.ExpectedValue], ["strong", check.ActualValue]]);
  assert.equal(section.children[3].children[0].tag, "em");
  assert.equal(section.children[3].children[0].textContent, `Reasoning: ${check.Reason}`);
  assert.equal(section.children[4].textContent, "Source:");
  const link = section.children[5];
  assert.equal(link.href, citation.href);
  assert.match(link.textContent, /WA-RENTAL-001 v1\.0 ·/);
  link.onclick!({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(opened, citation);
  check.Outcome = "NotApplicable";
  check.ReviewRequired = false;
  vm.runInContext("renderPolicyOutput();", context);
  const notApplicable = panel.children.find((node) => node.tag === "section")!;
  assert.equal(notApplicable.children[1].textContent, "Not applicable");
  assert.match(notApplicable.children[1].className, /policy-na/);
  assert.ok(!notApplicable.children[1].className.includes("policy-satisfied"));
});

test("policy citations preview locally and Back restores the check list and focus", async () => {
  const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
  const nodes = new Map<string, { hidden: boolean; scrollTop: number; textContent: string; focus: () => void; onclick?: () => void }>();
  let focused = "", preview: unknown;
  for (const id of ["policy-output", "pdf-scroll", "policy-source-toolbar",
    "policy-source-title", "download", "policy-source-back", "pdf-controls", "pdf-status",
    "policy-chat", "policy-pane-modes"])
    nodes.set(id, { hidden: false, scrollTop: 120, textContent: "", focus: () => { focused = id; } });
  const context = vm.createContext({
    get: (id: string) => nodes.get(id),
    resetPreview: () => {},
    previewPdf: async (...args: unknown[]) => { preview = args; },
    policyDocument: { close: () => {}, open: async (...args: unknown[]) => { preview = args; } },
    citation: { href: "/data/policies/rental/tx-rental-review-sop.pdf#page=2",
      DocumentId: "TX-RENTAL-001", RuleId: "TX-R2", Section: "2. Five-rule decision matrix" },
    link: { focus: () => { focused = "citation"; } },
  });
  const helpers = source.slice(source.indexOf("function showPolicyPanel("), source.indexOf("function policyMessage("));
  const navigation = source.slice(source.indexOf("async function openPolicySource("), source.indexOf('for (const mode of ["result", "chat"])'));
  vm.runInContext(`let policySource; let policyPaneMode = "result";\n${helpers}\n${navigation}`, context);
  await vm.runInContext("openPolicySource(citation, link)", context);
  assert.equal(JSON.stringify(preview), JSON.stringify(["/data/policies/rental/tx-rental-review-sop.pdf", 2]));
  assert.equal(nodes.get("policy-output")!.hidden, true);
  assert.equal(nodes.get("policy-source-toolbar")!.hidden, false);
  assert.equal(focused, "policy-source-back");
  nodes.get("policy-output")!.scrollTop = 0;
  nodes.get("policy-source-back")!.onclick!();
  assert.equal(nodes.get("policy-output")!.hidden, false);
  assert.equal(nodes.get("policy-output")!.scrollTop, 120);
  assert.equal(nodes.get("policy-source-toolbar")!.hidden, true);
  assert.equal(focused, "citation");
  await assert.rejects(vm.runInContext("openPolicySource({href:'https://example.com/file.pdf'}, link)", context), /verified local PDF/);
  vm.runInContext('policyPaneMode = "chat";', context);
  nodes.get("policy-chat")!.scrollTop = 80;
  await vm.runInContext("openPolicySource(citation, link)", context);
  assert.equal(nodes.get("policy-chat")!.hidden, true);
  assert.equal(nodes.get("policy-source-back")!.textContent, "Back to chat");
  nodes.get("policy-chat")!.scrollTop = 0;
  nodes.get("policy-source-back")!.onclick!();
  assert.equal(nodes.get("policy-chat")!.hidden, false);
  assert.equal(nodes.get("policy-output")!.hidden, true);
  assert.equal(nodes.get("policy-chat")!.scrollTop, 80);
});

test("Result remains the default and switching to Chat preserves the result scroll position", async () => {
  const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../web/workbench.html", import.meta.url), "utf8");
  assert.match(source, /let policyPaneMode = "result"/);
  assert.match(html, /id="policy-result-mode" aria-pressed="true"/);
  assert.match(html, /id="policy-chat-mode" class="secondary" aria-pressed="false"/);
  const nodes = new Map<string, {
    scrollTop: number; onclick?: () => void; pressed?: string;
    setAttribute: (name: string, value: string) => void;
    classList: { toggle: () => void };
  }>();
  for (const id of ["policy-result-mode", "policy-chat-mode", "policy-output"]) {
    const node = { scrollTop: id === "policy-output" ? 180 : 0, pressed: "",
      setAttribute(_name: string, value: string) { this.pressed = value; },
      classList: { toggle: () => {} } };
    nodes.set(id, node);
  }
  const context = vm.createContext({
    get: (id: string) => nodes.get(id), run: { id: "saved-run" }, policyMode: "search",
    selectedPacket: "packet-02", policyPaneMode: "result", policyResultScroll: new Map(),
    showPolicyPanel: () => {},
    renderPolicyOutput: () => { nodes.get("policy-output")!.scrollTop = 0; },
  });
  const handlers = source.slice(source.indexOf('for (const mode of ["result", "chat"])'),
    source.indexOf('get("policy-mode").onchange'));
  vm.runInContext(handlers, context);
  nodes.get("policy-chat-mode")!.onclick!();
  assert.equal(vm.runInContext("policyPaneMode", context), "chat");
  assert.equal(nodes.get("policy-chat-mode")!.pressed, "true");
  nodes.get("policy-result-mode")!.onclick!();
  assert.equal(nodes.get("policy-output")!.scrollTop, 180);
  assert.equal(nodes.get("policy-result-mode")!.pressed, "true");
});

test("policy status helper is callable from module scope during startup and mode changes", async () => {
  const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
  const helpers = source.slice(source.indexOf("function showPolicyPanel("), source.indexOf("async function refreshPolicy("));
  const status = { textContent: "" };
  const context = vm.createContext({
    get: () => status,
    policyMode: "ungrounded",
    policyBusy: false,
    policyStatus: { configured: false, message: "Setup required." },
  });
  vm.runInContext(`${helpers}\npolicyMessage();`, context);
  assert.equal(status.textContent, "Setup required.");
  vm.runInContext(`policyStatus = {
    modes: { search: { indexName: "policy-index", extractionMode: "standard" } },
    message: "Ready."
  }; policyMode = "search"; policyMessage();`, context);
  assert.equal(status.textContent, "policy-index · Ready.");
  assert.equal(vm.runInContext('policyModeLabel("search")', context), "Azure Search retrieval");
  assert.equal(vm.runInContext('policyModeLabel("ungrounded")', context), "No policy retrieval");
});

test("retrieval choices are disabled placeholders until verified configuration loads", async () => {
  const html = await readFile(new URL("../web/workbench.html", import.meta.url), "utf8");
  const select = html.match(/<select id="policy-mode" disabled>([\s\S]*?)<\/select>/);
  assert.ok(select);
  assert.match(select[1], /Loading policy configuration/);
  assert.ok(!select[1].includes('value="standard"'));
  assert.ok(!select[1].includes('value="minimal"'));
});

test("policy progress watcher is callable outside refreshPolicy after a page reload", async () => {
  const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
  const helpers = source.slice(source.indexOf("async function refreshPolicy("), source.indexOf("function renderPolicyTable("));
  let restoredAvailability = 0;
  const context = vm.createContext({
    policyBusy: false,
    run: { id: "saved-run", items: [] },
    policyResults: new Map([["search", { status: "completed", items: [] }]]),
    controls: () => {},
    get: () => ({ textContent: "" }),
    policyModeLabel: () => "Azure Search retrieval",
    renderTable: () => {},
    updatePolicyAvailability: async () => { restoredAvailability++; },
  });
  vm.runInContext(helpers, context);
  assert.equal(vm.runInContext("typeof watchPolicy", context), "function");
  await vm.runInContext('watchPolicy({runId:"saved-run",mode:"search",startedAt:new Date().toISOString()})', context);
  assert.equal(restoredAvailability, 1);
  assert.equal(vm.runInContext("policyBusy", context), false);
});

test("policy Run requires Search but busy batches don't disable the retrieval dropdown", async () => {
  const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
  const nodes = new Map<string, { value: string; disabled?: boolean; title?: string }>();
  const context = vm.createContext({
    get: (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { value: "available" });
      return nodes.get(id);
    },
    busy: false, sessionId: "session", catalog: {}, run: { id: "saved-run" },
    policyMode: "ungrounded", policyBusy: false, policyStatus: { configured: true, batchRunning: false },
  });
  vm.runInContext(source.slice(source.indexOf("function controls("), source.indexOf("async function caches(")), context);
  vm.runInContext("controls()", context);
  assert.equal(nodes.get("policy-run")!.disabled, true);
  assert.equal(nodes.get("policy-mode")!.disabled, false);
  vm.runInContext('policyMode = "search"; controls()', context);
  assert.equal(nodes.get("policy-run")!.disabled, false);
  vm.runInContext("policyBusy = true; controls()", context);
  assert.equal(nodes.get("policy-run")!.disabled, true);
  assert.equal(nodes.get("policy-mode")!.disabled, false);
  vm.runInContext("policyBusy = false; policyStatus.batchRunning = true; controls()", context);
  assert.equal(nodes.get("policy-run")!.disabled, true);
  assert.equal(nodes.get("policy-mode")!.disabled, false);
  vm.runInContext("policyStatus = { configured: false }; controls()", context);
  assert.equal(nodes.get("policy-run")!.disabled, true);
  assert.equal(nodes.get("policy-mode")!.disabled, true);
});

test("pane layout refreshes a narrow grid initially and clears desktop sizing when resized", async () => {
  const source = await readFile(new URL("../web/column-resize.js", import.meta.url), "utf8");
  const listeners = new Map<string, () => void>();
  const properties = new Map<string, string>();
  const style = {
    height: "",
    setProperty: (key: string, value: string) => properties.set(key, value),
    removeProperty: (key: string) => {
      properties.delete(key);
      if (key === "height") style.height = "";
    },
  };
  let refreshes = 0;
  const main = {
    style, clientWidth: 480, offsetTop: 64,
    dispatchEvent: () => { refreshes++; },
  };
  const handle = { setAttribute: () => {} };
  const window = {
    innerWidth: 480, innerHeight: 800,
    addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
  };
  const context = vm.createContext({
    window, Event, main, handle,
    getComputedStyle: () => ({ paddingLeft: "24", paddingRight: "24" }),
  });
  vm.runInContext(source.replace(/^export /gm, "") + "\nsplitPreview(main, handle);", context);
  assert.equal(refreshes, 1);
  assert.equal(style.height, "");
  window.innerWidth = 1280;
  main.clientWidth = 1232;
  listeners.get("resize")!();
  assert.equal(refreshes, 2);
  assert.equal(style.height, "736px");
  assert.ok(properties.has("--left-pane"));
  window.innerWidth = 480;
  main.clientWidth = 480;
  listeners.get("resize")!();
  assert.equal(refreshes, 3);
  assert.equal(style.height, "");
  assert.equal(properties.has("--left-pane"), false);
});
