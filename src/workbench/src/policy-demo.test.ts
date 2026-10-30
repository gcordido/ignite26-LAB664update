import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { repositoryRoot } from "./config.ts";
import { policyDemo, readPolicyDemo } from "./policy-demo.ts";
import { PolicyService, type PolicyItem } from "./policy-service.ts";
import { createApp } from "./server.ts";

async function appSession(t: TestContext, policy: PolicyService) {
  let cloudCalls = 0;
  const noCloud = async (): Promise<never> => {
    cloudCalls++;
    throw new Error("Offline cached results must not call Azure.");
  };
  const server = createApp({ detail: noCloud, analyze: noCloud }, { policy })
    .listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/`;
  const session = await (await fetch(base + "session", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  })).json();
  return {
    cloudCalls: () => cloudCalls,
    async request(route: string, body?: unknown) {
      return fetch(base + route, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "x-labmachine-session": session.sessionId },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
  };
}

test("a fresh no-Azure configuration loads all ten bundled cases without restoring or writing caches", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "lab664-offline-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const policy = new PolicyService({
    configPath: path.join(folder, "missing-config.json"),
    cacheFolder: path.join(folder, "missing-cache"),
    invoke: async () => { throw new Error("Offline loading must never invoke a model."); },
  });
  const { request, cloudCalls } = await appSession(t, policy);
  const status = await (await request("policy/status")).json();
  assert.equal(status.configured, false);
  const { runId, indexName } = status.bundledDemo;
  const runs = await (await request("cache")).json();
  assert.ok(runs.some((run: { id: string }) => run.id === runId));
  const extractionResponse = await request("cache/load", { runId });
  assert.equal(extractionResponse.status, 200);
  const extracted = await extractionResponse.json();
  assert.equal(extracted.packetResults.length, 10);
  assert.ok(extracted.packetResults.every((packet: { packetJson: unknown }) => packet.packetJson));
  const available = await (await request("policy/cache")).json();
  assert.equal(available.entries.length, 1);
  assert.equal(available.entries[0].source, "bundled");
  assert.equal(available.entries[0].count, 10);
  const loadedResponse = await request("policy/cache/load", { runId, mode: "search", source: "bundled" });
  assert.equal(loadedResponse.status, 200);
  const loaded = await loadedResponse.json();
  assert.equal(loaded.source, "bundled");
  assert.equal(loaded.items.length, 10);
  assert.ok(loaded.items.every((item: PolicyItem) =>
    item.status === "completed" && item.result?.Checks.length === 5 &&
    item.indexName === indexName && item.citations?.flat().every((citation) => citation.href)));
  const refreshed = await (await request("cache/current")).json();
  assert.equal(refreshed.agentReviews.search.source, "bundled");
  assert.ok(refreshed.packetResults.every((packet: { claimSummaryPrepared: boolean }) => packet.claimSummaryPrepared));
  const results = await (await request("policy/results?mode=search")).json();
  assert.equal(results.source, "bundled");
  assert.equal(results.items.length, 10);
  const evidence = await (await request(`policy/claim-evidence?runId=${runId}&packetId=packet-01`)).json();
  assert.ok(evidence.fields.length > 0);
  const check = encodeURIComponent(loaded.items[0].result.Checks[0].Check);
  const chat = await request(`policy/chat?runId=${runId}&packetId=packet-01&mode=search&check=${check}`);
  assert.equal(chat.status, 409);
  assert.match((await chat.json()).error, /read-only/);
  assert.equal((await request("policy/batch", { mode: "search", live: true })).status, 409);
  assert.equal((await request("policy/results?mode=search")).status, 200);
  assert.equal((await request("policy/cache/load", { runId, mode: "ungrounded", source: "bundled" })).status, 404);
  assert.equal((await request("policy/cache/load", {
    runId: "00000000-0000-4000-8000-000000000000", mode: "search", source: "bundled",
  })).status, 409);
  assert.equal(cloudCalls(), 0);
  assert.deepEqual(await readdir(folder), [], "No local config or cache files should be created.");
});

test("compatible local live results remain preferred and bundled results retain their original index", async (t) => {
  const demo = await policyDemo();
  class LocalPolicy extends PolicyService {
    override async status() {
      return { configured: true, message: "Local live configuration", modes: {}, batchRunning: false };
    }
    override async snapshot(run: Parameters<PolicyService["snapshot"]>[0], mode: "search" | "ungrounded") {
      return run.items.map(({ id }): PolicyItem => ({
        id, status: mode === "search" ? "completed" : "not run",
        indexName: "new-live-index", cached: true,
      }));
    }
  }
  const { request } = await appSession(t, new LocalPolicy());
  const runId = demo.info.runId;
  assert.equal((await request("cache/load", { runId })).status, 200);
  const available = await (await request("policy/cache")).json();
  assert.equal(available.entries.length, 1);
  assert.equal(available.entries[0].indexName, "new-live-index");
  assert.equal(available.entries[0].source, undefined);
  const live = await (await request("policy/cache/load", { runId, mode: "search" })).json();
  assert.equal(live.source, undefined);
  assert.ok(live.items.every((item: PolicyItem) => item.indexName === "new-live-index"));
  const bundled = await (await request("policy/cache/load", { runId, mode: "search", source: "bundled" })).json();
  assert.ok(bundled.items.every((item: PolicyItem) => item.indexName === demo.info.indexName));
  await request("policy/cache/load", { runId, mode: "search" });
  const restored = await (await request("policy/results?mode=search")).json();
  assert.ok(restored.items.every((item: PolicyItem) => item.indexName === "new-live-index"));
});

test("bundled demo validation rejects duplicate entries and corrupt payloads", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "lab664-demo-validation-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "data", "policy-demo", "manifest.json"), "utf8"));
  const first = manifest.files[0];
  const second = manifest.files[1];
  manifest.files[1] = first;
  await writeFile(path.join(folder, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(readPolicyDemo(folder), /duplicate files/);
  manifest.files[1] = second;
  await writeFile(path.join(folder, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(folder, first.name), "{}");
  await assert.rejects(readPolicyDemo(folder), /checksum mismatch/);
});
