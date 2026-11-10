import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { repositoryRoot } from "./config.ts";
import { policyResourceLinks, policyResources } from "./policy-resources.ts";
import { readPolicyDemo } from "./policy-demo.ts";

const folder = path.join(repositoryRoot, "data", "policy-demo");
const config = JSON.parse(await readFile(path.join(folder, "policy-agent-framework.json"), "utf8"));
const metadata = JSON.parse(await readFile(path.join(folder, "resources.json"), "utf8"));

test("the actual current generation links to its exact Search index, not a service homepage", () => {
  const resources = policyResourceLinks(config, metadata);
  const target = new URL(resources.index.href!);
  assert.equal(target.origin, "https://portal.azure.com");
  assert.equal(resources.index.name, config.indexName);
  const parts = target.hash.split("/");
  assert.equal(parts[2], "Index.ReactView");
  assert.equal(decodeURIComponent(parts[4]), `${metadata.search.resourceId}#${config.indexName}`);
  assert.equal(decodeURIComponent(parts[6]), metadata.search.location);
  assert.equal(parts[8], metadata.search.sku);
  const localResources = policyResourceLinks(config, { ...metadata, storage: { kind: "local" } });
  assert.equal(localResources.storage.href, undefined);
  assert.match(localResources.storage.message, /No verified Azure container.*local corpus/);
  assert.equal(policyResourceLinks({ ...config, searchEndpoint: `${config.searchEndpoint}/` }, metadata).index.href,
    resources.index.href);
});

test("optional Blob metadata produces an encoded exact container view only for the same generation", () => {
  const blob = {
    ...metadata, storage: {
      kind: "blob",
      resourceId: "/subscriptions/3b393ccb-47e3-4dea-9004-0c1085b5aba6/resourceGroups/mmi-usw3-eft/providers/Microsoft.Storage/storageAccounts/mmiusw3bbstore",
      containerName: "test-policy-generation",
    },
  };
  const resources = policyResourceLinks(config, blob);
  const target = new URL(resources.storage.href!);
  assert.equal(target.origin, "https://portal.azure.com");
  assert.match(target.hash, /^#view\/Microsoft_Azure_Storage\/ContainerMenuBlade\/~\/overview\/storageAccountId\//);
  assert.equal(decodeURIComponent(target.hash.split("/")[6]), blob.storage.resourceId);
  assert.equal(target.hash.split("/").at(-1), "test-policy-generation");
  for (const containerName of ["../wrong", "with--dash", "a", "UPPER", "name?sig=secret"])
    assert.equal(policyResourceLinks(config, { ...blob, storage: { ...blob.storage, containerName } }).storage.href, undefined);
});

test("active configuration metadata takes precedence over the historical bundled generation", async () => {
  const live = {
    ...config, indexName: "new-live-index", indexFingerprint: "a".repeat(64),
    resourceProvenance: { ...metadata, indexName: "new-live-index", indexFingerprint: "a".repeat(64) },
  };
  const resources = await policyResources(live, folder);
  assert.equal(resources.index.name, live.indexName);
  assert.ok(resources.index.href);
  assert.ok(decodeURIComponent(resources.index.href).includes(`#${live.indexName}`));
  assert.equal((await policyResources({ ...live, resourceProvenance: null }, folder)).index.href, undefined);
  assert.match((await policyResources({
    ...live, resourceProvenance: metadata,
  }, folder)).index.message!, /different policy generation/);
});

test("absent, invalid, foreign-endpoint and stale-generation metadata never invent links", () => {
  for (const value of [
    undefined, null, {},
    { ...metadata, indexName: "old-policy-index" },
    { ...metadata, corpusHash: "a".repeat(64) },
    { ...metadata, indexFingerprint: "b".repeat(64) },
    { ...metadata, search: { ...metadata.search, resourceId: "https://evil.example/?token=secret" } },
    { ...metadata, search: { ...metadata.search, resourceId: metadata.search.resourceId.replace(/[^/]+$/, "other-service") } },
  ]) {
    const resources = policyResourceLinks(config, value);
    assert.equal(resources.index.href, undefined);
    assert.equal(resources.index.name, config.indexName);
    assert.equal(resources.storage.href, undefined);
    assert.ok(resources.index.message);
    assert.ok(resources.storage.message);
  }
});

test("missing and corrupt optional metadata remain explicit without breaking the offline bundle", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "policy-resources-"));
  try {
    assert.match((await policyResources(config, temporary)).index.message!, /unavailable/);
    await writeFile(path.join(temporary, "resources.json"), "{bad json");
    assert.match((await policyResources(config, temporary)).index.message!, /invalid/);
    const demo = await readPolicyDemo(folder);
    assert.equal(demo.results(demo.sourceRun).items.length, 10);
    assert.deepEqual(demo.results(demo.sourceRun).resources, demo.info.resources);
    assert.equal(demo.info.resources.index.name, config.indexName);
    assert.ok(demo.info.resources.index.href);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("resource rendering links to the live agent index even when saved reviews use another generation", async () => {
  const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
  class Node {
    textContent = ""; title = ""; href = ""; target = ""; rel = ""; hidden = false;
    children: Node[] = [];
    replaceChildren() { this.children = []; this.textContent = ""; }
    append(node: Node) { this.children.push(node); }
  }
  const nodes = new Map<string, Node>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Node());
    return nodes.get(id)!;
  };
  const savedResources = policyResourceLinks(config, metadata);
  const saved = { indexName: config.indexName, source: "bundled", resources: savedResources };
  const results = new Map<string, unknown>([["search", saved]]);
  const liveResources = policyResourceLinks(
    { ...config, indexName: "different-live-index" },
    { ...metadata, indexName: "different-live-index" },
  );
  const context = vm.createContext({
    get, URL, policyMode: "search", policyResults: results,
    policyStatus: { configured: true, resources: liveResources },
    element: (_tag: string, text: string) => Object.assign(new Node(), { textContent: text }),
  });
  vm.runInContext(source.slice(source.indexOf("function renderPolicyResources("),
    source.indexOf("async function updatePolicyAvailability(")), context);
  vm.runInContext("renderPolicyResources()", context);
  const anchor = get("policy-index-resource").children[0];
  assert.equal(anchor.textContent, "different-live-index");
  assert.equal(anchor.href, liveResources.index.href);
  assert.equal(anchor.target, "_blank");
  assert.equal(anchor.rel, "noopener noreferrer");
  assert.ok(!nodes.has("policy-storage-resource"));
  assert.equal(get("policy-resource-context").hidden, false);
  assert.match(get("policy-resource-context").textContent, /Live agent calls use the linked index/);
  assert.ok(get("policy-resource-context").textContent.includes(config.indexName));
  results.set("search", { items: [
    { status: "completed", indexName: "historical-index" },
    { status: "completed", indexName: config.indexName },
  ] });
  vm.runInContext("renderPolicyResources()", context);
  assert.equal(get("policy-index-resource").children[0].href, liveResources.index.href);
  results.clear();
  vm.runInContext("renderPolicyResources()", context);
  assert.equal(get("policy-index-resource").children[0].href, liveResources.index.href);
  assert.equal(get("policy-resource-context").hidden, true);
  vm.runInContext(`policyStatus = {
    configured: true, modes: { search: { indexName: "unverified-live-index" } }
  }`, context);
  results.set("search", saved);
  vm.runInContext("renderPolicyResources()", context);
  assert.equal(get("policy-index-resource").textContent, "unverified-live-index");
  assert.match(get("policy-index-resource").title, /unavailable/);
  vm.runInContext("policyStatus = { configured: false }", context);
  vm.runInContext("renderPolicyResources()", context);
  assert.equal(get("policy-index-resource").children[0].href, savedResources.index.href);
  assert.match(get("policy-resource-context").textContent, /live agent configuration is unavailable/);
  results.set("search", { items: [{ status: "completed", indexName: "historical-index" }] });
  vm.runInContext("renderPolicyResources()", context);
  assert.equal(get("policy-index-resource").textContent, "historical-index");
  assert.match(get("policy-index-resource").title, /unavailable/);
  results.set("search", { items: [
    { status: "completed", indexName: "historical-index" },
    { status: "completed", indexName: config.indexName },
  ] });
  vm.runInContext("renderPolicyResources()", context);
  assert.equal(get("policy-index-resource").textContent, "Multiple saved index generations");
  assert.ok(!nodes.has("policy-storage-resource"));
  results.set("search", { indexName: "current", resources: {
    index: { name: "current", href: "https://evil.example/" }, storage: { message: "Unavailable" },
  } });
  vm.runInContext("renderPolicyResources()", context);
  assert.equal(get("policy-index-resource").textContent, "current");
});

test("live policy confirmation closes Settings so operational progress remains visible", async () => {
  const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
  const calls: string[] = [];
  const summary = { textContent: "" };
  const context = vm.createContext({
    get: (id: string) => {
      if (id === "policy-run") return { disabled: false };
      if (id === "app-settings") return { close: () => calls.push("close-settings") };
      if (id === "policy-confirmation") return { showModal: () => calls.push("confirm") };
      return summary;
    },
    run: { id: "saved-parse", items: [{ rawSaved: true }] },
    policyMode: "search", pendingPolicyRun: undefined,
    policyModeLabel: () => "FoundryIQ",
  });

  vm.runInContext(source.slice(source.indexOf("function confirmPolicyRun("),
    source.indexOf('get("policy-run").onclick')), context);
  vm.runInContext("confirmPolicyRun()", context);
  assert.deepEqual(calls, ["close-settings", "confirm"]);
  assert.match(summary.textContent, /three checks per case/);
  assert.equal(vm.runInContext("pendingPolicyRun.mode", context), "search");
});

test("the policy folder link opens only the original PDFs directly and reports failures without a dialog", async () => {
    const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
    class Node {
      textContent = ""; hidden = true;
      attributes: Record<string, string> = {};
      getAttribute(name: string) { return this.attributes[name] ?? null; }
      setAttribute(name: string, value: string) { this.attributes[name] = value; }
      removeAttribute(name: string) { delete this.attributes[name]; }
    }
    const nodes = new Map<string, Node>();
    const get = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, new Node());
      return nodes.get(id)!;
    };
    let openError = false;
    let release: (() => void) | undefined;
    let pending = false;
    const calls: { route: string; body: unknown }[] = [];
    const context = vm.createContext({
      get,
      api: async (route: string, body: unknown) => {
        calls.push({ route, body });
        if (openError) throw new Error("Platform cannot open folders");
        if (pending) await new Promise<void>(resolve => { release = resolve; });
        return { requested: true };
      },
    });
    vm.runInContext(source.slice(source.indexOf("async function openPolicyDocuments()"),
      source.indexOf('get("policy-local-documents").onclick')), context);
    await vm.runInContext("openPolicyDocuments()", context);
    assert.equal(JSON.stringify(calls), JSON.stringify([
      { route: "policy/datasets/open", body: { id: "original" } },
    ]));
    assert.equal(get("policy-folder-status").hidden, false);
    assert.match(get("policy-folder-status").textContent, /folder requested in Windows Explorer/);
    assert.equal(get("policy-local-documents").getAttribute("aria-disabled"), null);
    assert.ok(!nodes.has("policy-document-list"));
    pending = true;
    const opening = vm.runInContext("openPolicyDocuments()", context);
    assert.equal(get("policy-local-documents").getAttribute("aria-disabled"), "true");
    await vm.runInContext("openPolicyDocuments()", context);
    assert.equal(calls.length, 2, "repeated clicks must not open additional Explorer windows");
    release!();
    await opening;
    pending = false;
    openError = true;
    await assert.rejects(vm.runInContext("openPolicyDocuments()", context), /Platform cannot open folders/);
    assert.match(get("policy-folder-status").textContent, /Could not open.*Platform cannot open folders/);
    assert.equal(get("policy-local-documents").getAttribute("aria-disabled"), null);
    assert.ok(!nodes.has("policy-document-list"));
});
