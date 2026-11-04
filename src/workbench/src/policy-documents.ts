import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configuration, dataRoot, LabError, record, repositoryRoot } from "./config.ts";
import { CuClient } from "./cu.ts";
import { digest } from "./policy-core.ts";
import { frameworkConfigSchema } from "./policy-service.ts";

export const representationSchema = z.enum(["search", "digital"]);
export type Representation = z.infer<typeof representationSchema>;
export const analyzers = { search: "prebuilt-documentSearch", digital: "prebuilt-digitalParse" } as const;
export const nativePreviewProvenance = {
  endpoint: "https://mmi-usw3-eft-foundry.services.ai.azure.com",
  apiVersion: "2026-06-01-preview",
};
export const nativePreviewFolder = path.join(dataRoot, "policy-document-demo");
const policyFolder = "policies/rental/ocr-comparison-v2";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const policyFile = z.string().regex(/^policies\/rental\/ocr-comparison-v2\/[a-z0-9-]+\.pdf$/);
const capturedTime = z.iso.datetime();
const identitySchema = z.object({
  schemaVersion: z.literal(1), file: policyFile, sha256: hash,
  endpoint: z.string(), apiVersion: z.string(), analyzer: z.string(),
});
const cacheSchema = identitySchema.extend({
  createdAt: capturedTime, markdown: z.string(), response: z.unknown(),
  responseSha256: hash, markdownSha256: hash,
});
export const nativePreviewEntrySchema = identitySchema.extend({
  mode: representationSchema, createdAt: capturedTime,
  responseFile: z.string().regex(/^(search|digital)\/[a-f0-9]{64}\.response\.json$/),
  markdownFile: z.string().regex(/^(search|digital)\/[a-f0-9]{64}\.md$/),
  payloadSha256: hash, responseSha256: hash, markdownSha256: hash,
}).strict();
export const nativePreviewManifestSchema = z.object({
  schemaVersion: z.literal(2),
  activeManifestSha256: hash,
  endpoint: z.string(), apiVersion: z.string(),
  documents: z.array(z.object({ file: policyFile, sha256: hash }).strict()),
  entries: z.array(nativePreviewEntrySchema),
}).strict();
export type NativePreviewManifest = z.infer<typeof nativePreviewManifestSchema>;
type Native = z.infer<typeof cacheSchema>;
type Identity = z.infer<typeof identitySchema>;

export function representationMarkdown(response: unknown, mode: Representation = "search"): string {
  const top = record(response);
  if (String(top?.status).toLowerCase() !== "succeeded")
    throw new LabError(502, "CU document extraction did not succeed.");
  const contents = record(top?.result)?.contents;
  if (!Array.isArray(contents) || (!contents.length && mode !== "digital"))
    throw new LabError(502, "CU returned no document contents.");
  return contents.map((value) => {
    const content = record(value);
    if (!content || (typeof content.markdown !== "string" &&
        !(mode === "digital" && content.markdown === undefined)))
      throw new LabError(502, "CU returned document content without Markdown.");
    return content.markdown ?? "";
  }).join("\n\n");
}

function assertNative(value: Native, identity: Identity, mode: Representation) {
  for (const [name, expected] of Object.entries(identity))
    if (value[name as keyof Identity] !== expected)
      throw new LabError(500, "Policy document cache identity mismatch.");
  const responseAnalyzer = record(record(value.response)?.result)?.analyzerId;
  if (responseAnalyzer !== undefined && responseAnalyzer !== identity.analyzer)
    throw new LabError(500, "Policy document native response analyzer mismatch.");
  if (value.responseSha256 !== digest(JSON.stringify(value.response)) ||
      value.markdownSha256 !== digest(value.markdown) ||
      representationMarkdown(value.response, mode) !== value.markdown)
    throw new LabError(500, "Policy document cache response hash or derived Markdown mismatch.");
}

export async function writeNativePreviewFile(file: string, value: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.pending`;
  await writeFile(temporary, value);
  await rename(temporary, file);
}

type Dependencies = {
  cacheFolder?: string;
  bundleFolder?: string | null;
  manifest?: () => Promise<Buffer>;
  source?: (file: string) => Promise<Buffer>;
  provenance?: typeof nativePreviewProvenance;
  settings?: () => Promise<ReturnType<typeof configuration>>;
  analyze?: (analyzer: string, bytes: Buffer) => Promise<unknown>;
};

export class PolicyDocuments {
  private inFlight = new Map<string, Promise<Native>>();
  constructor(private dependencies: Dependencies = {}) {}

  async activeManifest() {
    const bytes = this.dependencies.manifest ? await this.dependencies.manifest()
      : await readFile(path.join(dataRoot, policyFolder, "manifest.json"));
    const manifest = record(JSON.parse(bytes.toString("utf8")));
    if (!Array.isArray(manifest?.documents)) throw new LabError(500, "Invalid policy manifest.");
    const files: string[] = [];
    for (const value of manifest.documents) {
      const entry = record(value);
      if (typeof entry?.pdf !== "string" || !/^[a-z0-9-]+\.pdf$/.test(entry.pdf))
        throw new LabError(500, "Invalid policy PDF manifest path.");
      const file = `${policyFolder}/${entry.pdf}`;
      if (files.includes(file)) throw new LabError(500, "Duplicate policy PDF manifest entry.");
      files.push(file);
    }
    return { files, sha256: digest(bytes) };
  }

  async files() { return (await this.activeManifest()).files; }

  private async source(file: string) {
    if (!(await this.files()).includes(file))
      throw new LabError(404, "Only manifest-listed rental policy PDFs can be extracted.");
    return this.dependencies.source ? this.dependencies.source(file) : readFile(path.join(dataRoot, file));
  }

  private provenance() { return this.dependencies.provenance ?? nativePreviewProvenance; }

  async bundleManifest(): Promise<NativePreviewManifest | undefined> {
    if (this.dependencies.bundleFolder === null) return;
    let raw: string;
    try {
      raw = await readFile(path.join(this.dependencies.bundleFolder ?? nativePreviewFolder, "manifest.json"), "utf8");
    } catch (error) {
      if (record(error)?.code === "ENOENT") return;
      throw error;
    }
    const bundle = nativePreviewManifestSchema.parse(JSON.parse(raw));
    const active = await this.activeManifest();
    const provenance = this.provenance();
    if (bundle.activeManifestSha256 !== active.sha256 ||
        bundle.endpoint !== provenance.endpoint || bundle.apiVersion !== provenance.apiVersion)
      throw new LabError(500, "Native policy preview bundle manifest or provenance mismatch.");
    const documents = new Map<string, string>();
    for (const document of bundle.documents) {
      if (documents.has(document.file) || !active.files.includes(document.file))
        throw new LabError(500, "Native policy preview bundle has duplicate or inactive documents.");
      documents.set(document.file, document.sha256);
    }
    if (documents.size !== active.files.length)
      throw new LabError(500, "Native policy preview bundle active document list is incomplete.");
    const pairs = new Set<string>();
    const payloads = new Set<string>();
    for (const entry of bundle.entries) {
      const pair = `${entry.file}:${entry.mode}`;
      const identity = this.identity(entry.file, entry.sha256, entry.mode, provenance);
      if (pairs.has(pair) || payloads.has(entry.responseFile) || payloads.has(entry.markdownFile))
        throw new LabError(500, "Native policy preview bundle has duplicate entries or payloads.");
      pairs.add(pair);
      payloads.add(entry.responseFile);
      payloads.add(entry.markdownFile);
      if (documents.get(entry.file) !== entry.sha256 ||
          Object.entries(identity).some(([name, value]) => entry[name as keyof Identity] !== value) ||
          entry.responseFile !== `${entry.mode}/${digest(JSON.stringify(identity))}.response.json` ||
          entry.markdownFile !== `${entry.mode}/${digest(JSON.stringify(identity))}.md`)
        throw new LabError(500, "Native policy preview bundle entry identity mismatch.");
    }
    return bundle;
  }

  private identity(file: string, sha256: string, mode: Representation,
    provenance = this.provenance()): Identity {
    return { schemaVersion: 1, file, sha256, ...provenance, analyzer: analyzers[mode] };
  }

  private async bundled(file: string, mode: Representation, sha256: string) {
    const manifest = await this.bundleManifest();
    if (!manifest) return;
    if (manifest.documents.find((document) => document.file === file)?.sha256 !== sha256)
      throw new LabError(500, "Native policy preview source PDF hash mismatch.");
    const entry = manifest.entries.find((entry) => entry.file === file && entry.mode === mode);
    if (!entry) return;
    const folder = this.dependencies.bundleFolder ?? nativePreviewFolder;
    // Missing indexed payloads are corrupt, not a cache miss. Never fall through to Azure.
    const [payload, markdown] = await Promise.all([
      readFile(path.join(folder, entry.responseFile)),
      readFile(path.join(folder, entry.markdownFile), "utf8"),
    ]);
    if (digest(payload) !== entry.payloadSha256)
      throw new LabError(500, "Native policy preview payload hash mismatch.");
    const native = cacheSchema.parse({ ...entry, response: JSON.parse(payload.toString("utf8")), markdown });
    assertNative(native, this.identity(file, sha256, mode), mode);
    return native;
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

  async native(file: string, mode: Representation, live = false) {
    representationSchema.parse(mode);
    const bytes = await this.source(file);
    const sha256 = digest(bytes);
    const bundled = await this.bundled(file, mode, sha256);
    if (bundled) return { value: bundled, cached: true };
    const settings = live ? await this.settings() : undefined;
    const identity = this.identity(file, sha256, mode, settings
      ? { endpoint: settings.endpoint, apiVersion: settings.apiVersion } : this.provenance());
    const key = digest(JSON.stringify(identity));
    const cacheFile = path.join(this.dependencies.cacheFolder ??
      path.join(repositoryRoot, ".tools", "policy-document-cache"), `${key}.json`);
    try {
      const cached = cacheSchema.parse(JSON.parse(await readFile(cacheFile, "utf8")));
      assertNative(cached, identity, mode);
      return { value: cached, cached: true };
    } catch (error) {
      if (record(error)?.code !== "ENOENT") throw error;
    }
    if (!settings) return { identity, cached: false };
    let pending = this.inFlight.get(key);
    if (!pending) {
      if (this.inFlight.size)
        throw new LabError(409, "Another policy document extraction is running. Wait before generating this view.");
      pending = (async () => {
        const response = this.dependencies.analyze
          ? await this.dependencies.analyze(analyzers[mode], bytes)
          : await new CuClient(settings).analyze(analyzers[mode], bytes);
        const markdown = representationMarkdown(response, mode);
        const value = { ...identity, createdAt: new Date().toISOString(), markdown, response,
          responseSha256: digest(JSON.stringify(response)), markdownSha256: digest(markdown) };
        assertNative(value, identity, mode);
        await writeNativePreviewFile(cacheFile, JSON.stringify(value));
        return value;
      })();
      this.inFlight.set(key, pending);
    }
    try { return { value: await pending, cached: false }; }
    finally { if (this.inFlight.get(key) === pending) this.inFlight.delete(key); }
  }

  async get(file: string, mode: Representation, live = false) {
    const native = await this.native(file, mode, live);
    if (!native.value) return { ...native.identity, mode, available: false as const };
    return { ...native.value, response: undefined, cached: native.cached, mode, available: true as const };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename &&
    process.argv.includes("--warm"))
  throw new LabError(400, "Use policy-document-warm.ts with explicit Azure approval, active file count and analysis budget.");
