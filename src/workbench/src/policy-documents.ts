import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configuration, dataRoot, LabError, record, repositoryRoot } from "./config.ts";
import { CuClient } from "./cu.ts";
import { digest } from "./policy-core.ts";
import { frameworkConfigSchema } from "./policy-service.ts";

export const representationSchema = z.enum(["layout", "digital"]);
export type Representation = z.infer<typeof representationSchema>;
const analyzers = { layout: "prebuilt-layout", digital: "prebuilt-digitalParse" } as const;
const cacheSchema = z.object({
  schemaVersion: z.literal(1), file: z.string(), sha256: z.string(), endpoint: z.string(),
  apiVersion: z.string(), analyzer: z.string(), createdAt: z.string(),
  markdown: z.string(), response: z.unknown(),
});

export function representationMarkdown(response: unknown): string {
  const top = record(response);
  if (String(top?.status).toLowerCase() !== "succeeded")
    throw new LabError(502, "CU document extraction did not succeed.");
  const contents = record(top?.result)?.contents;
  if (!Array.isArray(contents) || !contents.length)
    throw new LabError(502, "CU returned no document contents.");
  return contents.map((value) => {
    const content = record(value);
    if (!content || typeof content.markdown !== "string")
      throw new LabError(502, "CU returned document content without Markdown.");
    return content.markdown;
  }).join("\n\n");
}

type Dependencies = {
  cacheFolder?: string;
  source?: (file: string) => Promise<Buffer>;
  settings?: () => Promise<ReturnType<typeof configuration>>;
  analyze?: (analyzer: string, bytes: Buffer) => Promise<unknown>;
};

export class PolicyDocuments {
  private inFlight = new Map<string, Promise<z.infer<typeof cacheSchema>>>();
  constructor(private dependencies: Dependencies = {}) {}

  async files() {
    const files: string[] = [];
    for (const folder of ["policies/rental/ocr-comparison-v2"]) {
      const manifest = record(JSON.parse(await readFile(path.join(dataRoot, folder, "manifest.json"), "utf8")));
      if (!Array.isArray(manifest?.documents)) throw new LabError(500, "Invalid policy manifest.");
      for (const value of manifest.documents) {
        const entry = record(value);
        if (typeof entry?.pdf !== "string" || !/^[a-z0-9-]+\.pdf$/.test(entry.pdf))
          throw new LabError(500, "Invalid policy PDF manifest path.");
        files.push(`${folder}/${entry.pdf}`);
      }
    }
    return files;
  }

  private async source(file: string) {
    if (this.dependencies.source) return this.dependencies.source(file);
    if (!(await this.files()).includes(file))
      throw new LabError(404, "Only manifest-listed rental policy PDFs can be extracted.");
    return readFile(path.join(dataRoot, file));
  }

  private async settings() {
    if (this.dependencies.settings) return this.dependencies.settings();
    const settings = configuration();
    if (settings.endpoint) return settings;
    try {
      const config = frameworkConfigSchema.parse(JSON.parse(await readFile(
        process.env.POLICY_FRAMEWORK_CONFIG ?? path.join(repositoryRoot, ".tools", "policy-agent-framework.json"), "utf8")));
      return { ...settings, endpoint: config.cuEndpoint };
    } catch (error) {
      if (record(error)?.code === "ENOENT")
        throw new LabError(503, "Configure CU_ENDPOINT or policy setup to extract policy documents.");
      throw error;
    }
  }

  async get(file: string, mode: Representation, live = false) {
    const bytes = await this.source(file);
    const settings = await this.settings();
    const identity = {
      schemaVersion: 1 as const, file, sha256: digest(bytes),
      endpoint: settings.endpoint, apiVersion: settings.apiVersion, analyzer: analyzers[mode],
    };
    const key = digest(JSON.stringify(identity));
    const cacheFile = path.join(this.dependencies.cacheFolder ??
      path.join(repositoryRoot, ".tools", "policy-document-cache"), `${key}.json`);
    try {
      const cached = cacheSchema.parse(JSON.parse(await readFile(cacheFile, "utf8")));
      for (const [name, value] of Object.entries(identity))
        if (cached[name as keyof typeof identity] !== value)
          throw new LabError(500, "Policy document cache identity mismatch.");
      return { ...cached, response: undefined, cached: true, mode, available: true as const };
    } catch (error) {
      if (record(error)?.code !== "ENOENT") throw error;
    }
    if (!live) return { ...identity, mode, available: false as const };
    let pending = this.inFlight.get(key);
    if (!pending) {
      if (this.inFlight.size)
        throw new LabError(409, "Another policy document extraction is running. Wait before generating this view.");
      pending = (async () => {
        const response = this.dependencies.analyze
          ? await this.dependencies.analyze(analyzers[mode], bytes)
          : await new CuClient(settings).analyze(analyzers[mode], bytes);
        const markdown = representationMarkdown(response);
        const value = { ...identity, createdAt: new Date().toISOString(), markdown, response };
        await mkdir(path.dirname(cacheFile), { recursive: true });
        const temporary = `${cacheFile}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(value));
        await rename(temporary, cacheFile);
        return value;
      })();
      this.inFlight.set(key, pending);
    }
    try {
      const value = await pending;
      return { ...value, response: undefined, cached: false, mode, available: true as const };
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename &&
    process.argv.includes("--warm")) {
  const documents = new PolicyDocuments();
  let failures = 0;
  for (const file of await documents.files()) {
    for (const mode of representationSchema.options) {
      try {
        const result = await documents.get(file, mode, true);
        if (!result.available) throw new Error("Warm extraction did not produce a result.");
        console.log(JSON.stringify({ file, mode, cached: result.cached, characters: result.markdown.length }));
      } catch (error) {
        failures++;
        console.error(JSON.stringify({ file, mode, error: String(error) }));
      }
    }
  }
  if (failures) process.exitCode = 1;
}
