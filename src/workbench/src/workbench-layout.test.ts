import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { fieldRegions } from "../web/result-model.js";
import { claimFieldSources, policyRuleSources } from "../web/policy-evidence-links.js";

test("Business rules validation navigation stays enabled before loading results and while busy", async () => {
  const [html, source] = await Promise.all([
    readFile(new URL("../web/workbench.html", import.meta.url), "utf8"),
    readFile(new URL("../web/workbench.js", import.meta.url), "utf8"),
  ]);
  const button = html.match(/<button\b[^>]*\bid="review-packet"[^>]*>/)?.[0];
  assert.ok(button);
  assert.doesNotMatch(button, /\bdisabled\b/);
  assert.doesNotMatch(source, /get\("review-packet"\)\.disabled\s*=/);
  assert.match(button, /data-view="policies"/);
});

test("formula evidence uses plain field/value rows without a separate highlight button", async () => {
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
  const context = vm.createContext({
    node: (tag: string, text?: string, className?: string) =>
      new Node(tag, text, className),
    documentName: (doc: typeof first) => doc.name,
    fieldLabel: (field: string) => field,
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
    0,
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
  assert.equal(table.children.length, 1);
  assert.deepEqual(
    table.children[0].children[0].children[0].children.map((cell) => cell.textContent),
    ["Document", "Field", "Value"],
  );
  second.url = "/different.pdf";
  const separate = vm.runInContext("evidenceTable(entries);", context) as Node;
  const buttons = separate.children.filter((node) => node.tag === "button");
  assert.equal(buttons.length, 0);
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

test("policy selection targets the right panel without expanding a table row", async () => {
  const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../web/workbench.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('id="agent-panel"') > html.indexOf('<aside id="preview"'));
  assert.ok(html.indexOf('id="agent-panel"') < html.indexOf("</aside>"));
  const attributes = new Map<string, string>();
  const button = {
    dataset: { agentCheck: "1" },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    closest: () => ({ classList: { add: () => {} } }),
  };
  const owner = {
    dataset: { packet: "packet-01" },
    cells: [{ rowSpan: 1 }],
    classList: { add: () => {} },
    querySelectorAll: () => [button],
  };
  const context = vm.createContext({
    expansion: { kind: "agent", packetId: "packet-01", key: "1" },
    get: () => ({ querySelector: () => ({ children: [owner] }) }),
    detailPanels: { agent: { id: "agent-panel" } },
    element: () => { throw new Error("Policy details must not insert an inline row"); },
    sizeDetails: () => { throw new Error("Right panel must not use inline sizing"); },
  });
  const mount = source.slice(source.indexOf("function mountDetails("),
    source.indexOf("async function showPolicyDetails("));
  vm.runInContext(`${mount}\nmountDetails(5);`, context);
  assert.equal(owner.cells[0].rowSpan, 1);
  assert.equal(attributes.get("aria-controls"), "agent-panel");
  assert.equal(attributes.get("aria-expanded"), "true");
});

test("policy details lead with a short finding, field comparisons and verified sources", async () => {
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
    Headline: "Daily price needs supervisor approval",
    Comparisons: [{
      ClaimField: "RentalDailyBaseRate", ClaimLabel: "Daily rental price", ClaimValue: "$61/day",
      PolicyField: "WA-R2", PolicyLabel: "Routine approval limit", PolicyValue: "$60/day",
    }],
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
    policyShortNames: ["Daily cost", "Rental dates"],
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
    addClaimComparisonSources: () => {},
    addPolicyComparisonSources: () => {},
    openPolicySource: async (value: unknown) => {
      opened = value;
    },
    fail: (error: unknown) => {
      throw error;
    },
  });
  const renderer = source.slice(
    source.indexOf("function renderPolicyOutput("),
    source.indexOf("function comparisonLink("),
  );
  vm.runInContext(`${renderer}\nrenderPolicyOutput();`, context);
  const section = panel.children.find((node) => node.tag === "section")!;
  assert.equal(title.textContent, "Daily cost");
  assert.equal(
    panel.children.filter((node) => node.tag === "section").length,
    1,
  );
  assert.equal(section.children[0].textContent, "Review required");
  assert.match(section.children[0].className, /policy-review/);
  assert.equal(section.children[1].textContent, check.Headline);
  assert.equal(section.children[2].tag, "table");
  const rows = section.children[2].children.find((node) => node.tag === "tbody")!.children;
  assert.equal(rows[0].children[1].children[1].textContent, "RentalDailyBaseRate");
  assert.equal(rows[0].children[2].children[0].textContent, "$61/day");
  assert.equal(rows[1].children[1].children[1].textContent, "WA-R2");
  assert.equal(rows[1].children[2].children[0].textContent, "$60/day");
  const explanation = section.children.find((node) => node.tag === "details")!;
  const values = explanation.children[1];
  assert.equal(values.tag, "dl");
  assert.deepEqual(
    values.children.map((node) => node.tag),
    ["dt", "dd", "dt", "dd"],
  );
  assert.deepEqual(
    values.children
      .filter((node) => node.tag === "dt")
      .map((node) => node.textContent),
    ["Claim evidence", "Policy requirement"],
  );
  assert.deepEqual(
    values.children
      .filter((node) => node.tag === "dd")
      .map((node) => [node.children[0].tag, node.children[0].textContent]),
    [
      ["strong", check.ActualValue],
      ["strong", check.ExpectedValue],
    ],
  );
  assert.equal(section.children[3].textContent, check.Reason);
  const link = section.children.find((node) => node.tag === "a")!;
  assert.equal(link.href, citation.href);
  assert.equal(link.textContent, "State processing rules · page 2 · WA-R2");
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
  assert.equal(notApplicable.children[0].textContent, "N/A · Not applicable");
  assert.match(notApplicable.children[0].className, /policy-na/);
  assert.ok(!notApplicable.children[0].className.includes("policy-satisfied"));
  check.Outcome = "InProgress";
  vm.runInContext("renderPolicyOutput();", context);
  const waiting = panel.children.find((node) => node.tag === "section")!;
  assert.equal(waiting.children[0].textContent, "Waiting for info");
  assert.match(waiting.children[0].className, /policy-waiting/);
  assert.match(waiting.children[1].textContent, /Review complete\. Waiting for claim information or approval/);
  assert.ok(!waiting.children[0].className.includes("policy-satisfied"));
  vm.runInContext("renderPolicyOutput(1);", context);
  assert.equal(title.textContent, "Rental dates");
  assert.equal(
    panel.children.filter((node) => node.tag === "section").length,
    1,
  );
  vm.runInContext(
    "for (const check of policyResults.get(policyMode).items[0].result.Checks) { delete check.Headline; delete check.Comparisons; }",
    context,
  );
  vm.runInContext("renderPolicyOutput();", context);
  const legacy = panel.children.find((node) => node.tag === "section")!;
  assert.match(legacy.children[1].textContent, /Saved review uses the earlier format/);
  assert.ok(legacy.children.some((node) => node.tag === "details"));
  assert.ok(!legacy.children.some((node) => node.tag === "table"));
});

test("policy status icons distinguish completion, review and missing information without implying live work", async () => {
  const css = await readFile(new URL("../web/workbench.css", import.meta.url), "utf8");
  assert.match(css, /\.policy-satisfied::before\s*\{\s*content: "\\2713" \/ "";/);
  assert.match(css, /\.policy-review::before\s*\{\s*content: "\\25cb" \/ "";/);
  assert.match(css, /\.policy-waiting::before\s*\{\s*content: "\\21bb" \/ "";/);
  assert.doesNotMatch(css, /\.policy-waiting(?:::before)?\s*\{[^}]*animation:/);
  assert.match(css, /#packet-table\.policy-grid > tbody > tr > td:not\(:first-child\)\s*\{[^}]*padding: 0;/);
  assert.match(css, /\.cell-content\[data-agent-check\] > \.policy-state\s*\{[^}]*width: 100%;[^}]*height: 100%;[^}]*border-radius: 0;/);
});

test("policy status fill and click target follow the cell height instead of a fixed button height", async () => {
  const css = await readFile(new URL("../web/workbench.css", import.meta.url), "utf8");
  const cell = css.match(/#packet-table\.policy-grid > tbody > tr > td:not\(:first-child\)\s*\{([^}]*)\}/)?.[1];
  const button = css.match(/#packet-table\.policy-grid \.cell-content\[data-agent-check\]\s*\{([^}]*)\}/)?.[1];
  const state = css.match(/#packet-table\.policy-grid \.cell-content\[data-agent-check\] > \.policy-state\s*\{([^}]*)\}/)?.[1];
  assert.ok(cell && button && state);
  assert.match(cell, /position: relative;/);
  assert.match(cell, /padding: 0;/);
  assert.match(button, /position: absolute;/);
  assert.match(button, /inset: 0;/);
  assert.match(button, /height: 100%;/);
  assert.match(button, /line-height: normal;/);
  assert.doesNotMatch(button, /(?:height|line-height): \d+px;/);
  assert.match(state, /width: 100%;/);
  assert.match(state, /height: 100%;/);
  assert.match(css, /\.cell-content\[data-agent-check\]:focus-visible\s*\{\s*outline-offset: -2px;/);
});

test("policy citations replace right-panel details and Back restores the check and focus", async () => {
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
      dataset: { ready: string };
      setAttribute: () => void;
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
    "policy-review-pane",
    "policy-review-empty",
    "agent-panel",
    "preview",
    "pane-splitter",
    "pdf-stage",
  ])
    nodes.set(id, {
      hidden: false,
      scrollTop: id === "policy-review-pane" ? 120 : 0,
      textContent: "",
      dataset: { ready: "true" },
      setAttribute: () => {},
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
    expansion: { kind: "agent", view: "policy" },
    view: "policy",
    selectedPacket: "packet-02",
    fail: (error: unknown) => {
      throw error;
    },
  });
  const helpers = source.slice(
    source.indexOf("function showPolicyPanel("),
    source.indexOf("function policyMessage("),
  );
  const navigation = source.slice(
    source.indexOf("function beginPolicySource("),
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
  assert.equal(nodes.get("policy-review-pane")!.hidden, true);
  assert.equal(nodes.get("policy-source-toolbar")!.hidden, false);
  assert.equal(focused, "policy-source-back");
  nodes.get("policy-review-pane")!.scrollTop = 0;
  nodes.get("policy-source-back")!.onclick!();
  assert.equal(nodes.get("policy-output")!.hidden, false);
  assert.equal(nodes.get("policy-review-pane")!.scrollTop, 120);
  assert.equal(nodes.get("policy-review-pane")!.hidden, false);
  assert.equal(nodes.get("pdf-scroll")!.hidden, true);
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
  nodes.get("policy-review-pane")!.scrollTop = 80;
  await vm.runInContext("openPolicySource(citation, link)", context);
  assert.equal(nodes.get("policy-chat")!.hidden, false);
  assert.equal(
    nodes.get("policy-source-back")!.textContent,
    "Back to policy check",
  );
  nodes.get("policy-review-pane")!.scrollTop = 0;
  nodes.get("policy-source-back")!.onclick!();
  assert.equal(nodes.get("policy-chat")!.hidden, false);
  assert.equal(nodes.get("policy-output")!.hidden, true);
  assert.equal(nodes.get("policy-review-pane")!.scrollTop, 80);
  const region = { page: 5, polygon: [0.1, 0.1, 0.2, 0.1, 0.2, 0.2, 0.1, 0.2] };
  await vm.runInContext(
    `openClaimSource({href:"/data/packets/packet-02.pdf",page:5,regions:[${JSON.stringify(region)}]}, "LossDate", link)`,
    context,
  );
  assert.equal(JSON.stringify(preview),
    JSON.stringify(["/data/packets/packet-02.pdf", 5, [region]]));
  assert.equal(nodes.get("policy-review-pane")!.hidden, true);
  assert.match(nodes.get("policy-source-title")!.textContent, /LossDate.*page 5/);
  nodes.get("policy-source-back")!.onclick!();
  assert.equal(nodes.get("policy-review-pane")!.hidden, false);
  assert.equal(focused, "citation");
  await assert.rejects(vm.runInContext(
    'openClaimSource({href:"/data/packets/packet-01.pdf",page:5}, "LossDate", link)', context,
  ), /selected packet/);
});

test("comparison source matching uses CU paths and exact cited rules, not labels or guesses", () => {
  const region = { page: 4, polygon: [0, 0, 1, 0, 1, 1, 0, 1] };
  const fields = [
    { field: "LossDate", value: "06/12/2026", status: "present", category: "claim_summary", regions: [region] },
    { field: "RentalUsed", value: false, status: "present", category: "claim_summary", regions: [region] },
    { field: "RentalTaxes", value: 0, status: "present", category: "claim_summary", regions: [region] },
    { field: "ActualRepairCompletion", value: null, status: "missing", category: "claim_summary", regions: [region] },
    { field: "Rental.Total", value: 200, status: "present", category: "claim_summary", regions: [] },
    { field: "Rental.DailyRates[0].BaseRate", value: 50, status: "present", category: "claim_summary", regions: [region] },
    { field: "LossDateTime", value: "unrelated", status: "present", category: "statement", regions: [region] },
  ];
  assert.equal(claimFieldSources(fields, "LossDate").length, 1);
  assert.equal(claimFieldSources(fields, "claim_summary.LossDate").length, 1);
  assert.equal(claimFieldSources(fields, "Accident date").length, 0);
  assert.equal(claimFieldSources(fields, "RentalUsed")[0].value, false);
  assert.equal(claimFieldSources(fields, "RentalTaxes")[0].value, 0);
  assert.equal(claimFieldSources(fields, "ActualRepairCompletion").length, 0);
  assert.equal(claimFieldSources(fields, "Rental.Total").length, 0);
  assert.equal(claimFieldSources(fields, "Rental.DailyRates").length, 1);
  const citation = { RuleId: "POLICY-TERM", href: "/data/policies/rental/ocr-comparison-v2/effective-date-co-packet-04.pdf#page=1" };
  assert.deepEqual(policyRuleSources([citation], "POLICY-TERM"), [citation]);
  assert.equal(policyRuleSources([citation], "Not retrieved").length, 0);
  assert.equal(policyRuleSources([{ ...citation, href: "https://example.com/claim.pdf" }], "POLICY-TERM").length, 0);
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
    "policy-review-pane",
    "policy-result-mode",
    "policy-chat-mode",
    "policy-output",
  ]) {
    const node = {
      scrollTop: id === "policy-review-pane" ? 180 : 0,
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
      nodes.get("policy-review-pane")!.scrollTop = 0;
    },
  });
  const handlers = source.slice(
    source.indexOf("function selectPolicyPane("),
    source.indexOf('get("policy-mode").onchange'),
  );
  vm.runInContext(handlers, context);
  nodes.get("policy-chat-mode")!.onclick!();
  assert.equal(vm.runInContext("policyPaneMode", context), "chat");
  assert.equal(nodes.get("policy-chat-mode")!.pressed, "true");
  nodes.get("policy-result-mode")!.onclick!();
  assert.equal(nodes.get("policy-review-pane")!.scrollTop, 180);
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
    policyResults: new Map(),
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
  vm.runInContext(`policyStatus.bundledDemo = { indexName: "original-demo-index" };
    policyResults.set("search", { source: "bundled", indexName: "original-demo-index" });
    policyMessage();`, context);
  assert.equal(status.textContent,
    "Saved policy results · original-demo-index · CU Layout");
  vm.runInContext(`policyResults.set("search", {
    source: "bundled", indexName: "original-demo-index", staleDataset: true
  }); policyMessage();`, context);
  assert.match(status.textContent, /Stale policy results from a different extraction dataset/);
  vm.runInContext(`policyStatus = { configured: false, message: "Status request failed." };
    policyMessage();`, context);
  assert.match(status.textContent, /Stale policy results from a different extraction dataset/);
  assert.equal(
    vm.runInContext('policyModeLabel("search")', context),
    "FoundryIQ",
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

test("startup loads both saved result sets without listing live analyzers", async () => {
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
  for (const resumed of [false, true]) {
    const errors: Error[] = [];
    let restored = false;
    const calls: string[] = [];
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
        calls.push(route);
        if (route === "session") return {
          sessionId: "session", ...(resumed ? { runId: "saved-run" } : {}),
        };
        if (route === "policy/status") return {
          configured: true, batchRunning: false,
          modes: { ungrounded: {}, search: { indexName: "policy-index" } },
        };
        return {};
      },
      analyzers: async () => { throw new Error("Startup must not list live analyzers."); },
      caches: async () => context.api("cache"),
      loadSavedResults: async () => {
        calls.push("load-extraction", "load-policy");
        restored = true;
      },
      loadPolicyCache: async () => { calls.push("load-policy"); },
      renderRun: async () => { restored = true; },
      controls: () => {},
      fail: (error: Error) => errors.push(error),
      clearTimeout: () => {},
      policyAvailabilityTimer: undefined,
      policyStatus: undefined,
      policyResults: new Map(),
      policyBusy: false,
      policyMode: "search",
      savedExtractionRun: undefined,
    });
    vm.runInContext(helpers, context);
    await vm.runInContext(startup, context);
    assert.deepEqual(select.options.map((option) => option.value), ["ungrounded", "search"]);
    assert.equal(select.value, "search");
    assert.deepEqual(errors, []);
    assert.equal(restored, true);
    assert.ok(calls.includes("load-policy"));
    assert.equal(calls.includes("load-extraction"), !resumed);
    assert.equal(calls.includes("analyzers"), false);
    assert.equal(calls.includes("batch"), false);
    assert.equal(calls.includes("policy/batch"), false);
  }
});

test("cache reload controls are present only inside app settings", async () => {
  const html = await readFile(new URL("../web/workbench.html", import.meta.url), "utf8");
  const settings = html.match(/<dialog id="app-settings"[\s\S]*?<\/dialog>/);
  assert.ok(settings);
  for (const id of ["load-cache", "load-policy-cache"]) {
    const selector = new RegExp(`id="${id}"`);
    assert.match(settings[0], selector);
    assert.doesNotMatch(html.replace(settings[0], ""), selector);
  }
});

test("cache reload failures remain visible inside the open settings dialog", async () => {
  const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
  const nodes = new Map<string, { hidden: boolean; open?: boolean; textContent: string }>([
    ["app-settings", { open: true, hidden: false, textContent: "" }],
    ["settings-error", { hidden: true, textContent: "" }],
    ["error", { hidden: true, textContent: "" }],
  ]);
  const context = vm.createContext({ get: (id: string) => nodes.get(id) });
  vm.runInContext(source.slice(
    source.indexOf("function fail("), source.indexOf("function element("),
  ), context);
  vm.runInContext('fail(new Error("The selected cache has a checksum mismatch."))', context);
  assert.equal(nodes.get("settings-error")!.hidden, false);
  assert.equal(nodes.get("settings-error")!.textContent, "The selected cache has a checksum mismatch.");
  assert.equal(nodes.get("error")!.hidden, false);
});

test("settings show loaded cache paths and list analyzers only after live-call opt-in", async () => {
  const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
  const nodes = new Map<string, {
    value: string; checked: boolean; hidden: boolean; textContent: string;
    onclick?: () => Promise<void>; onchange?: () => Promise<void>;
    showModal: () => void; close: () => void;
  }>();
  let opened = 0;
  let analyzerLists = 0;
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", checked: false, hidden: true, textContent: "",
      showModal: () => { opened++; }, close: () => {},
    });
    return nodes.get(id)!;
  };
  const folders = { root: "C:\\LabCache", extraction: "C:\\LabCache\\results", policy: "C:\\LabCache\\policy-demo" };
  const context = vm.createContext({
    get, liveCallsEnabled: false, policyMode: "search",
    policyResults: new Map([["search", { cacheFolder: "C:\\CurrentLab\\policy-cache" }]]),
    api: async (route: string) => { assert.equal(route, "status"); return { cache: folders }; },
    controls: () => {}, fail: (error: unknown) => { throw error; },
    analyzers: async () => { analyzerLists++; },
  });
  vm.runInContext(source.slice(
    source.indexOf('get("open-settings").onclick'),
    source.indexOf('get("analyzer").onchange'),
  ), context);
  await get("open-settings").onclick!();
  assert.equal(opened, 1);
  assert.equal(get("enable-live-calls").checked, false);
  assert.equal(get("cache-folder").value, folders.root);
  assert.equal(get("extraction-cache-folder").value, folders.extraction);
  assert.equal(get("policy-cache-folder").value, "C:\\CurrentLab\\policy-cache");
  assert.equal(analyzerLists, 0);
  get("enable-live-calls").checked = true;
  await get("enable-live-calls").onchange!();
  assert.equal(vm.runInContext("liveCallsEnabled", context), true);
  assert.equal(analyzerLists, 1);
  get("enable-live-calls").checked = false;
  await get("enable-live-calls").onchange!();
  assert.equal(vm.runInContext("liveCallsEnabled", context), false);
  assert.equal(analyzerLists, 1);
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
    policyResults: new Map(),
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
    "No policy retrieval", "FoundryIQ",
  ]);
  assert.equal(select.value, "ungrounded");
  response = { configured: false, message: "Run policy setup." };
  await vm.runInContext("updatePolicyAvailability()", context);
  assert.equal(select.options.length, 1);
  assert.match(select.options[0].textContent, /unavailable/);
  assert.equal(status.textContent, "Run policy setup.");
  response = { configured: false, bundledDemo: { indexName: "original-demo-index" } };
  await vm.runInContext("updatePolicyAvailability()", context);
  assert.deepEqual(select.options.map((option) => option.value), ["search"]);
  assert.match(status.textContent, /Saved policy reviews are available/);
  response = new Error("Status request failed");
  await assert.rejects(vm.runInContext("updatePolicyAvailability()", context), /Status request failed/);
  assert.equal(vm.runInContext("policyStatus.configured", context), false);
  assert.match(status.textContent, /Could not load policy configuration: Status request failed/);
  response = configured;
  await vm.runInContext("updatePolicyAvailability()", context);
  assert.deepEqual(select.options.map((option) => option.value), ["ungrounded", "search"]);
  assert.equal(select.value, "search");
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
    policyCaches: async () => {},
    policyBusy: false,
    policyMode: "search",
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

test("policy run banner shows the active packet independently of selection and clears when finished", async () => {
  const [source, html] = await Promise.all([
    readFile(new URL("../web/workbench.js", import.meta.url), "utf8"),
    readFile(new URL("../web/workbench.html", import.meta.url), "utf8"),
  ]);
  const spinner = { hidden: false };
  const nodes = new Map<string, {
    hidden: boolean; textContent: string; querySelector: () => typeof spinner;
  }>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: false, textContent: "", querySelector: () => spinner,
    });
    return nodes.get(id)!;
  };
  const job = {
    status: "running",
    startedAt: new Date(Date.now() - 125_000).toISOString(),
    items: [
      { id: "packet-01", status: "completed" },
      { id: "packet-02", status: "reviewing" },
      { id: "packet-03", status: "pending" },
    ],
  };
  const errors = new Map<string, string>();
  const context = vm.createContext({
    get, policyMode: "search", selectedPacket: "packet-01",
    policyResults: new Map([["search", job]]),
    policyProgressErrors: errors,
    results: new Map([["packet-02", { name: "Victor Bennett" }]]),
    customerName: (result?: { name: string }) => result?.name ?? "",
    policyModeLabel: () => "FoundryIQ",
  });
  vm.runInContext(source.slice(
    source.indexOf("function renderPolicyRunStatus("),
    source.indexOf("function updatePolicyActivity("),
  ), context);
  const render = () => vm.runInContext("renderPolicyRunStatus()", context);
  render();
  assert.equal(get("policy-run-status").hidden, false);
  assert.equal(get("policy-status").hidden, true);
  assert.equal(get("policy-run-label").textContent, "Agent running");
  assert.equal(get("policy-run-packet").textContent, "packet-02 · Victor Bennett");
  assert.match(get("policy-run-detail").textContent, /1\/3 packets finished/);
  assert.equal(get("policy-run-elapsed").textContent, "2:05");
  job.items[1].status = "extracting";
  render();
  assert.equal(get("policy-run-label").textContent, "Preparing claim evidence");
  errors.set("search", "Disconnected");
  render();
  assert.equal(get("policy-run-label").textContent, "Progress connection interrupted");
  assert.equal(spinner.hidden, true);
  job.status = "completed";
  render();
  assert.equal(get("policy-run-status").hidden, true);
  assert.equal(get("policy-status").hidden, false);
  assert.doesNotMatch(html, />Synthetic data<\/span>|>Combined preview<\/span>/);
  assert.match(html, /class="policy-run-clock" role="timer" aria-live="off"/);
});

test("policy Run requires Search and only this session's busy work disables the retrieval dropdown", async () => {
  const source = await readFile(
    new URL("../web/workbench.js", import.meta.url),
    "utf8",
  );
  const nodes = new Map<
    string,
    {
      value: string;
      disabled?: boolean;
      hidden?: boolean;
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
    liveCallsEnabled: true,
    document: { querySelectorAll: () => [context.get("analyze"), context.get("policy-run")] },
    sessionId: "session",
    catalog: {},
    run: { id: "saved-run" },
    policyMode: "ungrounded",
    policyBusy: false,
    policyStatus: { configured: true, batchRunning: false },
    policyResults: new Map(),
    selectedPacket: "packet-01",
    savedExtractionRun: undefined,
    savedPolicyEntries: [],
    policyCacheBusy: false,
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
  assert.equal(nodes.get("policy-mode")!.disabled, true);
  vm.runInContext(
    "policyBusy = false; policyStatus.batchRunning = true; controls()",
    context,
  );
  assert.equal(nodes.get("policy-run")!.disabled, true);
  assert.equal(nodes.get("policy-mode")!.disabled, false);
  vm.runInContext("policyStatus = { configured: false }; controls()", context);
  assert.equal(nodes.get("policy-run")!.disabled, true);
  assert.equal(nodes.get("policy-mode")!.disabled, true);
  vm.runInContext(`policyStatus.bundledDemo = { indexName: "original-demo-index" };
    savedPolicyEntries = [{ mode: "search", source: "bundled" }]; controls()`, context);
  assert.equal(nodes.get("policy-mode")!.disabled, false);
  assert.equal(nodes.get("load-policy-cache")!.disabled, false);
  assert.equal(nodes.get("policy-run")!.disabled, true);
  vm.runInContext(`policyResults.set("search", {
    source: "bundled", items: [{ id: "packet-01", status: "completed" }]
  }); controls()`, context);
  assert.equal(nodes.get("policy-chat-mode")!.disabled, true);
  assert.match(nodes.get("policy-chat-mode")!.title!, /prepared policy-agent connection/);
  vm.runInContext("policyStatus.configured = true; liveCallsEnabled = false; controls()", context);
  assert.equal(nodes.get("policy-chat-mode")!.disabled, false);
  assert.equal(nodes.get("policy-run")!.disabled, true);
  assert.equal(nodes.get("policy-run")!.hidden, true);
  assert.equal(nodes.get("analyze")!.hidden, true);
  vm.runInContext('policyResults.get("search").staleDataset = true; controls()', context);
  assert.equal(nodes.get("policy-chat-mode")!.disabled, true);
  assert.match(nodes.get("policy-chat-mode")!.title!, /match this extraction run/);
  vm.runInContext(`run = undefined; savedPolicyEntries = [];
    policyStatus.bundledDemo.runId = "included-run";
    savedExtractionRun = { id: "included-run" }; controls()`, context);
  assert.equal(nodes.get("load-policy-cache")!.disabled, false);
  assert.equal(nodes.get("policy-run")!.disabled, true);
  vm.runInContext(`busy = true; controls()`, context);
  assert.equal(nodes.get("load-policy-cache")!.disabled, true);
  vm.runInContext(`busy = false; policyMode = "ungrounded"; controls()`, context);
  assert.equal(nodes.get("load-policy-cache")!.disabled, true);
  vm.runInContext(`policyMode = "search"; savedExtractionRun.id = "different-run"; controls()`, context);
  assert.equal(nodes.get("load-policy-cache")!.disabled, true);
});

test("first-run policy navigation exposes the cache toolbar without loading or running analysis", async () => {
  const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
  const nodes = new Map<string, { hidden: boolean; textContent: string; querySelectorAll: () => never[]; closest: () => unknown }>();
  const get = (id: string) => {
    if (!nodes.has(id)) {
      const node = { hidden: true, textContent: "", querySelectorAll: () => [], closest: (): unknown => node };
      nodes.set(id, node);
    }
    return nodes.get(id)!;
  };
  let availabilityReads = 0;
  const context = vm.createContext({
    get, clearTimeout, clickTimer: undefined, selectionVersion: 0,
    view: "classification", lastExtractionView: "classification", allFields: false,
    run: undefined, showPolicyPanel: () => {},
    policyCaches: async () => { availabilityReads++; },
    fail: (error: unknown) => { throw error; },
  });
  vm.runInContext(source.slice(
    source.indexOf("function renderWorkflowNavigation("),
    source.indexOf('for (const button of document.querySelectorAll("[data-view]"))'),
  ), context);
  vm.runInContext('activateView("policy")', context);
  assert.equal(get("batch").hidden, false);
  assert.equal(get("policy-toolbar").hidden, false);
  assert.equal(get("extraction-toolbar").hidden, true);
  assert.equal(get("show-confidence").hidden, true);
  assert.equal(availabilityReads, 1);
  assert.equal(vm.runInContext("run", context), undefined);
  vm.runInContext('activateView("classification")', context);
  assert.equal(get("batch").hidden, true);
  assert.equal(get("policy-toolbar").hidden, true);
  assert.equal(get("extraction-toolbar").hidden, false);
});

test("first-run policy cache loading opens CU results before selecting bundled or preferred live reviews", async (t) => {
  const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
  for (const bundled of [true, false]) await t.test(bundled ? "bundled demo" : "compatible live cache", async () => {
    const nodes = new Map<string, { disabled: boolean; hidden: boolean; value: string; textContent: string }>();
    const get = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { disabled: false, hidden: true, value: "search", textContent: "" });
      return nodes.get(id)!;
    };
    const calls: Array<{ route: string; body?: Record<string, unknown> }> = [];
    const loaded = {
      id: "included-run", runId: "included-run",
      ...(bundled ? { source: "bundled" } : {}),
      items: Array.from({ length: 10 }, (_, index) => ({ id: `packet-${index}`, status: "completed" })),
    };
    let context: vm.Context;
    context = vm.createContext({
      get, run: undefined, policyMode: "search", busy: false,
      savedExtractionRun: { id: "included-run" }, savedPolicyEntries: [],
      policyResults: new Map(), policyChat: { reset: () => {} },
      controls: () => {}, renderTable: () => {}, renderPolicyOutput: () => {},
      policyMessage: () => {}, selectPolicyPane: () => {},
      fail: (error: unknown) => { throw error; },
      api: async (route: string, body?: Record<string, unknown>) => {
        calls.push({ route, body });
        assert.equal(vm.runInContext("busy", context), true);
        return route === "policy/cache/load" ? loaded : { id: "included-run" };
      },
      renderRun: async (value: { id: string }) => {
        context.run = value;
        context.savedPolicyEntries = [{ mode: "search", ...(bundled ? { source: "bundled" } : {}) }];
      },
    });
    vm.runInContext(source.slice(
      source.indexOf("async function loadPolicyCache("),
      source.indexOf("function confirmPolicyRun("),
    ), context);
    await vm.runInContext('get("load-policy-cache").onclick()', context);
    assert.deepEqual(calls.map(({ route }) => route),
      bundled ? ["cache/load", "policy/cache/load", "cache/current"] : ["cache/load", "policy/cache/load"]);
    assert.equal(calls[0].body?.runId, "included-run");
    assert.equal(calls[1].body?.runId, "included-run");
    assert.equal(calls[1].body?.source, bundled ? "bundled" : undefined);
    assert.match(get("policy-cache-status").textContent, /Loaded saved policy checks for 10\/10/);
    assert.equal(context.busy, false);
  });
});

test("first-run retrieval changes do not try to render an unloaded CU run", async () => {
  const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
  const selector = { value: "ungrounded", onchange: async () => {} };
  let availabilityReads = 0;
  const context = vm.createContext({
    get: () => selector, run: undefined, policyMode: "search",
    controls: () => {}, showPolicyPanel: () => {}, policyMessage: () => {},
    renderTable: () => { throw new Error("No CU run is loaded."); },
    renderPolicyOutput: () => { throw new Error("No policy run is loaded."); },
    refreshPolicy: async () => {},
    policyCaches: async () => { availabilityReads++; },
    fail: (error: unknown) => { throw error; },
  });
  vm.runInContext(source.slice(
    source.indexOf('get("policy-mode").onchange'),
    source.indexOf('get("load-policy-cache").onclick'),
  ), context);
  await selector.onchange();
  assert.equal(vm.runInContext("policyMode", context), "ungrounded");
  assert.equal(availabilityReads, 1);
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
    policyCaches: async () => {},
    policyMode: "search",
    run: {},
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

test("pane layout keeps the split view at tablet width and stacks only on small screens", async () => {
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
  window.innerWidth = 900;
  main.clientWidth = 900;
  listeners.get("resize")!();
  assert.equal(refreshes, 3);
  assert.equal(style.height, "736px");
  assert.ok(properties.has("--left-pane"));
  window.innerWidth = 700;
  main.clientWidth = 700;
  listeners.get("resize")!();
  assert.equal(refreshes, 4);
  assert.equal(style.height, "");
  assert.equal(properties.has("--left-pane"), false);
});
