import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { digest } from "./policy-core.ts";
import {
  PolicyDocuments, nativePreviewFolder, nativePreviewProvenance, type NativePreviewManifest,
} from "./policy-documents.ts";
import { assertPortableNativeResponse, warmNativePreviewBundle } from "./policy-document-warm.ts";

const file = "policies/rental/ocr-comparison-v2/test.pdf";
const table = '<table><tr><td rowspan="2">Policy</td><td>75</td></tr></table>';
const manifestBytes = Buffer.from(JSON.stringify({ documents: [{ pdf: "test.pdf" }] }));
const pdfBytes = Buffer.from("fixture PDF bytes, not used as native extraction");

async function fixture() {
  const root = path.resolve(`.policy-document-bundle-test-${randomUUID()}`);
  await mkdir(root);
  const bundleFolder = path.join(root, "bundle");
  const cacheFolder = path.join(root, "cache");
  const ledgerFile = path.join(root, "ledger.json");
  const calls: string[] = [];
  let settingsCalls = 0;
  const common = {
    bundleFolder, cacheFolder,
    manifest: async () => manifestBytes,
    source: async (requested: string) => {
      assert.equal(requested, file);
      return pdfBytes;
    },
  };
  const options = {
    ...common, ledgerFile, expectedFiles: 1, maxAnalyses: 2,
    settings: { ...nativePreviewProvenance, port: 8791 },
    analyze: async (analyzer: string) => {
      calls.push(analyzer);
      return {
        id: `native-test-${analyzer}`, status: "Succeeded",
        result: { analyzerId: analyzer, contents: analyzer === "prebuilt-digitalParse"
          ? [{ kind: "document", pages: [{ pageNumber: 1 }], figures: [{ id: "1.1" }] }]
          : [{ kind: "document", markdown: table }] },
      };
    },
  };
  const offline = () => new PolicyDocuments({
    ...common,
    settings: async () => { settingsCalls++; throw new Error("Credentials unavailable"); },
    analyze: async () => { throw new Error("Unexpected Azure call"); },
  });
  return {
    root, common, options, calls, offline, settingsCalls: () => settingsCalls,
    manifest: async () => JSON.parse(await readFile(path.join(bundleFolder, "manifest.json"), "utf8")) as NativePreviewManifest,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("native bundle preserves both genuine-shaped raw payloads and derived Markdown; offline hits require no settings or Azure", async () => {
  const f = await fixture();
  try {
    const warmed = await warmNativePreviewBundle(f.options);
    assert.deepEqual(warmed, {
      documents: 1, pairs: 2, analyses: 2, activeManifestSha256: digest(manifestBytes),
    });
    assert.deepEqual(f.calls, ["prebuilt-documentSearch", "prebuilt-digitalParse"]);
    const bundle = await f.manifest();
    assert.equal(bundle.documents[0].sha256, digest(pdfBytes));
    for (const entry of bundle.entries) {
      const payload = await readFile(path.join(f.common.bundleFolder, entry.responseFile));
      const response = JSON.parse(payload.toString("utf8"));
      assert.equal(entry.payloadSha256, digest(payload));
      assert.equal(entry.responseSha256, digest(JSON.stringify(response)));
      assert.equal(response.result.analyzerId, entry.analyzer);
      assert.equal(entry.sha256, digest(pdfBytes));
      assert.ok(Number.isFinite(Date.parse(entry.createdAt)));
      assert.ok(entry.responseFile.startsWith(`${entry.mode}/`));
      assert.ok(entry.markdownFile.startsWith(`${entry.mode}/`));
      const value = await f.offline().get(file, entry.mode, true);
      assert.ok(value.available && value.cached);
      assert.equal(value.response, undefined);
      assert.equal(value.markdown, entry.mode === "digital" ? "" : table);
      assert.equal(entry.markdownSha256, digest(value.markdown));
      if (entry.mode === "digital") {
        assert.deepEqual(response.result.contents[0].pages, [{ pageNumber: 1 }]);
        assert.deepEqual(response.result.contents[0].figures, [{ id: "1.1" }]);
        assert.equal(response.result.contents[0].markdown, undefined, "Never invent OCR Markdown.");
      }
    }
    assert.equal(f.settingsCalls(), 0);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(await warmNativePreviewBundle(f.options), warmed);
    assert.equal(f.calls.length, 2, "A repeated export must reuse every successful native pair.");
    assert.equal((await readdir(f.common.bundleFolder)).length, 3);
    for (const mode of ["search", "digital"])
      assert.equal((await readdir(path.join(f.common.bundleFolder, mode))).length, 2);
  } finally { await f.cleanup(); }
});

test("missing bundle and optional missing pair are explicitly unavailable without loading settings", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.offline().get(file, "digital")).available, false);
    await warmNativePreviewBundle(f.options);
    const bundle = await f.manifest();
    bundle.entries = [];
    await writeFile(path.join(f.common.bundleFolder, "manifest.json"), JSON.stringify(bundle));
    const isolated = new PolicyDocuments({
      ...f.common, cacheFolder: path.join(f.root, "absent-cache"),
      settings: async () => { throw new Error("Settings must not be loaded."); },
      analyze: async () => { throw new Error("Azure must not be called."); },
    });
    assert.equal((await isolated.get(file, "digital")).available, false);
    assert.equal(f.settingsCalls(), 0);
  } finally { await f.cleanup(); }
});

test("indexed corruption, stale sources/provenance, duplicates, traversal and invalid native responses never fall through to Azure", async () => {
  const f = await fixture();
  try {
    await warmNativePreviewBundle(f.options);
    const original = await f.manifest();
    const manifestFile = path.join(f.common.bundleFolder, "manifest.json");
    const originalEntry = original.entries[0];
    const payloadFile = path.join(f.common.bundleFolder, originalEntry.responseFile);
    const markdownFile = path.join(f.common.bundleFolder, originalEntry.markdownFile);
    const payload = await readFile(payloadFile);
    const markdown = await readFile(markdownFile);
    const variants: ((bundle: NativePreviewManifest) => Promise<void> | void)[] = [
      (bundle) => { bundle.activeManifestSha256 = "0".repeat(64); },
      (bundle) => { bundle.endpoint = "https://other.services.ai.azure.com"; },
      (bundle) => { bundle.apiVersion = "2025-11-01"; },
      (bundle) => { Object.assign(bundle, { schemaVersion: 1 }); },
      (bundle) => { bundle.documents.push(bundle.documents[0]); },
      (bundle) => { bundle.documents = []; },
      (bundle) => { bundle.entries.push(bundle.entries[0]); },
      (bundle) => { bundle.documents[0].file = "policies/rental/ocr-comparison-v2/archived.pdf"; },
      (bundle) => { bundle.entries[0].analyzer = "prebuilt-layout"; },
      (bundle) => { bundle.entries[0].responseFile = "../outside.response.json"; },
      (bundle) => { bundle.entries[0].responseFile = bundle.entries[0].responseFile.replace("search/", "digital/"); },
      (bundle) => { bundle.entries[0].sha256 = "0".repeat(64); },
      (bundle) => { bundle.entries[0].markdownSha256 = "0".repeat(64); },
      () => writeFile(payloadFile, "{}"),
      () => writeFile(markdownFile, "Hand-edited extraction"),
      () => rm(payloadFile),
      async (bundle) => {
        const response = JSON.parse(payload.toString("utf8"));
        response.status = "Failed";
        const changed = JSON.stringify(response);
        await writeFile(payloadFile, changed);
        bundle.entries[0].payloadSha256 = digest(changed);
        bundle.entries[0].responseSha256 = digest(changed);
      },
      async (bundle) => {
        const response = JSON.parse(payload.toString("utf8"));
        response.result.contents[0].markdown = "Not the stored Markdown";
        const changed = JSON.stringify(response);
        await writeFile(payloadFile, changed);
        bundle.entries[0].payloadSha256 = digest(changed);
        bundle.entries[0].responseSha256 = digest(changed);
      },
      async (bundle) => {
        const response = JSON.parse(payload.toString("utf8"));
        response.result.analyzerId = "prebuilt-layout";
        const changed = JSON.stringify(response);
        await writeFile(payloadFile, changed);
        bundle.entries[0].payloadSha256 = digest(changed);
        bundle.entries[0].responseSha256 = digest(changed);
      },
    ];
    for (const mutate of variants) {
      await writeFile(payloadFile, payload);
      await writeFile(markdownFile, markdown);
      const bundle = structuredClone(original);
      await mutate(bundle);
      await writeFile(manifestFile, JSON.stringify(bundle));
      await assert.rejects(f.offline().get(file, "search", true));
      assert.equal(f.settingsCalls(), 0);
      assert.equal(f.calls.length, 2);
    }
    await writeFile(payloadFile, payload);
    await writeFile(markdownFile, markdown);
    await writeFile(manifestFile, JSON.stringify(original));
    await assert.rejects(new PolicyDocuments({
      ...f.common, source: async () => Buffer.from("Changed PDF bytes"),
    }).get(file, "digital"), /source PDF hash mismatch/);
    for (const requested of ["../test.pdf", file.replace("test.pdf", "archive/test.pdf"),
      "policies/archive/legacy-rental-review-v2/test.pdf", "policies/rental/ocr-comparison-v2/not-active.pdf"])
      await assert.rejects(f.offline().get(requested, "search", true), /manifest-listed/);
  } finally { await f.cleanup(); }
});

test("active manifest rejects duplicate and nested/archive paths before any source access", async () => {
  for (const documents of [
    [{ pdf: "test.pdf" }, { pdf: "test.pdf" }],
    [{ pdf: "../archive/test.pdf" }], [{ pdf: "archive/test.pdf" }],
  ]) {
    let sources = 0;
    const documentsService = new PolicyDocuments({
      manifest: async () => Buffer.from(JSON.stringify({ documents })),
      source: async () => { sources++; throw new Error("Unexpected source read"); },
    });
    await assert.rejects(documentsService.get(file, "search", true), /Duplicate|Invalid/);
    assert.equal(sources, 0);
  }
});

test("warming validates active count, uses a durable submission bound and never automatically retries failures", async () => {
  const f = await fixture();
  try {
    await assert.rejects(warmNativePreviewBundle({ ...f.options, expectedFiles: 21 }), /Expected 21 active PDFs/);
    assert.equal(f.calls.length, 0);
    await assert.rejects(warmNativePreviewBundle({
      ...f.options,
      analyze: async (analyzer) => {
        if (analyzer === "prebuilt-digitalParse") {
          f.calls.push(analyzer);
          const error = new Error("Native operation failed") as Error & { response: unknown };
          error.response = { status: "Failed", error: { code: "ExampleFailure" } };
          throw error;
        }
        return f.options.analyze(analyzer);
      },
    }), /Native operation failed/);
    const ledger = JSON.parse(await readFile(f.options.ledgerFile, "utf8"));
    assert.equal(ledger.attempts.length, 2);
    assert.match(ledger.attempts[1].error, /Native operation failed/);
    const failures = (await readdir(f.root)).filter((name) => name.endsWith(".failure.json"));
    assert.equal(failures.length, 1);
    const failure = JSON.parse(await readFile(path.join(f.root, failures[0]), "utf8"));
    assert.deepEqual(failure.response, { status: "Failed", error: { code: "ExampleFailure" } });
    await assert.rejects(warmNativePreviewBundle(f.options), /earlier submission/);
    assert.equal(f.calls.length, 2);
    await assert.rejects(warmNativePreviewBundle({ ...f.options, maxAnalyses: 3 }), /at most two analyses/);
  } finally { await f.cleanup(); }
});

test("native export refuses credential-bearing or signed URLs without rewriting raw outputs", () => {
  for (const url of ["https://example.blob.core.windows.net/a?sv=1&sig=secret",
    "https://user:password@example.com/a", "https://example.com/a?api-key=secret"])
    assert.throws(() => assertPortableNativeResponse({ url }), /credential or signed URL/);
  assert.doesNotThrow(() => assertPortableNativeResponse({
    markdown: table, url: "https://example.com/public.pdf",
  }));
});

test("warming never exceeds a smaller approved budget and refuses a concurrent exporter", async () => {
  const f = await fixture();
  try {
    await assert.rejects(warmNativePreviewBundle({ ...f.options, maxAnalyses: 1 }), /budget exhausted/);
    assert.deepEqual(f.calls, ["prebuilt-documentSearch"]);
    assert.equal(JSON.parse(await readFile(f.options.ledgerFile, "utf8")).attempts.length, 1);
    await assert.rejects(warmNativePreviewBundle({ ...f.options, maxAnalyses: 1 }), /budget exhausted/);
    assert.equal(f.calls.length, 1);
    await writeFile(`${f.options.ledgerFile}.lock`, JSON.stringify({ pid: process.pid }));
    await assert.rejects(warmNativePreviewBundle(f.options), /already locked/);
    assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

test("committed native previews cover both representations of every active PDF with no settings or Azure access", async () => {
  let settingsCalls = 0, analyses = 0;
  const documents = new PolicyDocuments({
    settings: async () => { settingsCalls++; throw new Error("Offline previews cannot require configuration."); },
    analyze: async () => { analyses++; throw new Error("Offline previews cannot submit analyses."); },
  });
  const active = await documents.files();
  const bundle = await documents.bundleManifest();
  assert.ok(bundle, "The committed native preview bundle is required.");
  assert.equal(bundle.documents.length, active.length);
  assert.equal(bundle.entries.length, active.length * 2);
  for (const file of active) {
    for (const mode of ["search", "digital"] as const) {
      const value = await documents.get(file, mode);
      assert.ok(value.available && value.cached);
      assert.equal(value.analyzer, mode === "search" ? "prebuilt-documentSearch" : "prebuilt-digitalParse");
      const entry: NativePreviewManifest["entries"][number] | undefined =
        bundle.entries.find((candidate) => candidate.file === file && candidate.mode === mode);
      assert.ok(entry);
      const payload = await readFile(path.join(nativePreviewFolder, entry.responseFile), "utf8");
      assertPortableNativeResponse(JSON.parse(payload));
    }
  }
  assert.equal(settingsCalls, 0);
  assert.equal(analyses, 0);
});
