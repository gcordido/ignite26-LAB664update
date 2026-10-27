import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { fieldRegions } from "../web/result-model.js";

test("policy evidence uses plain field/value rows and one highlight action per source PDF", async () => {
  const source = await readFile(
    new URL("../web/packet-review.js", import.meta.url),
    "utf8",
  );
  class Node {
    children: Node[] = [];
    onclick?: () => void;
    constructor(
      public tag: string,
      public textContent = "",
      public className = "",
    ) {}
    append(...nodes: Node[]) {
      this.children.push(...nodes);
    }
  }
  const first = { id: "invoice", url: "/packet.pdf", name: "Rental invoice" };
  const second = { id: "repair", url: "/packet.pdf", name: "Repair estimate" };
  const entries = [
    { doc: first, item: { field: "Tax", value: 0 } },
    { doc: first, item: { field: "Missing", value: null } },
    { doc: first, item: { field: "Tax.CurrencyCode", value: "USD" } },
    { doc: second, item: { field: "Confirmed", value: false } },
  ];
  const groups: unknown[][] = [];
  const context = vm.createContext({
    node: (tag: string, text?: string, className?: string) =>
      new Node(tag, text, className),
    documentName: (doc: typeof first) => doc.name,
    fieldLabel: (field: string) => field,
    showAllEvidence: (group: unknown[]) => groups.push(group),
    entries,
  });
  const renderer = source.slice(
    source.indexOf("function evidenceTable("),
    source.indexOf("function renderRerunDocuments("),
  );
  const table = vm.runInContext(
    `${renderer}\nevidenceTable(entries);`,
    context,
  ) as Node;
  assert.equal(
    table.children.filter((node) => node.tag === "button").length,
    1,
  );
  const rows = table.children.find((node) => node.tag === "table")!.children[1]
    .children;
  assert.deepEqual(
    rows.map((row) => row.children.at(-1)!.textContent),
    ["0", "missing", "false"],
  );
  assert.ok(
    rows.every((row) =>
      row.children.every((cell) => cell.tag === "td" && !cell.children.length),
    ),
  );
  table.children[0].onclick!();
  assert.equal(groups[0].length, 3);
  assert.equal(groups[0][0], entries[0]);
  second.url = "/different.pdf";
  const separate = vm.runInContext("evidenceTable(entries);", context) as Node;
  const buttons = separate.children.filter((node) => node.tag === "button");
  assert.equal(buttons.length, 2);
  buttons[1].onclick!();
  assert.equal(groups[1].length, 1);
  assert.equal(groups[1][0], entries[3]);
});

test("highlighting a policy's values deduplicates native boxes, retains multiple pages and explains missing evidence", async () => {
  const source = await readFile(
    new URL("../web/packet-review.js", import.meta.url),
    "utf8",
  );
  const first = { page: 8, polygon: [0.1, 0.1, 0.2, 0.1, 0.2, 0.2, 0.1, 0.2] };
  const second = { page: 9, polygon: [0.3, 0.3, 0.4, 0.3, 0.4, 0.4, 0.3, 0.4] };
  const total = {
    field: "TotalTaxAmount.Amount",
    value: 1,
    status: "present",
    regions: [],
  };
  const details = [
    {
      field: "TaxDetails[0].Amount.Amount",
      value: 0,
      status: "present",
      regions: [first],
    },
    {
      field: "TaxDetails[1].Amount.Amount",
      value: 1,
      status: "present",
      regions: [second],
    },
  ];
  const doc = {
    url: "/packet.pdf",
    start: 8,
    document: {
      facts: [total, ...details],
      fields: [
        {
          field: "TaxDetails",
          kind: "array",
          items: details.map((fact) => [
            fact,
            {
              field: "TaxDetails[0].Description",
              value: "Component tax",
              status: "present",
              regions: [
                { page: 8, polygon: [0.5, 0.5, 0.6, 0.5, 0.6, 0.6, 0.5, 0.6] },
              ],
            },
          ]),
        },
      ],
    },
  };
  const entries = [
    total,
    ...details,
    { field: "Missing", value: null, regions: [] },
  ].map((item) => ({ doc, item }));
  const calls: unknown[][] = [];
  const status = { textContent: "", hidden: true };
  const context = vm.createContext({
    entries,
    packetId: "packet-02",
    select: () => {},
    fieldRegions,
    previewPdf: async (...args: unknown[]) => {
      calls.push(args);
    },
    get: () => status,
    notify: (error: unknown) => {
      throw error;
    },
  });
  const helpers = source.slice(
    source.indexOf("function evidenceRegions("),
    source.indexOf("function showEvidence("),
  );
  await vm.runInContext(`${helpers}\nshowAllEvidence(entries);`, context);
  assert.equal(calls[0][0], "/packet.pdf");
  assert.equal(calls[0][1], 8);
  const highlights = calls[0][2] as (typeof first)[];
  assert.equal(highlights.length, 2);
  assert.equal(highlights[0], first);
  assert.equal(highlights[1], second);
  assert.equal(JSON.stringify(calls[0][3]), '{"zoom":1}');
  assert.match(status.textContent, /pages 8, 9/);
  assert.match(status.textContent, /Tax-detail context/);
  assert.match(status.textContent, /Missing values/);
  doc.document.fields = [];
  await vm.runInContext("showAllEvidence([entries[0], entries[3]]);", context);
  assert.equal((calls[1][2] as unknown[]).length, 0);
  assert.match(status.textContent, /No source boxes were returned/);
});

test("inline policy details show only the selected check with Expected, Actual, reasoning and a source", async () => {
  const source = await readFile(
    new URL("../web/workbench.js", import.meta.url),
    "utf8",
  );
  class Node {
    children: Node[] = [];
    id = "";
    href = "";
    onclick?: (event: { preventDefault: () => void }) => void;
    constructor(
      public tag: string,
      public textContent = "",
      public className = "",
    ) {}
    append(...nodes: Node[]) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes: Node[]) {
      this.children = nodes;
    }
    scrollIntoView() {}
  }
  const panel = new Node("div");
  const title = new Node("h3");
  const check = {
    Check: "Daily rate",
    Outcome: "ReviewRequired",
    ReviewRequired: true,
    ExpectedValue: "Policy <= $85/day; WA routine <= $60/day",
    ActualValue: "$61/day",
    Reason:
      "<b>Not HTML</b>: WA routine threshold exceeded; obtain exception approval.",
  };
  const citation = {
    href: "/data/policies/rental/wa-rental-review-sop.pdf#page=2",
    DocumentId: "WA-RENTAL-001",
    Version: "v1.0",
    RuleId: "WA-R2",
    Section: "2. Five-rule decision matrix",
  };
  let opened: unknown,
    prevented = false;
  const context = vm.createContext({
    get: (id: string) => (id === "agent-title" ? title : panel),
    element: (tag: string, text?: string, className?: string) =>
      new Node(tag, text, className),
    view: "policy",
    policySource: null,
    policyPaneMode: "result",
    selectedPacket: "packet-02",
    policyMode: "search",
    policyCheckNames: ["Daily rate", "Rental period"],
    focusedPolicyCheck: 0,
    policyResults: new Map([
      [
        "search",
        {
          items: [
            {
              id: "packet-02",
              completedAt: "2026-01-01",
              result: { Checks: [check, { ...check, Check: "Rental period" }] },
              citations: [[citation]],
            },
          ],
        },
      ],
    ]),
    results: new Map(),
    showPolicyPanel: () => {},
    customerName: () => "Sample customer",
    policyModeLabel: () => "Azure Search retrieval",
    openPolicySource: async (value: unknown) => {
      opened = value;
    },
    fail: (error: unknown) => {
      throw error;
    },
  });
  const renderer = source.slice(
    source.indexOf("function renderPolicyOutput("),
    source.indexOf("async function openPolicySource("),
  );
  vm.runInContext(`${renderer}\nrenderPolicyOutput();`, context);
  const section = panel.children.find((node) => node.tag === "section")!;
  assert.equal(title.textContent, "Daily rate");
  assert.equal(
    panel.children.filter((node) => node.tag === "section").length,
    1,
  );
  assert.equal(section.children[0].textContent, "Review required");
  assert.match(section.children[0].className, /policy-review/);
  const values = section.children[1];
  assert.equal(values.tag, "dl");
  assert.deepEqual(
    values.children.map((node) => node.tag),
    ["dt", "dd", "dt", "dd"],
  );
  assert.deepEqual(
    values.children
      .filter((node) => node.tag === "dt")
      .map((node) => node.textContent),
    ["Expected:", "Actual:"],
  );
  assert.deepEqual(
    values.children
      .filter((node) => node.tag === "dd")
      .map((node) => [node.children[0].tag, node.children[0].textContent]),
    [
      ["strong", check.ExpectedValue],
      ["strong", check.ActualValue],
    ],
  );
  assert.equal(section.children[2].children[0].tag, "em");
  assert.equal(
    section.children[2].children[0].textContent,
    `Reasoning: ${check.Reason}`,
  );
  assert.equal(section.children[3].textContent, "Source:");
  const link = section.children[4];
  assert.equal(link.href, citation.href);
  assert.match(link.textContent, /WA-RENTAL-001 v1\.0 ·/);
  link.onclick!({
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(opened, citation);
  check.Outcome = "NotApplicable";
  check.ReviewRequired = false;
  vm.runInContext("renderPolicyOutput();", context);
  const notApplicable = panel.children.find((node) => node.tag === "section")!;
  assert.equal(notApplicable.children[0].textContent, "Not applicable");
  assert.match(notApplicable.children[0].className, /policy-na/);
  assert.ok(!notApplicable.children[0].className.includes("policy-satisfied"));
  vm.runInContext("renderPolicyOutput(1);", context);
  assert.equal(title.textContent, "Rental period");
  assert.equal(
    panel.children.filter((node) => node.tag === "section").length,
    1,
  );
});

test("policy citations keep inline details visible and Back restores the claim document and focus", async () => {
  const source = await readFile(
    new URL("../web/workbench.js", import.meta.url),
    "utf8",
  );
  const nodes = new Map<
    string,
    {
      hidden: boolean;
      scrollTop: number;
      textContent: string;
      focus: () => void;
      onclick?: () => void;
    }
  >();
  let focused = "",
    preview: unknown;
  for (const id of [
    "packets",
    "policy-output",
    "pdf-scroll",
    "policy-source-toolbar",
    "policy-source-title",
    "download",
    "policy-source-back",
    "pdf-controls",
    "pdf-status",
    "policy-chat",
    "policy-pane-modes",
    "close-agent",
  ])
    nodes.set(id, {
      hidden: false,
      scrollTop: id === "packets" ? 120 : 0,
      textContent: "",
      focus: () => {
        focused = id;
      },
    });
  const context = vm.createContext({
    get: (id: string) => nodes.get(id),
    resetPreview: () => {},
    previewPdf: async (...args: unknown[]) => {
      preview = args;
    },
    policyDocument: {
      close: () => {},
      open: async (...args: unknown[]) => {
        preview = args;
      },
    },
    citation: {
      href: "/data/policies/rental/tx-rental-review-sop.pdf#page=2",
      DocumentId: "TX-RENTAL-001",
      RuleId: "TX-R2",
      Section: "2. Five-rule decision matrix",
    },
    link: {
      focus: () => {
        focused = "citation";
      },
    },
    collapseDetails: () => {},
    selectedPacket: "packet-02",
    showAgentClaim: async () => {},
    fail: (error: unknown) => {
      throw error;
    },
  });
  const helpers = source.slice(
    source.indexOf("function showPolicyPanel("),
    source.indexOf("function policyMessage("),
  );
  const navigation = source.slice(
    source.indexOf("async function openPolicySource("),
    source.indexOf('for (const mode of ["result", "chat"])'),
  );
  vm.runInContext(
    `let policySource; let policyPaneMode = "result";\n${helpers}\n${navigation}`,
    context,
  );
  await vm.runInContext("openPolicySource(citation, link)", context);
  assert.equal(
    JSON.stringify(preview),
    JSON.stringify(["/data/policies/rental/tx-rental-review-sop.pdf", 2]),
  );
  assert.equal(nodes.get("policy-output")!.hidden, false);
  assert.equal(nodes.get("policy-source-toolbar")!.hidden, false);
  assert.equal(focused, "policy-source-back");
  nodes.get("packets")!.scrollTop = 0;
  nodes.get("policy-source-back")!.onclick!();
  assert.equal(nodes.get("policy-output")!.hidden, false);
  assert.equal(nodes.get("packets")!.scrollTop, 120);
  assert.equal(nodes.get("policy-source-toolbar")!.hidden, true);
  assert.equal(focused, "citation");
  await assert.rejects(
    vm.runInContext(
      "openPolicySource({href:'https://example.com/file.pdf'}, link)",
      context,
    ),
    /verified local PDF/,
  );
  vm.runInContext('policyPaneMode = "chat"; showPolicyPanel(true);', context);
  nodes.get("packets")!.scrollTop = 80;
  await vm.runInContext("openPolicySource(citation, link)", context);
  assert.equal(nodes.get("policy-chat")!.hidden, false);
  assert.equal(
    nodes.get("policy-source-back")!.textContent,
    "Back to claim document",
  );
  nodes.get("packets")!.scrollTop = 0;
  nodes.get("policy-source-back")!.onclick!();
  assert.equal(nodes.get("policy-chat")!.hidden, false);
  assert.equal(nodes.get("policy-output")!.hidden, true);
  assert.equal(nodes.get("packets")!.scrollTop, 80);
});

test("Result remains the default and switching to Chat preserves the result scroll position", async () => {
  const source = await readFile(
    new URL("../web/workbench.js", import.meta.url),
    "utf8",
  );
  const html = await readFile(
    new URL("../web/workbench.html", import.meta.url),
    "utf8",
  );
  assert.match(source, /let policyPaneMode = "result"/);
  assert.match(html, /id="policy-result-mode" aria-pressed="true"/);
  assert.match(
    html,
    /id="policy-chat-mode"\s+class="secondary"\s+aria-pressed="false"/,
  );
  const nodes = new Map<
    string,
    {
      scrollTop: number;
      onclick?: () => void;
      pressed?: string;
      setAttribute: (name: string, value: string) => void;
      classList: { toggle: () => void };
    }
  >();
  for (const id of [
    "packets",
    "policy-result-mode",
    "policy-chat-mode",
    "policy-output",
  ]) {
    const node = {
      scrollTop: id === "packets" ? 180 : 0,
      pressed: "",
      setAttribute(_name: string, value: string) {
        this.pressed = value;
      },
      classList: { toggle: () => {} },
    };
    nodes.set(id, node);
  }
  const context = vm.createContext({
    get: (id: string) => nodes.get(id),
    run: { id: "saved-run" },
    policyMode: "search",
    selectedPacket: "packet-02",
    policyPaneMode: "result",
    policyResultScroll: new Map(),
    showPolicyPanel: () => {},
    renderPolicyOutput: () => {
      nodes.get("packets")!.scrollTop = 0;
    },
  });
  const handlers = source.slice(
    source.indexOf('for (const mode of ["result", "chat"])'),
    source.indexOf('get("policy-mode").onchange'),
  );
  vm.runInContext(handlers, context);
  nodes.get("policy-chat-mode")!.onclick!();
  assert.equal(vm.runInContext("policyPaneMode", context), "chat");
  assert.equal(nodes.get("policy-chat-mode")!.pressed, "true");
  nodes.get("policy-result-mode")!.onclick!();
  assert.equal(nodes.get("packets")!.scrollTop, 180);
  assert.equal(nodes.get("policy-result-mode")!.pressed, "true");
});

test("new chat messages reveal only the active visible composer", async () => {
  const source = await readFile(
    new URL("../web/policy-chat.js", import.meta.url),
    "utf8",
  );
  const frames: (() => void)[] = [];
  const scrolls: unknown[] = [];
  let visible = true;
  const context = vm.createContext({
    revision: 0,
    generation: 0,
    key: "first",
    selectionKey: "first",
    requestAnimationFrame: (frame: () => void) => {
      frames.push(frame);
    },
    chat: {
      getClientRects: () => (visible ? [{}] : []),
      scrollIntoView: (options: unknown) => {
        scrolls.push(options);
      },
    },
  });
  const reveal = source.slice(
    source.indexOf("const revealComposer ="),
    source.indexOf("const citations ="),
  );
  vm.runInContext(reveal, context);
  const flush = () => {
    for (const frame of frames.splice(0)) frame();
  };
  vm.runInContext("revealComposer();", context);
  flush();
  assert.equal(scrolls.length, 1);
  assert.equal(
    JSON.stringify(scrolls[0]),
    '{"block":"end","inline":"nearest"}',
  );
  vm.runInContext('revealComposer(); selectionKey = "other";', context);
  flush();
  assert.equal(scrolls.length, 1);
  vm.runInContext(
    'selectionKey = "first"; revealComposer(); generation++;',
    context,
  );
  flush();
  assert.equal(scrolls.length, 1);
  vm.runInContext("generation = 0; revealComposer();", context);
  visible = false;
  flush();
  assert.equal(scrolls.length, 1);
});

test("policy status helper is callable from module scope during startup and mode changes", async () => {
  const source = await readFile(
    new URL("../web/workbench.js", import.meta.url),
    "utf8",
  );
  const helpers = source.slice(
    source.indexOf("function showPolicyPanel("),
    source.indexOf("async function refreshPolicy("),
  );
  const status = { textContent: "" };
  const context = vm.createContext({
    get: () => status,
    policyMode: "ungrounded",
    policyBusy: false,
    policyStatus: { configured: false, message: "Setup required." },
  });
  vm.runInContext(`${helpers}\npolicyMessage();`, context);
  assert.equal(status.textContent, "Setup required.");
  vm.runInContext(
    `policyStatus = {
    modes: { search: { indexName: "policy-index", extractionMode: "standard" } },
    message: "Ready."
  }; policyMode = "search"; policyMessage();`,
    context,
  );
  assert.equal(
    status.textContent,
    "policy-index · Search-managed CU extraction",
  );
  assert.equal(
    vm.runInContext('policyModeLabel("search")', context),
    "Azure Search retrieval",
  );
  assert.equal(
    vm.runInContext('policyModeLabel("ungrounded")', context),
    "No policy retrieval",
  );
});

test("retrieval choices are disabled placeholders until verified configuration loads", async () => {
  const html = await readFile(
    new URL("../web/workbench.html", import.meta.url),
    "utf8",
  );
  const select = html.match(
    /<select id="policy-mode" disabled>([\s\S]*?)<\/select>/,
  );
  assert.ok(select);
  assert.match(select[1], /Loading policy configuration/);
  assert.ok(!select[1].includes('value="standard"'));
  assert.ok(!select[1].includes('value="minimal"'));
});

test("policy choices survive unrelated startup failures and missing classifiers do not block saved runs", async () => {
  const source = await readFile(
    new URL("../web/workbench.js", import.meta.url),
    "utf8",
  );
  const helpers = source.slice(
    source.indexOf("function policyMessage("),
    source.indexOf("function storePolicyResults("),
  );
  const startup = source.slice(
    source.indexOf('api("session", {})'),
    source.indexOf("function showPolicyPanel("),
  );
  for (const failedRoute of ["analyzers", "cache"]) {
    const errors: Error[] = [];
    let restored = false;
    const select = {
      value: "",
      options: [] as { value: string; textContent: string }[],
      replaceChildren(...options: typeof this.options) {
        this.options = options;
      },
    };
    const context = vm.createContext({
      get: (id: string) => id === "policy-mode" ? select : { options: [] },
      element: (_tag: string, textContent: string) => ({ value: "", textContent }),
      api: async (route: string) => {
        if (route === failedRoute) throw new Error(`${route} unavailable`);
        if (route === "session") return { sessionId: "session", runId: "saved-run" };
        if (route === "policy/status") return {
          configured: true, batchRunning: false,
          modes: { ungrounded: {}, search: { indexName: "policy-index" } },
        };
        return {};
      },
      analyzers: async () => context.api("analyzers"),
      caches: async () => context.api("cache"),
      renderRun: async () => { restored = true; },
      controls: () => {},
      fail: (error: Error) => errors.push(error),
      clearTimeout: () => {},
      policyAvailabilityTimer: undefined,
      policyStatus: undefined,
      policyBusy: false,
      policyMode: "search",
      savedExtractionRun: undefined,
    });
    vm.runInContext(helpers, context);
    await vm.runInContext(startup, context);
    assert.deepEqual(select.options.map((option) => option.value), ["ungrounded", "search"]);
    assert.equal(select.value, "search");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, `${failedRoute} unavailable`);
    assert.equal(restored, failedRoute === "analyzers");
  }
});

test("policy availability refresh restores choices and explains configuration failures", async () => {
  const source = await readFile(
    new URL("../web/workbench.js", import.meta.url),
    "utf8",
  );
  const configured = {
    configured: true, batchRunning: false,
    modes: { ungrounded: {}, search: { indexName: "policy-index" } },
  };
  let response: unknown = configured;
  const select = {
    value: "",
    options: [] as { value: string; textContent: string }[],
    replaceChildren(...options: typeof this.options) {
      this.options = options;
    },
  };
  const status = { textContent: "", title: "" };
  const context = vm.createContext({
    get: (id: string) => id === "policy-mode" ? select : status,
    element: (_tag: string, textContent: string) => ({ value: "", textContent }),
    api: async () => {
      if (response instanceof Error) throw response;
      return response;
    },
    controls: () => {},
    clearTimeout: () => {},
    policyAvailabilityTimer: undefined,
    policyStatus: undefined,
    policyBusy: false,
    policyMode: "ungrounded",
  });
  vm.runInContext(
    source.slice(
      source.indexOf("function policyMessage("),
      source.indexOf("function storePolicyResults("),
    ),
    context,
  );
  await vm.runInContext("updatePolicyAvailability()", context);
  assert.deepEqual(select.options.map((option) => option.textContent), [
    "No policy retrieval", "Azure Search retrieval",
  ]);
  assert.equal(select.value, "ungrounded");
  response = { configured: false, message: "Run policy setup." };
  await vm.runInContext("updatePolicyAvailability()", context);
  assert.equal(select.options.length, 1);
  assert.match(select.options[0].textContent, /unavailable/);
  assert.equal(status.textContent, "Run policy setup.");
  response = new Error("Status request failed");
  await assert.rejects(vm.runInContext("updatePolicyAvailability()", context), /Status request failed/);
  assert.equal(vm.runInContext("policyStatus.configured", context), false);
  assert.match(status.textContent, /Could not load policy configuration: Status request failed/);
  response = configured;
  await vm.runInContext("updatePolicyAvailability()", context);
  assert.deepEqual(select.options.map((option) => option.value), ["ungrounded", "search"]);
  assert.equal(select.value, "ungrounded");
});

test("policy progress watcher is callable outside refreshPolicy after a page reload", async () => {
  const source = await readFile(
    new URL("../web/workbench.js", import.meta.url),
    "utf8",
  );
  const helpers = source.slice(
    source.indexOf("async function refreshPolicy("),
    source.indexOf("function renderPolicyTable("),
  );
  let restoredAvailability = 0;
  const context = vm.createContext({
    policyBusy: false,
    run: { id: "saved-run", items: [] },
    policyResults: new Map([["search", { status: "completed", items: [] }]]),
    controls: () => {},
    get: () => ({ textContent: "" }),
    policyModeLabel: () => "Azure Search retrieval",
    renderTable: () => {},
    updatePolicyAvailability: async () => {
      restoredAvailability++;
    },
  });
  vm.runInContext(helpers, context);
  assert.equal(vm.runInContext("typeof watchPolicy", context), "function");
  await vm.runInContext(
    'watchPolicy({runId:"saved-run",mode:"search",startedAt:new Date().toISOString()})',
    context,
  );
  assert.equal(restoredAvailability, 1);
  assert.equal(vm.runInContext("policyBusy", context), false);
});

test("policy Run requires Search but busy batches don't disable the retrieval dropdown", async () => {
  const source = await readFile(
    new URL("../web/workbench.js", import.meta.url),
    "utf8",
  );
  const nodes = new Map<
    string,
    {
      value: string;
      disabled?: boolean;
      title?: string;
      querySelectorAll?: () => never[];
    }
  >();
  const context = vm.createContext({
    get: (id: string) => {
      if (!nodes.has(id))
        nodes.set(id, { value: "available", querySelectorAll: () => [] });
      return nodes.get(id);
    },
    busy: false,
    sessionId: "session",
    catalog: {},
    run: { id: "saved-run" },
    policyMode: "ungrounded",
    policyBusy: false,
    policyStatus: { configured: true, batchRunning: false },
  });
  vm.runInContext(
    source.slice(
      source.indexOf("function controls("),
      source.indexOf("async function caches("),
    ),
    context,
  );
  vm.runInContext("controls()", context);
  assert.equal(nodes.get("policy-run")!.disabled, true);
  assert.equal(nodes.get("policy-mode")!.disabled, false);
  vm.runInContext('policyMode = "search"; controls()', context);
  assert.equal(nodes.get("policy-run")!.disabled, false);
  vm.runInContext("policyBusy = true; controls()", context);
  assert.equal(nodes.get("policy-run")!.disabled, true);
  assert.equal(nodes.get("policy-mode")!.disabled, false);
  vm.runInContext(
    "policyBusy = false; policyStatus.batchRunning = true; controls()",
    context,
  );
  assert.equal(nodes.get("policy-run")!.disabled, true);
  assert.equal(nodes.get("policy-mode")!.disabled, false);
  vm.runInContext("policyStatus = { configured: false }; controls()", context);
  assert.equal(nodes.get("policy-run")!.disabled, true);
  assert.equal(nodes.get("policy-mode")!.disabled, true);
});

test("changing retrieval mode restores the claim PDF instead of retaining a previous mode's SOP", async () => {
  const source = await readFile(
    new URL("../web/workbench.js", import.meta.url),
    "utf8",
  );
  const selection = { value: "ungrounded", onchange: async () => {} };
  const documents: string[] = [];
  let reads = 0;
  const context = vm.createContext({
    get: () => selection,
    policyMode: "search",
    selectedPacket: "packet-01",
    controls: () => {},
    showPolicyPanel: () => {},
    policyMessage: () => {},
    renderTable: () => {},
    renderPolicyOutput: () => {},
    showAgentClaim: async (id: string) => {
      documents.push(id);
    },
    refreshPolicy: async () => {
      reads++;
    },
    fail: (error: unknown) => {
      throw error;
    },
  });
  const handler = source.slice(
    source.indexOf('get("policy-mode").onchange'),
    source.indexOf('get("policy-run").onclick'),
  );
  vm.runInContext(handler, context);
  await selection.onchange();
  assert.equal(vm.runInContext("policyMode", context), "ungrounded");
  assert.deepEqual(documents, ["packet-01"]);
  assert.equal(reads, 1);
});

test("pane layout refreshes a narrow grid initially and clears desktop sizing when resized", async () => {
  const source = await readFile(
    new URL("../web/column-resize.js", import.meta.url),
    "utf8",
  );
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
    style,
    clientWidth: 480,
    offsetTop: 64,
    dispatchEvent: () => {
      refreshes++;
    },
  };
  const handle = { setAttribute: () => {} };
  const window = {
    innerWidth: 480,
    innerHeight: 800,
    addEventListener: (name: string, listener: () => void) =>
      listeners.set(name, listener),
  };
  const context = vm.createContext({
    window,
    Event,
    main,
    handle,
    getComputedStyle: () => ({ paddingLeft: "24", paddingRight: "24" }),
  });
  vm.runInContext(
    source.replace(/^export /gm, "") + "\nsplitPreview(main, handle);",
    context,
  );
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
