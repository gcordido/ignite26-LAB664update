import assert from "node:assert/strict";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Cache } from "./batch.ts";
import { repositoryRoot } from "./config.ts";
import { canonical, checkContractVersion, checkNames, digest, parseSourceDigest } from "./policy-core.ts";
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
    const savedKey = digest(canonical({
      checkContractVersion, config, runId: run.id, analyzer: run.analyzer.fingerprint, mode: "search", packetId: packet.id,
    }));
    const savedName = `framework-saved-${savedKey}.json`;
    const saved = z.object({ reviewKey: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough()
      .parse(await loadPolicyCache(path.join(cacheFolder, savedName)));
    const reviewName = `framework-review-${saved.reviewKey}.json`;
    const review = await loadPolicyCache(path.join(cacheFolder, reviewName));
    assert.ok(review, `Missing validated current three-check review for ${packet.id}.`);
    files.set(savedName, saved);
    files.set(reviewName, review);
  }
  const sourceNames = ["manifest.json", ...run.source.map((packet) => `${packet.id}.cu.json`)];
  const sourceFiles = await Promise.all(sourceNames.map(async (name) => ({
    name, sha256: parseSourceDigest(await readFile(path.join(cache.folder, run.id, name))),
  })));
  const manifest = manifestSchema.parse({
    schemaVersion: 2, checkContractVersion, checks: checkNames,
    runId: run.id, mode: "search", packetCount: 10,
    sourceCache: "../results", sourceHashFormat: "utf8-lf", sourceFiles,
    files: [...files].map(([name, value]) => ({ name, sha256: digest(JSON.stringify(value, null, 2)) })),
  });
  const previous = await loadPolicyCache(path.join(bundle, "manifest.json"));
  let obsolete: string[] = [];
  await mkdir(bundle, { recursive: true });
  const legacy = z.object({
    schemaVersion: z.literal(1), runId: z.string().uuid(),
    files: z.array(z.object({ name: z.string().regex(/^(policy-agent-framework|claim-[a-f0-9]{64}|framework-(saved|review)-[a-f0-9]{64})\.json$/) })),
  }).safeParse(previous);
  if (legacy.success) {
    const history = path.join(bundle, "history", "five-checks");
    await mkdir(path.join(history, "source"), { recursive: true });
    for (const { name } of legacy.data.files)
      await rename(path.join(bundle, name), path.join(history, name));
    await rename(path.join(bundle, "source", legacy.data.runId), path.join(history, "source", legacy.data.runId));
    await rename(path.join(bundle, "manifest.json"), path.join(history, "manifest.json"));
  } else if (previous !== undefined && z.object({ checkContractVersion: z.literal(4) }).safeParse(previous).success) {
    const prior = manifestSchema.extend({
      checkContractVersion: z.literal(4),
      checks: z.tuple([z.literal("Daily rate"), z.literal("Rental start"), z.literal("Effective terms"), z.literal("Repair estimate")]),
    }).parse(previous);
    const history = path.join(bundle, "history", "four-checks");
    await mkdir(history, { recursive: true });
    assert.equal(await loadPolicyCache(path.join(history, "manifest.json")), undefined,
      "Four-check history already exists; preserve it before exporting.");
    for (const { name, sha256 } of prior.files) {
      assert.equal(digest(await readFile(path.join(bundle, name))), sha256, `Prior bundle checksum mismatch: ${name}`);
      assert.equal(await loadPolicyCache(path.join(history, name)), undefined);
    }
    for (const { name } of prior.files)
      await rename(path.join(bundle, name), path.join(history, name));
    await rename(path.join(bundle, "manifest.json"), path.join(history, "manifest.json"));
    if (await loadPolicyCache(path.join(bundle, "resources.json")))
      await rename(path.join(bundle, "resources.json"), path.join(history, "resources.json"));
  } else if (previous !== undefined && z.object({ checkContractVersion: z.literal(3) }).safeParse(previous).success) {
    const prior = manifestSchema.extend({
      checkContractVersion: z.literal(3),
      checks: z.tuple([z.literal("Daily rate"), z.literal("Rental start"), z.literal("Effective terms")]),
    }).parse(previous);
    const history = path.join(bundle, "history", "three-checks");
    await mkdir(history, { recursive: true });
    assert.equal(await loadPolicyCache(path.join(history, "manifest.json")), undefined,
      "Three-check history already exists; preserve it before exporting.");
    for (const { name, sha256 } of prior.files) {
      const source = path.join(bundle, name), target = path.join(history, name);
      assert.equal(digest(await readFile(source)), sha256, `Prior bundle checksum mismatch: ${name}`);
      assert.equal(await loadPolicyCache(target), undefined, `Three-check history already exists: ${name}`);
    }
    for (const { name } of prior.files)
      await rename(path.join(bundle, name), path.join(history, name));
    await rename(path.join(bundle, "manifest.json"), path.join(history, "manifest.json"));
  } else if (previous !== undefined) {
    obsolete = manifestSchema.parse(previous).files.map((file) => file.name).filter((name) => !files.has(name));
  }
  for (const [name, value] of files) await savePolicyCache(path.join(bundle, name), value);
  await savePolicyCache(path.join(bundle, "manifest.json"), manifest);
  await readPolicyDemo(bundle);
  for (const name of obsolete) await rm(path.join(bundle, name), { force: true });
  console.log("Exported ten current pruned three-comparison reviews reusing committed Parse. Earlier three/four/five-check results remain unchanged in history.");
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
