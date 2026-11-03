import assert from "node:assert/strict";
import { once } from "node:events";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Cache, dataset } from "./batch.ts";
import { cacheFolders, dataRoot, repositoryRoot } from "./config.ts";
import { policyDemo, readPolicyDemo } from "./policy-demo.ts";
import { frameworkConfigSchema, PolicyService, type PolicyItem } from "./policy-service.ts";
import { createApp } from "./server.ts";

async function appSession(t: TestContext, policy: PolicyService, cache = new Cache()) {
  let cloudCalls = 0;
  const noCloud = async (): Promise<never> => {
    cloudCalls++;
    throw new Error("Offline cached results must not call Azure.");
  };
  const server = createApp({ detail: noCloud, analyze: noCloud }, { policy, cache })
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

test("a fresh machine loads the current bundled policy reviews without Azure or local configuration", async (t) => {
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
  assert.equal(status.bundledDemo.staleDataset, false);
  const demo = await policyDemo();
  const current = await dataset();
  assert.equal(demo.info.datasetHash, current.datasetHash);
  const runs = await (await request("cache")).json();
  assert.ok(runs.some((run: { datasetHash: string }) =>
    run.datasetHash === current.datasetHash));
  const load = await request("cache/load", { runId: demo.info.runId });
  assert.equal(load.status, 200);
  const saved = await request("policy/cache/load", {
    runId: demo.info.runId, mode: "search", source: "bundled",
  });
  assert.equal(saved.status, 200);
  const payload = await saved.json();
  assert.equal(payload.source, "bundled");
  assert.equal(payload.staleDataset, false);
  assert.equal(payload.extractionMode, "standard");
  assert.equal(payload.items.length, 10);
  assert.ok(payload.items.every((item: PolicyItem) =>
    item.status === "completed" && item.result?.Checks.length === 5));
  const chat = await request(`policy/chat?${new URLSearchParams({
    runId: demo.info.runId, packetId: "packet-01", mode: "search", check: "Amount",
  })}`);
  assert.equal(chat.status, 409);
  assert.match((await chat.json()).error, /configure Agent Framework/);
  assert.equal(cloudCalls(), 0);
  assert.deepEqual(await readdir(folder), [], "No local config or cache files should be created.");
});

test("the bundled payload remains internally valid for its original included run", async () => {
  const demo = await policyDemo();
  const cache = new Cache();
  const run = await cache.load(demo.info.runId);
  const bundled = demo.results(run);
  assert.equal(bundled.items.length, 10);
  assert.ok(bundled.items.every((item: PolicyItem) =>
    item.status === "completed" &&
    item.result?.Checks.length === 5 &&
    item.indexName === demo.info.indexName &&
    item.citations?.flat().every((citation) => citation.href)));
  const data = await dataset();
  const current = (await cache.list()).find(
    (item) => item.status === "completed" &&
      item.datasetHash === data.datasetHash,
  );
  assert.ok(current);
  const matching = demo.results(current);
  assert.equal(matching.staleDataset, false);
  const stale = demo.results({ ...current, datasetHash: "f".repeat(64) });
  assert.equal(stale.runId, current.id);
  assert.equal(stale.sourceRunId, run.id);
  assert.equal(stale.staleDataset, true);
  assert.equal(stale.items.length, 10);
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

test("a selected cache root supplies extraction and policy results without falling back", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "lab664-selected-cache-"));
  const previous = process.env.WORKBENCH_CACHE_FOLDER;
  t.after(() => {
    if (previous === undefined) delete process.env.WORKBENCH_CACHE_FOLDER;
    else process.env.WORKBENCH_CACHE_FOLDER = previous;
  });
  t.after(() => rm(folder, { recursive: true, force: true }));
  await Promise.all(["results", "policy-demo"].map((name) =>
    cp(path.join(dataRoot, name), path.join(folder, name), { recursive: true })));
  process.env.WORKBENCH_CACHE_FOLDER = folder;
  const policy = new PolicyService({ config: async () => undefined });
  const { request, cloudCalls } = await appSession(t, policy);
  const status = await (await request("status")).json();
  assert.deepEqual(status.cache, cacheFolders(folder));
  const demo = await policyDemo();
  assert.equal((await request("cache/load", { runId: demo.info.runId })).status, 200);
  const response = await request("policy/cache/load", {
    runId: demo.info.runId, mode: "search", source: "bundled",
  });
  assert.equal(response.status, 200);
  const loaded = await response.json();
  assert.equal(loaded.cacheFolder, path.join(folder, "policy-demo"));
  assert.equal(loaded.items.length, 10);
  assert.equal(cloudCalls(), 0);

  process.env.WORKBENCH_CACHE_FOLDER = path.join(folder, "missing");
  const missing = await appSession(t, policy);
  assert.deepEqual(await (await missing.request("cache")).json(), []);
  const failure = await missing.request("policy/status");
  assert.equal(failure.status, 404);
  assert.match((await failure.json()).error, /No saved policy manifest/);
  assert.equal(missing.cloudCalls(), 0);
});

test("bundled reviews seed chat using the current lab agent without a live policy batch", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "lab664-cached-chat-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const bundledConfig = frameworkConfigSchema.parse(JSON.parse(await readFile(
    path.join(dataRoot, "policy-demo", "policy-agent-framework.json"), "utf8")));
  const config = {
    ...bundledConfig,
    azureOpenAIEndpoint: "https://current-lab.services.ai.azure.com",
    modelDeployment: "current-lab-model",
    indexName: "current-lab-index",
    indexFingerprint: "a".repeat(64),
  };
  const calls: unknown[] = [];
  const configPath = path.join(folder, "current-config.json");
  const policy = new PolicyService({
    config: async () => config, configPath, cacheFolder: folder,
    invoke: async (request) => {
      calls.push(request);
      assert.ok(request && typeof request === "object" && "chat" in request && "configPath" in request);
      assert.equal(request.chat, true);
      assert.equal(request.configPath, configPath);
      return {
        provider: "agent-framework", status: "completed", mode: "search",
        retrievalCalls: 1, retrieved: [],
        result: { Answer: "Follow-up from the configured lab agent.", Citation: [] },
      };
    },
  });
  const { request, cloudCalls } = await appSession(t, policy);
  const demo = await policyDemo();
  assert.equal((await request("cache/load", { runId: demo.info.runId })).status, 200);
  assert.equal((await request("policy/cache/load", {
    runId: demo.info.runId, mode: "search", source: "bundled",
  })).status, 200);
  const selection = { runId: demo.info.runId, packetId: "packet-01", mode: "search", check: "Amount" };
  const response = await request(`policy/chat?${new URLSearchParams(selection)}`);
  assert.equal(response.status, 200, await response.clone().text());
  const context = await response.json();
  assert.equal(context.agent.indexName, config.indexName);
  assert.equal(context.agent.modelDeployment, config.modelDeployment);
  assert.equal(context.promptSource, "saved");
  assert.equal(context.messages[0].content, context.prompt);
  const savedCheck = demo.results(await new Cache().load(demo.info.runId))
    .items.find((item) => item.id === selection.packetId)?.result?.Checks.find((check) => check.Check === selection.check);
  assert.ok(savedCheck);
  assert.deepEqual(context.result.Checks, [savedCheck]);
  assert.equal(calls.length, 0, "Opening a cached chat must not start an agent.");
  const reply = await request("policy/chat", {
    ...selection, contextId: context.contextId, message: "Explain the saved finding.", live: true,
  });
  assert.equal(reply.status, 200, await reply.clone().text());
  assert.equal((await reply.json()).text, "Follow-up from the configured lab agent.");
  assert.equal(calls.length, 1);
  assert.equal(cloudCalls(), 0);
  assert.deepEqual(await readdir(folder), [], "Chat must not generate claim or review caches.");

  class StaleCache extends Cache {
    override async load(id: string) {
      const run = await super.load(id);
      return { ...run, analyzer: { ...run.analyzer, fingerprint: "f".repeat(64) } };
    }
  }
  const stale = await appSession(t, policy, new StaleCache());
  await stale.request("cache/load", { runId: demo.info.runId });
  await stale.request("policy/cache/load", { runId: demo.info.runId, mode: "search", source: "bundled" });
  const rejected = await stale.request(`policy/chat?${new URLSearchParams(selection)}`);
  assert.equal(rejected.status, 409);
  assert.match((await rejected.json()).error, /do not match this extraction run/);
  assert.equal(calls.length, 1, "Stale reviews must not invoke an agent.");
});
