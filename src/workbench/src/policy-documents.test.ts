import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { test } from "node:test";
import { PolicyDocuments, representationMarkdown } from "./policy-documents.ts";
import { createApp } from "./server.ts";
import { digest } from "./policy-core.ts";

const settings = async () => ({
  endpoint: "https://example.services.ai.azure.com", apiVersion: "2026-06-01-preview", port: 8791,
});

test("CU Search does not relabel or reuse an old Layout cache", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "policy-search-docs-"));
  try {
    const bytes = Buffer.from("document bytes");
    const identity = {
      schemaVersion: 1, file: "test.pdf", sha256: digest(bytes),
      endpoint: (await settings()).endpoint, apiVersion: (await settings()).apiVersion,
      analyzer: "prebuilt-layout",
    };
    await writeFile(path.join(folder, `${digest(JSON.stringify(identity))}.json`), JSON.stringify({
      ...identity, createdAt: new Date().toISOString(), markdown: "Old Layout", response: result("Old Layout"),
    }));
    const calls: string[] = [];
    const documents = new PolicyDocuments({
      cacheFolder: folder, source: async () => bytes, settings,
      analyze: async (id) => { calls.push(id); return result("# New Search"); },
    });
    assert.equal((await documents.get("test.pdf", "search")).available, false);
    assert.deepEqual(calls, []);
    const generated = await documents.get("test.pdf", "search", true);
    assert.equal(generated.analyzer, "prebuilt-documentSearch");
    assert.ok(generated.available);
    assert.equal(generated.markdown, "# New Search");
    assert.deepEqual(calls, ["prebuilt-documentSearch"]);
    const cached = await documents.get("test.pdf", "search");
    assert.ok(cached.available && cached.cached);
    assert.equal(cached.analyzer, "prebuilt-documentSearch");
    assert.equal((await readdir(folder)).length, 2);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
const result = (markdown: string) => ({
  status: "Succeeded", result: { contents: [{ markdown }] },
});

test("representations preserve CU HTML tables and successful empty digital output; malformed/failing output is not cached", async () => {
  const markdown = '<table><tr><td rowspan="2">Band</td><td></td></tr></table>';
  assert.equal(representationMarkdown(result(markdown)), markdown);
  assert.equal(representationMarkdown(result("")), "");
  assert.throws(() => representationMarkdown({ status: "Failed", result: { contents: [] } }), /did not succeed/);
  assert.throws(() => representationMarkdown({ status: "Succeeded", result: { contents: [{}] } }), /without Markdown/);
  assert.throws(() => representationMarkdown({ status: "Succeeded" }), /no document contents/);
  assert.throws(() => representationMarkdown({ status: "Succeeded", result: { contents: [] } }), /no document contents/);
});

test("document cache is keyed by bytes, endpoint, API and analyzer; cache reads never submit Azure requests", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "policy-docs-"));
  try {
    let bytes = Buffer.from("one");
    let apiVersion = "2026-06-01-preview";
    const calls: string[] = [];
    const documents = new PolicyDocuments({
      cacheFolder: folder, source: async () => bytes,
      settings: async () => ({ ...await settings(), apiVersion }),
      analyze: async (id) => { calls.push(id); return result(id === "prebuilt-digitalParse" ? "" : "# Extracted"); },
    });
    assert.equal((await documents.get("test.pdf", "search")).available, false);
    assert.deepEqual(calls, []);
    const first = await documents.get("test.pdf", "search", true);
    assert.equal(first.available && first.markdown, "# Extracted");
    assert.equal(first.available && first.cached, false);
    const cached = await documents.get("test.pdf", "search", true);
    assert.ok(cached.available);
    assert.equal(cached.available && cached.cached, true);
    assert.equal(cached.response, undefined);
    await documents.get("test.pdf", "digital", true);
    assert.deepEqual(calls, ["prebuilt-documentSearch", "prebuilt-digitalParse"]);
    bytes = Buffer.from("changed");
    assert.equal((await documents.get("test.pdf", "search")).available, false);
    bytes = Buffer.from("one");
    apiVersion = "2025-11-01";
    assert.equal((await documents.get("test.pdf", "search")).available, false);
    const files = await readdir(folder);
    assert.equal(files.length, 2);
    const stored = JSON.parse(await readFile(path.join(folder, files[0]), "utf8"));
    assert.equal(stored.response.status, "Succeeded");
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("parallel duplicate requests share one analysis; unrelated extraction conflicts; failures remain retryable", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "policy-docs-"));
  try {
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const documents = new PolicyDocuments({
      cacheFolder: folder, source: async () => Buffer.from("test"), settings,
      analyze: async () => { calls++; entered(); await wait; return result(""); },
    });
    const first = documents.get("one.pdf", "search", true);
    await ready;
    const second = documents.get("one.pdf", "search", true);
    await assert.rejects(documents.get("two.pdf", "search", true), /Another policy document/);
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 1);
    const failed = new PolicyDocuments({
      cacheFolder: folder, source: async () => Buffer.from("failure"), settings,
      analyze: async () => { throw new Error("Azure unavailable"); },
    });
    await assert.rejects(failed.get("one.pdf", "digital", true), /Azure unavailable/);
    assert.equal((await failed.get("one.pdf", "digital")).available, false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("only exact v2 manifest PDF paths are accepted; extraction endpoint requires private session and explicit live consent", async () => {
  const documents = new PolicyDocuments();
  const files = await documents.files();
  assert.equal(files.length, 41);
  assert.ok(files.includes("policies/rental/ocr-comparison-v2/az-rental-review-sop-v2.pdf"));
  for (const file of ["../.tools/policy-checks.json", "policies/rental/tx-rental-review-sop.pdf",
    "policies/rental/../rental/ocr-comparison-v2/tx-rental-review-sop-v2.pdf",
    "policies/rental/ocr-comparison-v2/controls/tx-rental-review-sop-v2-text-control.pdf"]) {
    await assert.rejects(documents.get(file, "search"), /manifest-listed/);
  }
  const server = createApp({ detail: async () => null, analyze: async () => null }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${url}/api/policy/document?file=test.pdf&mode=search`)).status, 401);
    const session = await (await fetch(`${url}/api/session`, { method: "POST" })).json();
    const headers = { "Content-Type": "application/json", "x-labmachine-session": session.sessionId };
    assert.equal((await fetch(`${url}/api/policy/document`, {
      method: "POST", headers, body: JSON.stringify({ file: files[0], mode: "search" }),
    })).status, 400);
    assert.equal((await fetch(`${url}/api/policy/document?file=..%2Fsecret&mode=search`, { headers })).status, 404);
    assert.equal((await fetch(`${url}/api/policy/document?file=test.pdf&mode=layout`, { headers })).status, 400);
  } finally { server.close(); }
});

test("document tabs use cache-only reads, retain PDF page, ignore stale extraction and show image-only output explicitly", async () => {
  class Node {
    hidden = false;
    textContent = "";
    children: Node[] = [];
    scrollTop = 0;
    value = "3";
    tabIndex = 0;
    dataset: Record<string, string> = {};
    attributes = new Map<string, string>();
    classList = { toggle() {} };
    onclick?: () => Promise<void>;
    onkeydown?: unknown;
    append(...nodes: Node[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Node[]) { this.children = nodes; this.textContent = ""; }
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    querySelectorAll() { return this.children; }
    focus() {}
  }
  const nodes = new Map<string, Node>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Node());
    return nodes.get(id)!;
  };
  const buttons = ["pdf", "search", "digital"].map((representation) => {
    const button = new Node();
    button.dataset.representation = representation;
    return button;
  });
  get("policy-document-tabs").children = buttons;
  const calls: { route: string; body: unknown }[] = [];
  const previews: unknown[] = [];
  let cacheAvailable = true;
  let allowLiveCalls = false;
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  const source = await readFile(new URL("../web/policy-document.js", import.meta.url), "utf8");
  const context = vm.createContext({
    document: { createElement: () => new Node() },
    get, previews,
    liveCallsEnabled: () => allowLiveCalls,
    api: async (route: string, body?: unknown) => {
      calls.push({ route, body });
      if (!cacheAvailable && body === undefined) return { available: false };
      if (body !== undefined) return {
        markdown: "Generated policy text", analyzer: "prebuilt-documentSearch",
        apiVersion: "2026-06-01-preview", cached: false, createdAt: "2026-01-01",
      };
      if (route.endsWith("mode=search")) return pending;
      return { markdown: "![](figures/1.1)", analyzer: "prebuilt-digitalParse",
        apiVersion: "2026-06-01-preview", cached: true, createdAt: "2026-01-01" };
    },
    renderedMarkdown: () => ({ textContent: "" }),
    previewPdf: async (...args: unknown[]) => { previews.push(args); },
  });
  vm.runInContext(`${source.slice(source.indexOf("export function createPolicyDocument")).replace("export function", "function")}
    const controller = createPolicyDocument({api, previewPdf, get, liveCallsEnabled});`, context);
  await vm.runInContext("controller.open('/data/policies/rental/ocr-comparison-v2/tx-rental-review-sop-v2.pdf', 2)", context);
  const search = buttons[1].onclick!();
  await buttons[2].onclick!();
  finish({ markdown: "STALE", analyzer: "prebuilt-documentSearch", createdAt: "2026-01-01", cached: true });
  await search;
  assert.match(get("policy-document-content").children[0].textContent, /no readable Markdown/);
  assert.match(get("policy-document-status").textContent, /prebuilt-digitalParse/);
  assert.ok(calls.every((call) => call.body === undefined));
  assert.equal(get("pdf-controls").hidden, true);
  await buttons[0].onclick!();
  assert.deepEqual(previews.at(-1), ["/data/policies/rental/ocr-comparison-v2/tx-rental-review-sop-v2.pdf", 3]);
  cacheAvailable = false;
  await buttons[1].onclick!();
  const generationButton = get("policy-document-content").children[1];
  assert.equal(generationButton.hidden, true);
  const before = calls.length;
  await generationButton.onclick!();
  assert.equal(calls.length, before, "A hidden generation control must not submit a live request.");
  assert.match(get("policy-document-content").children[0].textContent, /Live policy-document extraction is disabled/);
  allowLiveCalls = true;
  await buttons[1].onclick!();
  assert.equal(get("policy-document-content").children[1].hidden, false);
  await get("policy-document-content").children[1].onclick!();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter((call) => call.body !== undefined))), [{
    route: "policy/document",
    body: { file: "policies/rental/ocr-comparison-v2/tx-rental-review-sop-v2.pdf", mode: "search", live: true },
  }]);
  vm.runInContext("controller.close()", context);
  assert.equal(get("policy-document-tabs").hidden, true);
  assert.equal(get("policy-document-content").hidden, true);
});
