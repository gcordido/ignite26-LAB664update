import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { once } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import express from "express";
import { repositoryRoot } from "./config.ts";
import { loadPolicySources, policySourceFilename, policySourcePrefix, verifiedPolicySource } from "./policy-sources.ts";
import { resolveCitations } from "./policy-core.ts";
import { createApp } from "./server.ts";

const activeFolder = "data/policies/rental/ocr-comparison-v2";
const archiveFolder = "data/policies/archive/legacy-rental-review-v2";
const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

async function fixture(hiddenAncestor = false) {
  const cleanupRoot = path.join(repositoryRoot, ".tools", `policy-sources-test-${randomUUID()}`);
  const root = hiddenAncestor ? path.join(cleanupRoot, ".copilot", "checkout") : cleanupRoot;
  for (const folder of [activeFolder, archiveFolder])
    await mkdir(path.join(root, folder), { recursive: true });
  const active = { documentId: "ACTIVE", version: "1", pdf: "active.pdf",
    sha256: sha("active"), ruleIds: ["A-1"], states: ["TX"], documentType: "policy_contract" };
  const retired = { ...active, documentId: "LEGACY", version: "2.0", pdf: "legacy.pdf",
    sha256: sha("legacy"), ruleIds: ["R-1"], documentType: "state_sop" };
  const cite = (d: typeof active) => ({ documentId: d.documentId, version: d.version,
    pdf: d.pdf, sha256: d.sha256, ruleIds: d.ruleIds, sections: { "Exact section": 1 } });
  const originalManifest = JSON.stringify({ documents: [active, retired] });
  const originalCitations = JSON.stringify([cite(active), cite(retired)]);
  const registry = {
    schemaVersion: 1, archiveId: "legacy-rental-review-v2", includeInKnowledgeIndex: false,
    sourceGeneration: { manifestSha256: sha(originalManifest), citationsSha256: sha(originalCitations),
      originalManifest: "original-manifest.json", originalCitations: "original-citations.json" },
    documents: [{ ...retired, originalLogicalPath: `${activeFolder}/legacy.pdf`,
      archivePath: `${archiveFolder}/legacy.pdf`, rationale: "Unselected legacy checks.",
      source: retired, citation: cite(retired) }],
  };
  for (const [file, value] of Object.entries({
    [`${activeFolder}/manifest.json`]: JSON.stringify({ documents: [active] }),
    [`${activeFolder}/citations.json`]: JSON.stringify([cite(active)]),
    [`${activeFolder}/active.pdf`]: "active", [`${archiveFolder}/legacy.pdf`]: "legacy",
    [`${archiveFolder}/registry.json`]: JSON.stringify(registry),
    [`${archiveFolder}/original-manifest.json`]: originalManifest,
    [`${archiveFolder}/original-citations.json`]: originalCitations,
  })) await writeFile(path.join(root, file), value);
  return { root, cleanupRoot, registry, options: { repositoryRoot: root, includeArchived: true } };
}

test("active inventory has 21 sources; explicit historical resolution preserves all 42 hashes", async () => {
  const active = await loadPolicySources();
  const all = await loadPolicySources({ includeArchived: true });
  assert.equal(active.length, 21);
  assert.equal(all.length, 42);
  assert.equal(all.filter((s) => s.archived).length, 21);
  assert.ok(active.every((s) => !s.archived));
  assert.equal(active.filter((s) => s.role === "revised_declarations").length, 10);
  assert.equal(active.filter((s) => s.role === "rental_terms").length, 0);
  assert.equal(await verifiedPolicySource("tx-rental-review-sop-v2.pdf"), null);
});

test("historical citations keep original logical URLs and exact version/rule/section/page validation", async () => {
  const citation = { DocumentId: "TX-RENTAL-002", Version: "v2.0",
    File: "tx-rental-review-sop-v2.pdf", RuleId: "TX-R3",
    Section: "3. Rate, duration and charge schedules" };
  const mutations = [
    { File: "TX-rental-review-sop-v2.pdf" }, { Version: "2.1" }, { RuleId: "tx-r3" },
    { Section: "3. Rate, duration and charge Schedules" }, { DocumentId: "WA-RENTAL-002" },
    { File: "https://evil.invalid/data/policies/rental/ocr-comparison-v2/tx-rental-review-sop-v2.pdf" },
    { File: "../tx-rental-review-sop-v2.pdf" },
  ];
  const [links] = await resolveCitations({ Checks: [{ Citation: [
    citation, ...mutations.map((change) => ({ ...citation, ...change })),
  ] }] });
  assert.equal(links[0].href, `${policySourcePrefix}${citation.File}#page=3`);
  assert.ok(links.slice(1).every((link) => link.href === null));
});

test("source URLs reject traversal, arbitrary directories and foreign origins", () => {
  for (const value of ["../active.pdf", "controls/active.pdf", "%2e%2e/active.pdf",
    "/data/policies/archive/legacy-rental-review-v2/active.pdf", "C:\\active.pdf",
    "https://evil.invalid/active.pdf", "//evil.invalid/active.pdf", "active.pdf?x=1"])
    assert.equal(policySourceFilename(value), null, value);
  assert.equal(policySourceFilename(`${policySourcePrefix}active.pdf`), "active.pdf");
  assert.equal(policySourceFilename(`https://lab.invalid${policySourcePrefix}active.pdf`,
    { origin: "https://lab.invalid" }), "active.pdf");
  assert.equal(policySourceFilename("https://lab.invalid/active.pdf",
    { origin: "https://lab.invalid" }), null);
});

test("resolver rejects archive tampering, duplicate aliases and stale generation metadata", async () => {
  const f = await fixture();
  try {
    assert.equal((await loadPolicySources(f.options)).length, 2);
    await writeFile(path.join(f.root, archiveFolder, "legacy.pdf"), "tampered");
    await assert.rejects(loadPolicySources(f.options), /hash mismatch/);
    assert.equal((await loadPolicySources({ repositoryRoot: f.root })).length, 1);
    await writeFile(path.join(f.root, archiveFolder, "legacy.pdf"), "legacy");
    const registryFile = path.join(f.root, archiveFolder, "registry.json");
    f.registry.documents[0].archivePath = `${archiveFolder}/../legacy.pdf`;
    await writeFile(registryFile, JSON.stringify(f.registry));
    await assert.rejects(loadPolicySources(f.options), /alias/);
    f.registry.documents[0].archivePath = `${archiveFolder}/legacy.pdf`;
    f.registry.documents.push(f.registry.documents[0]);
    await writeFile(registryFile, JSON.stringify(f.registry));
    await assert.rejects(loadPolicySources(f.options), /duplicated/);
    f.registry.documents.pop();
    await writeFile(registryFile, JSON.stringify(f.registry));
    await writeFile(path.join(f.root, archiveFolder, "original-citations.json"), "[]");
    await assert.rejects(loadPolicySources(f.options), /metadata hash mismatch/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("active source wrong hashes and unregistered files fail closed", async () => {
  const f = await fixture();
  try {
    assert.equal(await verifiedPolicySource("unregistered.pdf", f.options), null);
    await writeFile(path.join(f.root, activeFolder, "active.pdf"), "wrong");
    await assert.rejects(loadPolicySources({ repositoryRoot: f.root }), /hash mismatch/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("PDF route serves original archived aliases, never raw archive/control/unregistered paths", async () => {
  const noCloud = async () => { throw new Error("No cloud calls permitted"); };
  const server = createApp({ detail: noCloud, analyze: noCloud }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const filename = "tx-rental-review-sop-v2.pdf";
    const response = await fetch(`${base}${policySourcePrefix}${filename}`);
    assert.equal(response.status, 200);
    const expected = await readFile(path.join(repositoryRoot, archiveFolder, filename));
    assert.equal(sha(new Uint8Array(await response.arrayBuffer())), sha(expected));
    assert.equal(response.headers.get("cache-control"), "no-store");
    for (const suffix of [
      `/data/policies/archive/legacy-rental-review-v2/${filename}`,
      `${policySourcePrefix}controls/tx-rental-review-sop-v2-text-control.pdf`,
      `${policySourcePrefix}controls/tx-rental-review-sop-v2-text-control%2epdf`,
      `${policySourcePrefix}unregistered.pdf`, `${policySourcePrefix}TX-rental-review-sop-v2.pdf`,
    ]) assert.equal((await fetch(base + suffix)).status, 404, suffix);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("hash-verified active PDFs and historical aliases load beneath a hidden checkout ancestor", async () => {
  const f = await fixture(true);
  let server: ReturnType<express.Express["listen"]> | undefined;
  try {
    const source = (await readFile(new URL("./server.ts", import.meta.url), "utf8"))
      .replace(/\r\n/g, "\n");
    const start = source.indexOf('  app.use("/data/policies",');
    const end = source.indexOf('  app.use(\n    "/data",', start);
    assert.ok(start >= 0 && end > start);
    const app = express();
    vm.runInNewContext(stripTypeScriptTypes(source.slice(start, end)), {
      app, path, policySourcePrefix,
      verifiedPolicySource: (file: string) => verifiedPolicySource(file, f.options),
    });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    for (const [filename, expected] of [["active.pdf", "active"], ["legacy.pdf", "legacy"]]) {
      const response = await fetch(`${base}${policySourcePrefix}${filename}`);
      assert.equal(response.status, 200, filename);
      assert.equal(sha(new Uint8Array(await response.arrayBuffer())), sha(expected), filename);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    for (const filename of [".hidden.pdf", "%2ehidden.pdf", "unknown.pdf", "../active.pdf",
      "controls/active.pdf", "ACTIVE.pdf"])
      assert.equal((await fetch(`${base}${policySourcePrefix}${filename}`)).status, 404, filename);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(f.cleanupRoot, { recursive: true, force: true });
  }
});
