import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Cache, type Run } from "./batch.ts";
import { cacheFolders, LabError } from "./config.ts";
import { checkContractVersion, checkNames, digest, parseSourceDigest } from "./policy-core.ts";
import { frameworkConfigSchema, loadPolicyCache, PolicyService } from "./policy-service.ts";
import { policyResources } from "./policy-resources.ts";

export const policyDemoManifestSchema = z.object({
  schemaVersion: z.literal(2),
  checkContractVersion: z.literal(checkContractVersion),
  checks: z.tuple([z.literal("Daily rate"), z.literal("Effective terms"), z.literal("Repair estimate")]),
  runId: z.string().uuid(),
  mode: z.literal("search"),
  packetCount: z.literal(10),
  files: z.array(z.object({
    name: z.string().regex(/^(policy-agent-framework|framework-(saved|review)-[a-f0-9]{64})\.json$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).length(21),
  sourceCache: z.literal("../results"),
  sourceHashFormat: z.literal("utf8-lf"),
  sourceFiles: z.array(z.object({
    name: z.string().regex(/^(manifest|packet-\d{2}\.cu)\.json$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).length(11),
}).strict();

export async function readPolicyDemo(
  folder = cacheFolders().policy,
  cache = new Cache(path.resolve(folder, "..", "results")),
) {
  const savedManifest = await loadPolicyCache(path.join(folder, "manifest.json"));
  if (!savedManifest)
    throw new LabError(404, `No saved policy manifest was found in ${folder}.`);
  if (typeof savedManifest === "object" && savedManifest !== null &&
      (("schemaVersion" in savedManifest && savedManifest.schemaVersion === 1) ||
       ("checkContractVersion" in savedManifest && savedManifest.checkContractVersion !== checkContractVersion)))
    throw new LabError(422, "Earlier three/four/five-check policy results are history-only. Load the current pruned three-comparison bundle.");
  const manifest = policyDemoManifestSchema.parse(savedManifest);
  if (new Set(manifest.files.map(({ name }) => name)).size !== manifest.files.length)
    throw new LabError(422, "The bundled policy demo contains duplicate files.");
  if (!manifest.files.some(({ name }) => name === "policy-agent-framework.json") ||
      ["framework-review-", "framework-saved-"].some((prefix) =>
        manifest.files.filter(({ name }) => name.startsWith(prefix)).length !== manifest.packetCount))
    throw new LabError(422, "The bundled policy demo must include configuration and ten current three-check review caches; claim summaries aren't required.");
  for (const { name, sha256 } of manifest.files)
    if (digest(await readFile(path.join(folder, name))) !== sha256)
      throw new LabError(422, `Bundled policy demo checksum mismatch: ${name}`);
  if (new Set(manifest.sourceFiles.map(({ name }) => name)).size !== manifest.sourceFiles.length ||
      !manifest.sourceFiles.some(({ name }) => name === "manifest.json"))
    throw new LabError(422, "The bundled Parse source list contains duplicates or lacks its manifest.");
  for (const { name, sha256 } of manifest.sourceFiles)
    if (parseSourceDigest(await readFile(path.join(cache.folder, manifest.runId, name))) !== sha256)
      throw new LabError(422, `Bundled Parse source checksum mismatch: ${name}`);
  const config = frameworkConfigSchema.parse(
    await loadPolicyCache(path.join(folder, "policy-agent-framework.json")),
  );
  const resources = await policyResources(config, folder);
  const service = new PolicyService({ config: async () => config, cacheFolder: folder });
  const run = await cache.load(manifest.runId);
  const items = await service.snapshot(run, "search", (id) => cache.raw(run.id, id));
  if (items.length !== manifest.packetCount || items.some((item) => item.status !== "completed"))
    throw new LabError(422, "The bundled policy reviews do not match the included CU results.");
  return {
    service,
    sourceRun: run,
    sourceCache: cache,
    info: {
      runId: manifest.runId,
      mode: manifest.mode,
      indexName: config.indexName,
      resources,
      checks: checkNames,
      datasetHash: run.datasetHash,
    },
    results(selectedRun: Run) {
      return {
        runId: selectedRun.id, mode: manifest.mode, status: "completed" as const,
        cached: true, source: "bundled" as const,
        cacheFolder: folder,
        sourceRunId: run.id,
        sourceDatasetHash: run.datasetHash,
        indexName: config.indexName, extractionMode: config.extractionMode, items,
        resources,
      };
    },
  };
}

let demo: { folder: string; value: ReturnType<typeof readPolicyDemo> } | undefined;
export function policyDemo() {
  const folder = cacheFolders().policy;
  if (demo?.folder !== folder)
    demo = { folder, value: readPolicyDemo(folder) };
  return demo.value;
}
