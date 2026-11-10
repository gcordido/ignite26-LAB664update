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
import { canonical, parseSourceDigest } from "./policy-core.ts";

test("Parse source integrity survives Git LF/CRLF checkout conversion without accepting content changes", () => {
  const source = '{\n  "lossDate": "2026-02-12"\n}\n';
  assert.equal(parseSourceDigest(source), parseSourceDigest(source.replace(/\n/g, "\r\n")));
  assert.notEqual(parseSourceDigest(source), parseSourceDigest(source.replace("2026-02-12", "2026-02-13")));
});

test("earlier three, four and five-check bundles are history-only, not reinterpreted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "policy-five-check-history-"));
  try {
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1 }));
    await assert.rejects(readPolicyDemo(root), /three\/four\/five-check.*history-only/);
    for (const checkContractVersion of [3, 4]) {
      await writeFile(path.join(root, "manifest.json"), JSON.stringify({ schemaVersion: 2, checkContractVersion }));
      await assert.rejects(readPolicyDemo(root), /history-only.*pruned three-comparison/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruned three-check bundle uses hash-verified first-pass Parse without a summary cache", async () => {
  const folder = path.join(repositoryRoot, "data", "policy-demo");
  const demo = await readPolicyDemo(folder);
  const manifest = JSON.parse(await readFile(path.join(folder, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.checkContractVersion, 5);
  assert.deepEqual(manifest.checks, ["Daily rate", "Effective terms", "Repair estimate"]);
  assert.equal(manifest.files.length, 21);
  assert.equal(manifest.sourceFiles.length, 11);
  assert.equal(manifest.sourceHashFormat, "utf8-lf");
  assert.ok(manifest.files.every(({ name }: { name: string }) => !name.startsWith("claim-")));
  assert.equal(demo.sourceCache.folder, path.join(repositoryRoot, "data", "results"));
  assert.equal(demo.results(demo.sourceRun).items.length, 10);
  assert.equal(demo.results(demo.sourceRun).items.flatMap(item => item.result?.Checks ?? []).length, 30);
  const savedReviews = await Promise.all(manifest.files
    .filter(({ name }: { name: string }) => name.startsWith("framework-saved-"))
    .map(async ({ name }: { name: string }) => JSON.parse(await readFile(path.join(folder, name), "utf8"))));
  assert.deepEqual(demo.results(demo.sourceRun).items.map(item => canonical(item.result)).sort(),
    savedReviews.map(saved => canonical(saved.raw.result)).sort(),
    "Follow-up runtime changes must preserve generated review outcomes, not relabel or regenerate them.");
});

test("bundled comparisons use Texas 75, Washington 85 and the original Illinois policy VIN", async () => {
  const demo = await readPolicyDemo(path.join(repositoryRoot, "data", "policy-demo"));
  const items = demo.results(demo.sourceRun).items;
  for (const [id, rate, cap] of [["packet-01", "54", "75"], ["packet-02", "61", "85"]]) {
    const check = items.find((item) => item.id === id)?.result?.Checks[0];
    assert.equal(check?.Check, "Daily rate");
    assert.equal(check.Outcome, "Satisfied");
    assert.ok(check.Comparisons?.some((pair) => pair.ClaimValue.includes(rate) && pair.PolicyValue.includes(cap)));
  }
  const terms = items.find((item) => item.id === "packet-06")?.result?.Checks[1];
  assert.equal(terms?.Check, "Effective terms");
  assert.equal(terms.Outcome, "Satisfied");
  assert.ok(terms.Comparisons?.some((pair) =>
    pair.ClaimValue === "1FMCU0G63MA514686" && pair.PolicyValue === pair.ClaimValue));
  assert.ok(terms.Citation.some((citation) => citation.File === "effective-date-il-packet-06.pdf"));
});

test("all eleven original repair quotes use their loss-state diagram, independently of rental", async () => {
  const demo = await readPolicyDemo(path.join(repositoryRoot, "data", "policy-demo"));
  const items = demo.results(demo.sourceRun).items;
  const expected = [
    { state: "TX", gross: [2233.8], threshold: 2500 },
    { state: "WA", gross: [1842], threshold: 1750 },
    { state: "AZ", gross: [1699.04, 1827.24], threshold: 2500 },
    { state: "CO", gross: [2002.38], threshold: 2500 },
    { state: "FL", gross: [1310.13], threshold: 2000 },
    { state: "IL", gross: [2728.13], threshold: 3000 },
    { state: "LA", gross: [13219.35], threshold: 10000 },
    { state: "CA", gross: [1691.08], threshold: 2000 },
    { state: "NY", gross: [3614.16], threshold: 4000 },
    { state: "OH", gross: [3711.7], threshold: 4000 },
  ];
  for (const [index, source] of expected.entries()) {
    const item = items.find(item => item.id === `packet-${String(index + 1).padStart(2, "0")}`);
    const check = item?.result?.Checks[2];
    assert.equal(check?.Check, "Repair estimate");
    assert.equal(check.Outcome, source.gross.some(amount => amount > source.threshold)
      ? "ReviewRequired" : "Satisfied", item?.id ?? `packet index ${index}`);
    const values = check.Comparisons?.map(pair => pair.ClaimValue.replaceAll(",", "")) ?? [];
    for (const amount of source.gross)
      assert.ok(values.some(value => value.includes(String(amount))), `${item?.id}: gross ${amount}`);
    assert.ok(check.Comparisons?.some(pair => pair.PolicyValue.replaceAll(",", "").includes(String(source.threshold))));
    assert.ok(check.Citation.some(citation => citation.RuleId === `REPAIR-${source.state}-01`));
    const page = index < 5 ? 1 : 2;
    assert.ok(item?.citations?.[2].some(citation =>
      citation.File === "synthetic-repair-review-authority-v1.pdf" && citation.href?.endsWith(`#page=${page}`)));
  }
  const arizona = items.find(item => item.id === "packet-03")?.result?.Checks[2];
  assert.ok((arizona?.Comparisons?.length ?? 0) >= 2, "Distinct Arizona quotes are compared separately, never summed.");
  for (const id of ["packet-04", "packet-06", "packet-08", "packet-10"]) {
    const item = items.find(item => item.id === id);
    assert.equal(item?.result?.Checks[0].Outcome, "NotApplicable");
    assert.equal(item?.result?.Checks[2].Outcome, "Satisfied");
  }
});

async function extractionRun() {
  const data = await dataset();
  const run = (await new Cache().list()).find(
    (run) => run.status === "completed" && run.datasetHash === data.datasetHash,
  );
  assert.ok(run);
  return run;
}

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
  const demo = await policyDemo();
  assert.equal(status.bundledDemo.runId, demo.info.runId);
  const current = await dataset();
  assert.equal(demo.info.datasetHash, current.datasetHash);
  const runs = await (await request("cache")).json();
  assert.ok(runs.some((run: { datasetHash: string }) =>
    run.datasetHash === current.datasetHash));
  const selected = await extractionRun();
  const load = await request("cache/load", { runId: selected.id });
  assert.equal(load.status, 200);
  const saved = await request("policy/cache/load", {
    runId: selected.id, mode: "search", source: "bundled",
  });
  assert.equal(saved.status, 200);
  const payload = await saved.json();
  assert.equal(payload.source, "bundled");
  assert.equal(payload.sourceRunId, demo.info.runId);
  assert.equal(payload.staleDataset, undefined);
  assert.equal(payload.extractionMode, "layout");
  assert.equal(payload.items.length, 10);
  assert.ok(payload.items.every((item: PolicyItem) =>
    item.status === "completed" && item.result?.Checks.length === 3));
  const chat = await request(`policy/chat?${new URLSearchParams({
    runId: selected.id, packetId: "packet-01", mode: "search", check: "Daily rate",
  })}`);
  assert.equal(chat.status, 409);
  assert.match((await chat.json()).error, /configure Agent Framework/);
  assert.equal(cloudCalls(), 0);
  assert.deepEqual(await readdir(folder), [], "No local config or cache files should be created.");
});

test("the policy bundle preserves its own inputs independently of the selected CU run", async () => {
  const demo = await policyDemo();
  const run = demo.sourceRun;
  const bundled = demo.results(run);
  assert.equal(bundled.items.length, 10);
  assert.ok(bundled.items.every((item: PolicyItem) =>
    item.status === "completed" &&
    item.result?.Checks.length === 3 &&
    item.indexName === demo.info.indexName &&
    item.citations?.flat().every((citation) => citation.href)));
  const current = await extractionRun();
  const matching = demo.results(current);
  const refreshed = demo.results({
    ...current, datasetHash: "f".repeat(64),
    analyzer: { ...current.analyzer, fingerprint: "e".repeat(64) },
  });
  assert.equal(refreshed.runId, current.id);
  assert.equal(refreshed.sourceRunId, run.id);
  assert.equal(refreshed.sourceDatasetHash, run.datasetHash);
  assert.ok(!("staleDataset" in refreshed));
  assert.deepEqual(refreshed.items, matching.items);
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
  const selected = await extractionRun();
  await Promise.all([
    cp(path.join(dataRoot, "results", selected.id), path.join(folder, "results", selected.id), { recursive: true }),
    cp(path.join(dataRoot, "policy-demo"), path.join(folder, "policy-demo"), { recursive: true }),
  ]);
  process.env.WORKBENCH_CACHE_FOLDER = folder;
  const policy = new PolicyService({ config: async () => undefined });
  const { request, cloudCalls } = await appSession(t, policy);
  const status = await (await request("status")).json();
  assert.deepEqual(status.cache, cacheFolders(folder));
  const demo = await policyDemo();
  assert.equal((await request("cache/load", { runId: selected.id })).status, 200);
  const response = await request("policy/cache/load", {
    runId: selected.id, mode: "search", source: "bundled",
  });
  assert.equal(response.status, 200);
  const loaded = await response.json();
  assert.equal(loaded.cacheFolder, path.join(folder, "policy-demo"));
  assert.equal(loaded.items.length, 10);
  assert.equal(loaded.sourceRunId, demo.info.runId);
  assert.equal(cloudCalls(), 0);

  const standalone = await readPolicyDemo(path.join(folder, "policy-demo"));
  assert.equal(standalone.results(selected).items.length, 10);

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
  const selected = await extractionRun();
  assert.equal((await request("cache/load", { runId: selected.id })).status, 200);
  assert.equal((await request("policy/cache/load", {
    runId: selected.id, mode: "search", source: "bundled",
  })).status, 200);
  const selection = { runId: selected.id, packetId: "packet-01", mode: "search", check: "Daily rate" };
  const response = await request(`policy/chat?${new URLSearchParams(selection)}`);
  assert.equal(response.status, 200, await response.clone().text());
  const context = await response.json();
  assert.equal(context.agent.indexName, config.indexName);
  assert.equal(context.agent.modelDeployment, config.modelDeployment);
  assert.equal(context.promptSource, "saved");
  assert.equal(context.messages[0].content, context.prompt);
  const savedCheck = demo.results(selected)
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

  class RefreshedCache extends Cache {
    override async load(id: string) {
      const run = await super.load(id);
      return { ...run, analyzer: { ...run.analyzer, fingerprint: "f".repeat(64) } };
    }
  }
  const refreshed = await appSession(t, policy, new RefreshedCache());
  await refreshed.request("cache/load", { runId: selected.id });
  await refreshed.request("policy/cache/load", { runId: selected.id, mode: "search", source: "bundled" });
  const reopened = await refreshed.request(`policy/chat?${new URLSearchParams(selection)}`);
  assert.equal(reopened.status, 200, await reopened.clone().text());
  assert.equal((await reopened.json()).contextId, context.contextId);
  const evidence = await refreshed.request(`policy/claim-evidence?${new URLSearchParams({
    runId: selected.id, packetId: selection.packetId, mode: "search",
  })}`);
  assert.equal(evidence.status, 200);
  const sourcePacket = demo.sourceRun.source.find((packet) => packet.id === selection.packetId);
  assert.ok(sourcePacket);
  assert.deepEqual(await evidence.json(), await demo.service.claimEvidence(
    demo.sourceRun, sourcePacket, await demo.sourceCache.raw(demo.sourceRun.id, selection.packetId),
  ));
  assert.equal(calls.length, 1, "Opening saved chat and evidence must not invoke an agent.");
  assert.equal(refreshed.cloudCalls(), 0);
});
