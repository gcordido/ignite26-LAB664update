import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { configuration, dataRoot, record, repositoryRoot } from "./config.ts";
import { CuClient } from "./cu.ts";
import { digest } from "./policy-core.ts";
import {
  PolicyDocuments, nativePreviewFolder, nativePreviewManifestSchema, nativePreviewProvenance,
  representationSchema, writeNativePreviewFile, type NativePreviewManifest,
} from "./policy-documents.ts";

const ledgerSchema = z.object({
  schemaVersion: z.literal(1), activeManifestSha256: z.string(),
  endpoint: z.string(), apiVersion: z.string(), maxAnalyses: z.number().int().positive(),
  attempts: z.array(z.object({
    file: z.string(), mode: representationSchema, sha256: z.string(),
    startedAt: z.string(), finishedAt: z.string().optional(), responseSha256: z.string().optional(),
    error: z.string().optional(),
  })),
});

export function assertPortableNativeResponse(response: unknown) {
  const text = JSON.stringify(response);
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
    let url: URL;
    try { url = new URL(match[0]); } catch { continue; }
    if (url.username || url.password || [...url.searchParams.keys()]
      .some((key) => /^(sig|signature|token|access_token|api[-_]?key|authorization)$/i.test(key)))
      throw new Error("Native response contains a credential or signed URL; it cannot be exported.");
  }
}

type Options = {
  expectedFiles: number;
  maxAnalyses: number;
  bundleFolder?: string;
  cacheFolder?: string;
  ledgerFile?: string;
  settings?: ReturnType<typeof configuration>;
  manifest?: () => Promise<Buffer>;
  source?: (file: string) => Promise<Buffer>;
  analyze?: (analyzer: string, bytes: Buffer) => Promise<unknown>;
  report?: (value: Record<string, unknown>) => void;
};

// This maintenance entry point submits only missing native pairs. Its durable ledger counts
// uncertain/failed submissions too, so rerunning cannot silently multiply Azure usage.
export async function warmNativePreviewBundle(options: Options) {
  const ledgerFile = options.ledgerFile ??
    path.join(repositoryRoot, ".tools", "policy-document-warm-run.json");
  await mkdir(path.dirname(ledgerFile), { recursive: true });
  const lockFile = `${ledgerFile}.lock`;
  let lock;
  try { lock = await open(lockFile, "wx"); }
  catch (error) {
    if (record(error)?.code === "EEXIST")
      throw new Error("Native preview warming is already locked. Verify the owning process before removing a stale lock.");
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await warmLockedNativePreviewBundle({ ...options, ledgerFile });
  } finally {
    await lock.close();
    await unlink(lockFile);
  }
}

async function warmLockedNativePreviewBundle(options: Options) {
  const settings = options.settings ?? configuration();
  if (settings.endpoint !== nativePreviewProvenance.endpoint ||
      settings.apiVersion !== nativePreviewProvenance.apiVersion)
    throw new Error("Set CU_ENDPOINT and CU_API_VERSION to the exact approved native-preview provenance.");
  if (!Number.isInteger(options.expectedFiles) || options.expectedFiles < 1 ||
      !Number.isInteger(options.maxAnalyses) || options.maxAnalyses < 1 ||
      options.maxAnalyses > options.expectedFiles * 2 || options.maxAnalyses > 42)
    throw new Error("A positive expected file count and at most two analyses per active PDF (42 total) are required.");
  const folder = options.bundleFolder ?? nativePreviewFolder;
  const ledgerFile = options.ledgerFile ??
    path.join(repositoryRoot, ".tools", "policy-document-warm-run.json");
  const common = {
    bundleFolder: folder, cacheFolder: options.cacheFolder,
    manifest: options.manifest, source: options.source, settings: async () => settings,
  };
  const baseline = new PolicyDocuments(common);
  const active = await baseline.activeManifest();
  if (active.files.length !== options.expectedFiles)
    throw new Error(`Expected ${options.expectedFiles} active PDFs; found ${active.files.length}. No analyses submitted.`);
  const readSource = options.source ?? ((file: string) => readFile(path.join(dataRoot, file)));
  const sources = new Map<string, string>();
  for (const file of active.files) sources.set(file, digest(await readSource(file)));
  const checkActive = async () => {
    if ((await baseline.activeManifest()).sha256 !== active.sha256)
      throw new Error("The active manifest changed during warming. Stopped without further submissions.");
  };
  let ledger: z.infer<typeof ledgerSchema>;
  try { ledger = ledgerSchema.parse(JSON.parse(await readFile(ledgerFile, "utf8"))); }
  catch (error) {
    if (record(error)?.code !== "ENOENT") throw error;
    ledger = { schemaVersion: 1, activeManifestSha256: active.sha256,
      ...nativePreviewProvenance, maxAnalyses: options.maxAnalyses, attempts: [] };
  }
  if (ledger.activeManifestSha256 !== active.sha256 ||
      ledger.endpoint !== settings.endpoint || ledger.apiVersion !== settings.apiVersion ||
      ledger.maxAnalyses !== options.maxAnalyses || ledger.attempts.length > options.maxAnalyses)
    throw new Error("Native preview warming ledger identity/budget mismatch. No analyses submitted.");
  const saveLedger = () => writeNativePreviewFile(ledgerFile, JSON.stringify(ledger, null, 2));
  const documents = new PolicyDocuments({
    ...common,
    source: async (file) => {
      await checkActive();
      const bytes = await readSource(file);
      if (digest(bytes) !== sources.get(file)) throw new Error(`Source PDF changed during warming: ${file}`);
      return bytes;
    },
    analyze: async (analyzer, bytes) => {
      await checkActive();
      if (!current) throw new Error("No active native pair.");
      const { file, mode } = current;
      if (ledger.attempts.some((attempt) => attempt.file === file && attempt.mode === mode))
        throw new Error(`An earlier submission for ${file} (${mode}) has no usable cache. Inspect its raw result; an individually approved retry is required.`);
      if (ledger.attempts.length >= options.maxAnalyses)
        throw new Error("Approved native analysis budget exhausted; no additional analysis was submitted.");
      const attempt: z.infer<typeof ledgerSchema>["attempts"][number] = {
        file, mode, sha256: digest(bytes), startedAt: new Date().toISOString(),
      };
      ledger.attempts.push(attempt);
      await saveLedger();
      const captureFile = path.join(path.dirname(ledgerFile),
        `policy-document-native-${digest(`${file}:${mode}:${attempt.sha256}`)}.json`);
      try {
        const response = options.analyze ? await options.analyze(analyzer, bytes)
          : await new CuClient(settings).analyze(analyzer, bytes);
        await writeNativePreviewFile(captureFile, JSON.stringify(response));
        attempt.responseSha256 = digest(JSON.stringify(response));
        attempt.finishedAt = new Date().toISOString();
        await saveLedger();
        assertPortableNativeResponse(response);
        return response;
      } catch (error) {
        attempt.error = String(error);
        attempt.finishedAt = new Date().toISOString();
        await writeNativePreviewFile(`${captureFile}.failure.json`, JSON.stringify({
          file, mode, analyzer, ...nativePreviewProvenance, sha256: attempt.sha256,
          capturedAt: attempt.finishedAt, error: String(error), response: record(error)?.response,
        }, null, 2));
        await saveLedger();
        throw error;
      }
    },
  });
  let current: { file: string; mode: "search" | "digital" } | undefined;
  const existing = await documents.bundleManifest();
  const bundle: NativePreviewManifest = existing ?? {
    schemaVersion: 2, activeManifestSha256: active.sha256, ...nativePreviewProvenance,
    documents: active.files.map((file) => ({ file, sha256: sources.get(file)! })), entries: [],
  };
  for (const source of bundle.documents)
    if (sources.get(source.file) !== source.sha256)
      throw new Error(`Native bundle source PDF changed: ${source.file}`);
  await saveLedger();
  await writeNativePreviewFile(path.join(folder, "manifest.json"), JSON.stringify(bundle, null, 2));
  for (const file of active.files) {
    for (const mode of representationSchema.options) {
      current = { file, mode };
      const native = await documents.native(file, mode, true);
      if (!native.value) throw new Error(`No successful native result for ${file} (${mode}).`);
      const value = native.value;
      assertPortableNativeResponse(value.response);
      const identity = {
        schemaVersion: value.schemaVersion, file, sha256: value.sha256,
        endpoint: value.endpoint, apiVersion: value.apiVersion, analyzer: value.analyzer,
      };
      const key = digest(JSON.stringify(identity));
      const payload = JSON.stringify(value.response);
      const entry = {
        ...identity, mode, createdAt: value.createdAt,
        responseFile: `${mode}/${key}.response.json`, markdownFile: `${mode}/${key}.md`,
        payloadSha256: digest(payload), responseSha256: value.responseSha256,
        markdownSha256: value.markdownSha256,
      };
      if (!bundle.entries.some((entry) => entry.file === file && entry.mode === mode)) {
        await writeNativePreviewFile(path.join(folder, entry.responseFile), payload);
        await writeNativePreviewFile(path.join(folder, entry.markdownFile), value.markdown);
        bundle.entries.push(entry);
        nativePreviewManifestSchema.parse(bundle);
        await writeNativePreviewFile(path.join(folder, "manifest.json"), JSON.stringify(bundle, null, 2));
      }
      options.report?.({ file, mode, analyzer: value.analyzer, cached: native.cached,
        bytes: Buffer.byteLength(payload), characters: value.markdown.length,
        sha256: value.sha256, payloadSha256: entry.payloadSha256 });
    }
  }
  current = undefined;
  await checkActive();
  const verified = await documents.bundleManifest();
  if (!verified || verified.entries.length !== active.files.length * 2)
    throw new Error("Native preview bundle does not contain both pairs for every active PDF.");
  // Verify every exported payload through the exact offline serving path, without settings.
  const offline = new PolicyDocuments({
    ...common, settings: async () => { throw new Error("Offline verification requested live settings."); },
    analyze: async () => { throw new Error("Offline verification attempted an Azure call."); },
  });
  for (const file of active.files)
    for (const mode of representationSchema.options) {
      const value = await offline.get(file, mode);
      if (!value.available || !value.cached) throw new Error(`Offline native pair missing: ${file} (${mode}).`);
    }
  return { documents: active.files.length, pairs: verified.entries.length,
    analyses: ledger.attempts.length, activeManifestSha256: active.sha256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2);
  if (!args.includes("--approve-azure") || !args.includes("--export-bundle"))
    throw new Error("Requires --approve-azure --export-bundle --expected-files=21 --max-analyses=42. Run only after the active manifest is approved.");
  const numeric = (name: string) => Number(args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1]);
  const result = await warmNativePreviewBundle({
    expectedFiles: numeric("expected-files"), maxAnalyses: numeric("max-analyses"),
    report: (value) => console.log(JSON.stringify(value)),
  });
  console.log(JSON.stringify({ complete: true, ...result }));
}
