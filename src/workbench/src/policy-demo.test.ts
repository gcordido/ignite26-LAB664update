import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Cache, dataset } from "./batch.ts";
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

test("a customized packet dataset advertises the bundled demo as stale and read-only", async (t) => {
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
  assert.equal(status.bundledDemo.staleDataset, true);
  const demo = await policyDemo();
  const current = await dataset();
  assert.notEqual(demo.info.datasetHash, current.datasetHash);
  const runs = await (await request("cache")).json();
  assert.ok(runs.some((run: { datasetHash: string }) =>
    run.datasetHash === current.datasetHash));
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
  const stale = demo.results(current);
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
