import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Cache } from "./batch.ts";
import { dataRoot } from "./config.ts";
import { CuOperationError } from "./cu.ts";
import { DocumentService } from "./documents.ts";
import { statementFields } from "./definitions.ts";
import { createApp } from "./server.ts";
import { diagnose, triageInput } from "./triage.ts";

async function fixture(generatedNarratives = false, packetIndex = 0) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "lab664-doc-test-"));
  const source = new Cache();
  const run = (await source.list()).find((run) => run.status === "completed")!;
  const packet = run.source[packetIndex];
  const response = await source.raw(run.id, packet.id);
  run.id = randomUUID();
  run.items = [{ id: packet.id, status: "completed", rawSaved: true }];
  run.source = [packet];
  const cache = new Cache(folder);
  await cache.save(run);
  await cache.raw(run.id, packet.id, response);
  let calls = 0;
  let name = "Danielle Ortiz";
  let failure = false;
  let empty = false;
  const client = {
    async detail() {
      return {
        status: "ready",
        config: { enableSegment: false },
        fieldSchema: {
          fields: Object.fromEntries(
            Object.entries(statementFields).map(([name, type]) => [
              name,
              {
                type,
                method:
                  generatedNarratives &&
                  ["reported_damage", "summary"].includes(name)
                    ? "generate"
                    : "extract",
              },
            ]),
          ),
        },
      };
    },
    async analyze(_id: string, bytes: Buffer) {
      calls++;
      assert.deepEqual(
        bytes,
        await readFile(
          path.join(dataRoot, "documents", packet.id, "06-handwriting.pdf"),
        ),
      );
      if (failure)
        throw new CuOperationError("Offline fixture failure", {
          status: "failed",
        });
      if (empty)
        return {
          result: { contents: [{ path: "input1", markdown: "Layout only" }] },
        };
      return {
        result: {
          contents: [
            {
              path: "input1",
              analyzerId: "test_statement",
              markdown: "Fictional claimant statement",
              pages: [{ pageNumber: 1, width: 8, height: 11 }],
              fields: {
                claimant_name: {
                  type: "string",
                  valueString: name,
                  source: "D(1,1,1,2,1,2,2,1,2)",
                },
                incident_date: { type: "date", valueDate: "2026-02-12" },
                vehicle: { type: "string", valueString: "2022 Honda CR-V EX" },
              },
            },
          ],
        },
      };
    },
  };
  return {
    folder,
    cache,
    run,
    packet,
    response,
    client,
    service: new DocumentService(client, cache),
    calls: () => calls,
    setName: (value: string) => {
      name = value;
    },
    fail: () => {
      failure = true;
    },
    empty: () => {
      failure = false;
      empty = true;
    },
    clean: () => rm(folder, { recursive: true }),
  };
}

test("document reruns are fresh unsaved previews and never change baseline fields or policies", async () => {
  const f = await fixture(true);
  try {
    const baseline = await f.service.review(f.run, f.packet);
    const files = await readdir(f.folder, { recursive: true });
    const first = await f.service.analyze(
      f.run,
      f.packet,
      "06-handwriting",
      "statement",
      "test_statement",
    );
    f.setName("D. Ortiz");
    const second = await f.service.analyze(
      f.run,
      f.packet,
      "06-handwriting",
      "statement",
      "test_statement",
    );
    assert.equal(f.calls(), 2);
    assert.notEqual(first.id, second.id);
    assert.equal(second.cached, false);
    assert.equal(second.persisted, false);
    assert.equal(second.documents[0].document.facts[0].value, "D. Ortiz");
    assert.equal(second.documents[0].document.facts[0].regions[0].page, 9);
    assert.equal(first.documents[0].document.facts[0].value, "Danielle Ortiz");
    assert.deepEqual(await f.service.review(f.run, f.packet), baseline);
    assert.deepEqual(await f.cache.raw(f.run.id, f.packet.id), f.response);
    assert.deepEqual(await readdir(f.folder, { recursive: true }), files);
  } finally {
    await f.clean();
  }
});

test("legacy saved reruns are not overlaid onto the original cached packet", async () => {
  const f = await fixture();
  try {
    const baseline = await f.service.review(f.run, f.packet);
    const id = randomUUID();
    const directory = path.join(f.service.folder, id);
    await mkdir(directory, { recursive: true });
    const bytes = await readFile(
      path.join(dataRoot, "documents", f.packet.id, "06-handwriting.pdf"),
    );
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        id,
        parentRunId: f.run.id,
        packetId: f.packet.id,
        sourceId: "06-handwriting",
        category: "statement",
        status: "completed",
        startedAt: new Date().toISOString(),
        packetSha256: f.packet.sha256,
        inputSha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
    await writeFile(
      path.join(directory, "response.json"),
      JSON.stringify({
        result: {
          contents: [
            {
              analyzerId: "legacy_statement",
              fields: {
                claimant_name: {
                  type: "string",
                  valueString: "Cached Wrong Name",
                },
              },
            },
          ],
        },
      }),
    );
    assert.deepEqual(await f.service.review(f.run, f.packet), baseline);
    assert.equal(f.calls(), 0);
  } finally {
    await f.clean();
  }
});

test("failed, empty and stale preview requests do not write successful or failed caches", async () => {
  const f = await fixture();
  try {
    const files = await readdir(f.folder, { recursive: true });
    await assert.rejects(
      f.service.analyze(
        { ...f.run, datasetHash: "stale" },
        f.packet,
        "06-handwriting",
        "statement",
        "test_statement",
      ),
      /current packet dataset/,
    );
    const bad = new DocumentService(
      {
        ...f.client,
        async detail() {
          return {
            status: "ready",
            config: { enableSegment: false },
            fieldSchema: {
              fields: { vin: { type: "number", method: "extract" } },
            },
          };
        },
      },
      f.cache,
    );
    await assert.rejects(
      bad.analyze(f.run, f.packet, "06-handwriting", "statement", "bad_schema"),
      /seven fields/,
    );
    assert.equal(f.calls(), 0);
    f.fail();
    await assert.rejects(
      f.service.analyze(
        f.run,
        f.packet,
        "06-handwriting",
        "statement",
        "test_statement",
      ),
      /Offline fixture failure/,
    );
    f.empty();
    await assert.rejects(
      f.service.analyze(
        f.run,
        f.packet,
        "06-handwriting",
        "statement",
        "test_statement",
      ),
      /no extraction fields/,
    );
    assert.deepEqual(await readdir(f.folder, { recursive: true }), files);
    assert.deepEqual(await f.cache.raw(f.run.id, f.packet.id), f.response);
  } finally {
    await f.clean();
  }
});

test("HTTP source reruns require confirmation, return two fresh previews, and preserve cached results", async () => {
  const f = await fixture();
  const server = createApp(f.client, { cache: f.cache }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  try {
    const session = await (
      await fetch(`${root}/api/session`, { method: "POST" })
    ).json();
    const headers = {
      "Content-Type": "application/json",
      "x-labmachine-session": session.sessionId,
    };
    const post = (route: string, body: unknown) =>
      fetch(`${root}/api/${route}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    assert.equal((await fetch(`${root}/api/review/packet-01`)).status, 401);
    const loaded = await (await post("cache/load", { runId: f.run.id })).json();
    assert.equal(loaded.packetResults.length, 1);
    assert.ok(loaded.packetResults[0].policyReview);
    const baseline = await (
      await fetch(`${root}/api/packet/packet-01`, { headers })
    ).json();
    assert.equal(
      (await post("document/packet-01", { sourceId: "06-handwriting" })).status,
      400,
    );
    for (let index = 0; index < 2; index++) {
      const response = await post("document/packet-01", {
        live: true,
        sourceId: "06-handwriting",
      });
      assert.equal(response.status, 200);
      const value = await response.json();
      assert.equal(value.preview.persisted, false);
      assert.equal(value.preview.sourceId, "06-handwriting");
    }
    assert.equal(f.calls(), 2);
    assert.deepEqual(
      await (await fetch(`${root}/api/packet/packet-01`, { headers })).json(),
      baseline,
    );
    assert.deepEqual(await f.cache.raw(f.run.id, f.packet.id), f.response);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await f.clean();
  }
});

test("Cache Results preloads saved LLM reviews; fresh review previews cannot replace them", async () => {
  const f = await fixture(false, 6);
  let reviews = 0;
  let serial = 0;
  const report = await f.service.review(f.run, f.packet);
  const check = report.policies.checks.find(
    (check) => check.status === "fail",
  )!;
  const input = triageInput(report, check.id);
  const baseline = await diagnose(input, f.service.folder, {
    settings: {
      endpoint: f.run.endpoint,
      apiVersion: f.run.apiVersion,
      port: 8791,
    },
    token: async () => "offline-fixture",
    fetch: async () =>
      Response.json({
        id: "fixture",
        status: "completed",
        model: "gpt-6.1-sol",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  category: "extraction_error",
                  reason: "Offline fixture",
                  suggestion: "Inspect source",
                  documentIds: input.documents.map((doc) => doc.id),
                }),
              },
            ],
          },
        ],
      }),
  });
  const server = createApp(f.client, {
    cache: f.cache,
    diagnose: async (value, _folder, transport) => {
      reviews++;
      assert.equal(transport?.refresh, true);
      assert.equal(transport?.persist, false);
      return {
        id: `preview-${serial++}`,
        model: "gpt-5.5",
        deployment: "gpt-5.5",
        cached: false,
        advisoryOnly: true,
        category: "extraction_error",
        reason: "Offline preview",
        suggestion: "Inspect source",
        documentIds: value.documents.map((doc) => doc.id),
      };
    },
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  try {
    const session = await (
      await fetch(`${root}/api/session`, { method: "POST" })
    ).json();
    const headers = {
      "Content-Type": "application/json",
      "x-labmachine-session": session.sessionId,
    };
    const post = (route: string, body: unknown) =>
      fetch(`${root}/api/${route}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    const loaded = await (await post("cache/load", { runId: f.run.id })).json();
    assert.equal(
      loaded.packetResults[0].policyReview.diagnoses[check.id].result.id,
      baseline.id,
    );
    assert.equal(reviews, 0);
    const files = await readdir(f.service.folder, { recursive: true });
    const first = await (
      await post(`checks/${f.packet.id}`, { run: true, refresh: true })
    ).json();
    const second = await (
      await post(`checks/${f.packet.id}`, { run: true, refresh: true })
    ).json();
    assert.notEqual(
      first.diagnoses[check.id].result.id,
      second.diagnoses[check.id].result.id,
    );
    assert.equal(reviews, 2);
    const reloaded = await (
      await post("cache/load", { runId: f.run.id })
    ).json();
    assert.equal(
      reloaded.packetResults[0].policyReview.diagnoses[check.id].result.id,
      baseline.id,
    );
    assert.deepEqual(
      reloaded.packetResults[0].policies,
      loaded.packetResults[0].policies,
    );
    assert.deepEqual(
      await readdir(f.service.folder, { recursive: true }),
      files,
    );
    assert.equal(f.calls(), 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await f.clean();
  }
});
