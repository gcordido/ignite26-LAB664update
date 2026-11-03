import assert from "node:assert/strict";
import { cp, mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Cache } from "./batch.ts";
import { repositoryRoot } from "./config.ts";
import { canonical, digest } from "./policy-core.ts";
import {
  frameworkConfigSchema, loadPolicyCache, PolicyService, savePolicyCache,
} from "./policy-service.ts";
import { policyDemoManifestSchema as manifestSchema, readPolicyDemo } from "./policy-demo.ts";

const bundle = path.join(repositoryRoot, "data", "policy-demo");
const cacheFolder = path.join(repositoryRoot, ".tools", "policy-cache");
const configFile = path.join(repositoryRoot, ".tools", "policy-agent-framework.json");
const action = process.argv[2];
if (action !== "export" && action !== "restore")
  throw new Error("Specify export or restore. Neither operation calls Azure.");

const cache = new Cache();
if (action === "export") {
  const runId = z.string().uuid().parse(process.argv[3]);
  const run = await cache.load(runId);
  const config = frameworkConfigSchema.parse(await loadPolicyCache(configFile));
  const service = new PolicyService({ configPath: configFile });
  const items = await service.snapshot(run, "search", (id) => cache.raw(run.id, id));
  assert.equal(items.length, 10, "The demo requires ten packets.");
  assert.ok(items.every((item) => item.status === "completed" && !item.historical),
    "Refresh all ten reviews with the current prompts before exporting.");
  const files = new Map<string, unknown>([["policy-agent-framework.json", config]]);
  for (const packet of run.source) {
    const claimKey = digest(JSON.stringify({
      pdf: packet.sha256, endpoint: config.cuEndpoint, apiVersion: config.cuApiVersion,
      analyzer: config.claimAnalyzerId, definition: config.claimAnalyzerHash, schema: 1,
    }));
    const savedKey = digest(canonical({
      config, runId: run.id, analyzer: run.analyzer.fingerprint, mode: "search", packetId: packet.id,
    }));
    const claimName = `claim-${claimKey}.json`;
    const savedName = `framework-saved-${savedKey}.json`;
    const claim = await loadPolicyCache(path.join(cacheFolder, claimName));
    const saved = z.object({ reviewKey: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough()
      .parse(await loadPolicyCache(path.join(cacheFolder, savedName)));
    const reviewName = `framework-review-${saved.reviewKey}.json`;
    const review = await loadPolicyCache(path.join(cacheFolder, reviewName));
    assert.ok(claim && review, `Missing validated cache files for ${packet.id}.`);
    files.set(claimName, claim);
    files.set(savedName, saved);
    files.set(reviewName, review);
  }
  const manifest = manifestSchema.parse({
    schemaVersion: 1, runId: run.id, mode: "search", packetCount: 10,
    files: [...files].map(([name, value]) => ({ name, sha256: digest(JSON.stringify(value, null, 2)) })),
  });
  const previous = await loadPolicyCache(path.join(bundle, "manifest.json"));
  const previousFiles = previous === undefined ? [] : manifestSchema.parse(previous).files;
  await mkdir(bundle, { recursive: true });
  await cp(path.join(cache.folder, run.id), path.join(bundle, "source", run.id), { recursive: true });
  for (const [name, value] of files) await savePolicyCache(path.join(bundle, name), value);
  await savePolicyCache(path.join(bundle, "manifest.json"), manifest);
  for (const { name } of previousFiles)
    if (!files.has(name)) await unlink(path.join(bundle, name));
  console.log("Exported ten current synthetic policy reviews and claim fields. No Azure calls were made.");
} else {
  const manifest = manifestSchema.parse(await loadPolicyCache(path.join(bundle, "manifest.json")));
  assert.equal(new Set(manifest.files.map((file) => file.name)).size, manifest.files.length,
    "The demo manifest contains duplicate files.");
  const payloads = await Promise.all(manifest.files.map(async ({ name, sha256 }) => {
    const bytes = await readFile(path.join(bundle, name));
    assert.equal(digest(bytes), sha256, `Demo checksum mismatch: ${name}`);
    return { name, value: JSON.parse(bytes.toString("utf8")) as unknown };
  }));
  const config = frameworkConfigSchema.parse(payloads.find((file) => file.name === "policy-agent-framework.json")?.value);
  const local = await loadPolicyCache(configFile);
  if (local)
    assert.equal(canonical(frameworkConfigSchema.parse(local)), canonical(config),
      "A different local policy configuration exists. Keep it; use a separately provisioned demo machine.");
  const pending = payloads.map(({ name, value }) => ({
    file: name === "policy-agent-framework.json" ? configFile : path.join(cacheFolder, name), value,
  }));
  for (const { file, value } of pending) {
    const existing = await loadPolicyCache(file);
    if (existing)
      assert.equal(canonical(file === configFile ? frameworkConfigSchema.parse(existing) : existing),
        canonical(value), `A different local cache already exists: ${path.basename(file)}. Nothing was restored.`);
  }
  // Validate the bundle's own sources before touching the local cache.
  const demo = await readPolicyDemo(bundle);
  const items = demo.results(demo.sourceRun).items;
  assert.equal(items.length, manifest.packetCount);
  assert.ok(items.every((item) => item.status === "completed"), "The bundled reviews do not match the included CU run.");
  for (const { file, value } of pending) {
    if (await loadPolicyCache(file) === undefined) await savePolicyCache(file, value);
  }
  console.log(`Restored ten saved policy reviews. ${items.filter((item) => item.historical).length} use earlier prompts. No Azure calls were made. Live runs still require Azure permissions.`);
}
