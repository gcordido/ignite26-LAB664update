import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Cache, type Run } from "./batch.ts";
import { LabError, repositoryRoot } from "./config.ts";
import { digest } from "./policy-core.ts";
import { frameworkConfigSchema, loadPolicyCache, PolicyService } from "./policy-service.ts";

export const policyDemoManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  mode: z.literal("search"),
  packetCount: z.literal(10),
  files: z.array(z.object({
    name: z.string().regex(/^(policy-agent-framework|claim-[a-f0-9]{64}|framework-(saved|review)-[a-f0-9]{64})\.json$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).length(31),
}).strict();

export async function readPolicyDemo(
  folder = path.join(repositoryRoot, "data", "policy-demo"),
  cache = new Cache(),
) {
  const manifest = policyDemoManifestSchema.parse(
    await loadPolicyCache(path.join(folder, "manifest.json")),
  );
  if (new Set(manifest.files.map(({ name }) => name)).size !== manifest.files.length)
    throw new LabError(422, "The bundled policy demo contains duplicate files.");
  if (!manifest.files.some(({ name }) => name === "policy-agent-framework.json") ||
      ["claim-", "framework-review-", "framework-saved-"].some((prefix) =>
        manifest.files.filter(({ name }) => name.startsWith(prefix)).length !== manifest.packetCount))
    throw new LabError(422, "The bundled policy demo must include configuration and all ten claim and review caches.");
  for (const { name, sha256 } of manifest.files)
    if (digest(await readFile(path.join(folder, name))) !== sha256)
      throw new LabError(422, `Bundled policy demo checksum mismatch: ${name}`);
  const config = frameworkConfigSchema.parse(
    await loadPolicyCache(path.join(folder, "policy-agent-framework.json")),
  );
  const service = new PolicyService({ config: async () => config, cacheFolder: folder });
  const run = await cache.load(manifest.runId);
  const items = await service.snapshot(run, "search", (id) => cache.raw(run.id, id));
  if (items.length !== manifest.packetCount || items.some((item) => item.status !== "completed"))
    throw new LabError(422, "The bundled policy reviews do not match the included CU results.");
  return {
    service,
    info: { runId: manifest.runId, mode: manifest.mode, indexName: config.indexName },
    results(selectedRun: Run) {
      if (selectedRun.id !== manifest.runId ||
          selectedRun.analyzer.fingerprint !== run.analyzer.fingerprint ||
          selectedRun.datasetHash !== run.datasetHash)
        throw new LabError(409, "Load the included CU run before loading bundled policy results.");
      return {
        runId: run.id, mode: manifest.mode, status: "completed" as const,
        cached: true, source: "bundled" as const,
        indexName: config.indexName, extractionMode: config.extractionMode, items,
      };
    },
  };
}

let demo: ReturnType<typeof readPolicyDemo> | undefined;
export function policyDemo() {
  return demo ??= readPolicyDemo();
}
