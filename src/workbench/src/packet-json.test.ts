import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Cache, summarize } from "./batch.ts";
import { dataRoot } from "./config.ts";
import { packetJson } from "./packet-json.ts";
import { createApp } from "./server.ts";
import { packetMarkdown } from "./packet-markdown.ts";

async function includedRunId() {
  const run = (await new Cache().list()).find((item) => item.status === "completed");
  assert.ok(run, "An included completed CU run is required.");
  return run.id;
}

test("all saved packets export extracted evidence without authored reference facts", async () => {
  const cache = new Cache();
  const runId = await includedRunId();
  const run = await cache.load(runId);
  assert.equal(run.source.length, 10);
  for (const packet of run.source) {
    const raw = await cache.raw(runId, packet.id);
    const review = summarize(raw, packet, run.analyzer.mode);
    const exported = packetJson(raw, packet, run, review);
    assert.equal(exported.schema_version, "1.0");
    assert.equal(exported.packet_id, packet.id);
    assert.equal(exported.documents.length, review.segments.length);
    assert.ok(exported.extracted_text);
    assert.ok(exported.documents.some((doc) => doc.extractions.length > 0));
    const serialized = JSON.stringify(exported);
    assert.equal(JSON.parse(serialized).packet_id, packet.id);
    assert.ok(!serialized.includes('"expectedRepair"'));
    assert.ok(!serialized.includes('"boundaryMatches"'));
    assert.ok(!serialized.includes('"expectedDocuments"'));
    // Changing authored identity and expected repair facts must not change the export.
    const changed = {
      ...packet,
      claimId: "DO-NOT-EXPORT-AUTHORED-CLAIM",
      expectedRepair: { vehicle: "DO-NOT-EXPORT", vin: "DO-NOT-EXPORT", odometer: -1 },
    };
    assert.deepEqual(packetJson(raw, changed, run, review), exported);
    const markdown = packetMarkdown(exported);
    assert.ok(markdown.startsWith("---\n"));
    assert.ok(markdown.includes('\n---\n\n# Claim packet ' + packet.id));
    assert.ok(markdown.includes('"customer":'));
    assert.ok(markdown.includes('"supplemental_tax":'));
    assert.ok(markdown.includes("## Customer"));
    for (const key of ["source", "confidence", "regions", "polygon", "pages", "content_path", "analysis"])
      assert.ok(!markdown.includes(`"${key}":`), key);
    assert.ok(!markdown.includes("## Extracted document text"));
    assert.equal(markdown, packetMarkdown(packetJson(raw, changed, run, review)));
  }
});

test("packet API exposes the standard export only for the session's saved run", async (t) => {
  const runId = await includedRunId();
  const noAzureCall = async () => {
    throw new Error("This check must not call Azure.");
  };
  const app = createApp({ detail: noAzureCall, analyze: noAzureCall });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/api/packet/packet-01`)).status, 401);
  const sessionResponse = await fetch(`${base}/api/session`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  const session = await sessionResponse.json();
  const headers = {
    "Content-Type": "application/json",
    "x-labmachine-session": session.sessionId,
  };
  assert.equal((await fetch(`${base}/api/packet/packet-01`, { headers })).status, 409);
  const load = await fetch(`${base}/api/cache/load`, {
    method: "POST", headers, body: JSON.stringify({ runId }),
  });
  assert.equal(load.status, 200);
  const response = await fetch(`${base}/api/packet/packet-01`, { headers });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.packetJson.packet_id, "packet-01");
  assert.equal(result.packetJson.schema_version, "1.0");
  assert.ok(result.review);
  assert.ok(result.response);
  assert.equal(result.packetJsonError, undefined);
  assert.ok(result.packetMarkdown.startsWith("---\n"));
  assert.ok(result.packetMarkdown.includes("# Claim packet packet-01"));
});

test("nested objects, arrays, null, false, zero and provenance survive export", async () => {
  const runId = await includedRunId();
  const run = await new Cache().load(runId);
  const packet = run.source[0];
  const raw = JSON.parse(
    await readFile(path.join(dataRoot, "results", runId, `${packet.id}.cu.json`), "utf8"),
  );
  const content = raw.result.contents.find(
    (item: { fields?: unknown }) => item.fields,
  );
  content.fields.ExportTest = {
    type: "object",
    valueObject: {
      Missing: { type: "string" },
      No: { type: "boolean", valueBoolean: false, confidence: 0 },
      Zero: { type: "number", valueNumber: 0 },
      EmptyString: { type: "string", valueString: "" },
      EmptyArray: { type: "array", valueArray: [] },
      Rows: {
        type: "array",
        valueArray: [
          {
            type: "object",
            valueObject: {
              Amount: { type: "number", valueNumber: 54 },
              Code: { type: "string", valueString: "USD" },
            },
          },
        ],
      },
    },
  };
  const review = summarize(raw, packet, run.analyzer.mode);
  const exported = packetJson(raw, packet, run, review);
  const extraction = exported.documents
    .flatMap((doc) => doc.extractions)
    .find((doc) => Object.hasOwn(doc.fields, "ExportTest"));
  assert.ok(extraction);
  assert.deepEqual(extraction.fields.ExportTest, {
    Missing: null, No: false, Zero: 0, EmptyString: "", EmptyArray: [],
    Rows: [{ Amount: 54, Code: "USD" }],
  });
  assert.equal(extraction.evidence.find((fact) => fact.field === "ExportTest.No")?.confidence, 0);
  assert.ok(extraction.evidence.some((fact) => fact.regions.length > 0));
  const markdown = packetMarkdown(exported);
  for (const expected of [
    '"No": false', '"Zero": 0',
  ]) assert.ok(markdown.includes(expected), expected);
  for (const name of ["Missing", "EmptyString", "EmptyArray"])
    assert.ok(!markdown.includes(`"${name}":`));
  exported.documents[0].extracted_text = '---\n"unsafe": true\n````\n# Raw heading';
  const safe = packetMarkdown(exported);
  assert.ok(!safe.includes('"unsafe"'));
  content.fields.Unsupported = { type: "custom", valueCustom: "do not discard" };
  assert.throws(
    () => packetJson(raw, packet, run, summarize(raw, packet, run.analyzer.mode)),
    /Unsupported CU value type/,
  );
});
