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
  assert.equal(resources.index.name, "lab664-claim-policy-pruned-v5-1728bee05009");
  const parts = target.hash.split("/");
  assert.equal(parts[2], "Index.ReactView");
  assert.equal(decodeURIComponent(parts[4]), `${metadata.search.resourceId}#${config.indexName}`);
  assert.equal(decodeURIComponent(parts[6]), "West US");
  assert.equal(parts[8], "standard");
  assert.equal(resources.storage.href, undefined);
  assert.match(resources.storage.message, /No verified Azure container.*local corpus/);
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

test("absent, invalid, foreign-endpoint and stale-generation metadata never invent links", () => {
  for (const value of [
    undefined, null, {},
    { ...metadata, indexName: "old-policy-index" },
    { ...metadata, corpusHash: "a".repeat(64) },
    { ...metadata, indexFingerprint: "b".repeat(64) },
    { ...metadata, search: { ...metadata.search, resourceId: "https://evil.example/?token=secret" } },
    { ...metadata, search: { ...metadata.search, resourceId: metadata.search.resourceId.replace("mmi-sample-ai-search", "other-service") } },
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

test("resource rendering preserves saved-generation links and separately identifies the live index", async () => {
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
  const context = vm.createContext({
    get, URL, policyMode: "search", policyResults: results,
    policyStatus: { resources: { index: { name: "different-live-index", href: "https://portal.azure.com/" } } },
    element: (_tag: string, text: string) => Object.assign(new Node(), { textContent: text }),
  });
  vm.runInContext(source.slice(source.indexOf("function renderPolicyResources("),
    source.indexOf("async function updatePolicyAvailability(")), context);
  vm.runInContext("renderPolicyResources()", context);
  const anchor = get("policy-index-resource").children[0];
  assert.equal(anchor.textContent, config.indexName);
  assert.equal(anchor.href, savedResources.index.href);
  assert.equal(anchor.target, "_blank");
  assert.equal(anchor.rel, "noopener noreferrer");
  assert.ok(!nodes.has("policy-storage-resource"));
  assert.equal(get("policy-resource-context").hidden, false);
  assert.match(get("policy-resource-context").textContent, /Live checks use index different-live-index/);
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

test("compact dataset dialog renders three absolute folder links, opens only dataset IDs, and provides copy fallbacks", async () => {
    const source = await readFile(new URL("../web/workbench.js", import.meta.url), "utf8");
    class Node {
      children: Node[] = [];
      dataset: Record<string, string> = {};
      textContent = ""; href = ""; open = false;
      value = ""; hidden = false; focused = false; selected = false;
      attributes: Record<string, string> = {};
      onclick?: (event?: { preventDefault(): void }) => Promise<void>;
      append(...nodes: Node[]) { this.children.push(...nodes); }
      replaceChildren() { this.children = []; }
      showModal() { this.open = true; }
      close() { this.open = false; }
      setAttribute(name: string, value: string) { this.attributes[name] = value; }
      removeAttribute(name: string) { delete this.attributes[name]; }
      focus() { this.focused = true; }
      select() { this.selected = true; }
    }
    const nodes = new Map<string, Node>();
    const get = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, new Node());
      return nodes.get(id)!;
    };
    const original = ["original", "search", "digital"].map(id => ({
      id, label: `${id} dataset`, path: `C:\\Lab & demo\\${id}`,
      href: `file:///C:/Lab%20%26%20demo/${id}/`,
    }));
    let datasets = original;
    let openError = false, copyError = false;
    const copied: string[] = [];
    const calls: { route: string; body: unknown }[] = [];
    const context = vm.createContext({
      get, element: (_tag: string, text = "") => Object.assign(new Node(), { textContent: text }),
      document: { createTextNode: (text: string) => Object.assign(new Node(), { textContent: text }) },
      URL,
      navigator: { clipboard: { writeText: async (text: string) => {
        if (copyError) throw new Error("Clipboard permission denied");
        copied.push(text);
      } } },
      api: async (route: string, body: unknown) => {
        calls.push({ route, body });
        if (route === "policy/datasets") return { datasets };
        if (openError) throw new Error("Platform cannot open folders");
        return { requested: true };
      },
    });
    vm.runInContext(source.slice(source.indexOf("async function openPolicyDocuments()"),
      source.indexOf('get("policy-local-documents").onclick')), context);
    await vm.runInContext("openPolicyDocuments()", context);
    assert.deepEqual(calls, [{ route: "policy/datasets", body: undefined }]);
    const rows = get("policy-document-list-files").children;
    assert.equal(rows.length, 3);
    for (const [index, row] of rows.entries()) {
      const [label, link, copy, fallback] = row.children;
      assert.equal(label.textContent, original[index].label);
      assert.equal(link.textContent, original[index].path);
      assert.equal(link.href, original[index].href);
      let prevented = false;
      await link.onclick?.({ preventDefault: () => { prevented = true; } });
      assert.ok(prevented, "file URLs must use the protected native opener, not browser file navigation");
      assert.equal(calls.at(-1)?.route, "policy/datasets/open");
      assert.equal(JSON.stringify(calls.at(-1)?.body), JSON.stringify({ id: original[index].id }));
      await copy.onclick?.();
      assert.equal(copied.at(-1), original[index].path);
      assert.equal(fallback.hidden, true);
    }
    openError = true;
    await rows[0].children[1].onclick?.({ preventDefault() {} });
    assert.match(get("policy-document-list-status").textContent, /Could not open folder.*Copy path/);
    copyError = true;
    await rows[0].children[2].onclick?.();
    assert.ok(!rows[0].children[3].hidden && rows[0].children[3].focused && rows[0].children[3].selected);
    assert.match(get("policy-document-list-status").textContent, /Copy the selected path manually/);
    for (const invalid of [
      original.slice(0, 2), [...original, original[0]],
      original.map((item, index) => index ? item : { ...item, id: "arbitrary" }),
      original.map((item, index) => index ? item : { ...item, path: "../private" }),
      original.map((item, index) => index ? item : { ...item, href: "javascript:alert(1)" }),
    ]) {
      datasets = invalid;
      await assert.rejects(vm.runInContext("openPolicyDocuments()", context), /folders are invalid/);
      assert.equal(get("policy-document-list-files").children.length, 0);
      assert.match(get("policy-document-list-status").textContent, /unavailable/);
    }
});
