import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { Cache } from "./batch.ts";
import { PolicyService, type PolicyItem, type PolicyJob } from "./policy-service.ts";
import { createApp } from "./server.ts";

test("refresh resumes the owning session's policy job and duplicate starts don't submit again", async (t) => {
  const cache = new Cache();
  const saved = (await cache.list()).find((run) => run.status === "completed");
  assert.ok(saved, "An included completed run is required");
  let starts = 0;
  let release!: () => void;
  const task = new Promise<void>((resolve) => { release = resolve; });
  const job: PolicyJob = {
    id: "test-job", runId: saved.id, mode: "ungrounded", status: "running",
    startedAt: new Date().toISOString(), items: [{ id: "packet-01", status: "extracting" }],
  };
  class DeferredPolicy extends PolicyService {
    override async status() {
      return { configured: true, message: "Test configuration", modes: {}, batchRunning: job.status === "running" };
    }
    override async start() {
      starts++;
      return { job, task };
    }
  }
  const server = createApp(undefined, { cache, policy: new DeferredPolicy() }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("saved policy picker and load read compatible snapshots without starting an agent", async (t) => {
    const cache = new Cache();
    const saved = (await cache.list()).find((run) => run.status === "completed");
    assert.ok(saved);
    const completedAt = new Date().toISOString();
    let snapshots = 0;
    class CachedPolicy extends PolicyService {
      override async status() {
        return { configured: true, message: "Test configuration", modes: {}, batchRunning: false };
      }
      override async snapshot(_run: Parameters<PolicyService["snapshot"]>[0], mode: "search" | "ungrounded") {
        snapshots++;
        return saved!.items.map(({ id }, index): PolicyItem => ({
          id, status: mode === "search" && index === 0 ? "completed" : "not run",
          ...(mode === "search" && index === 0 ? { cached: true, completedAt, indexName: "test-index" } : {}),
        }));
      }
      override async start(): ReturnType<PolicyService["start"]> {
        throw new Error("Loading saved checks must never start an agent.");
      }
    }
    const server = createApp(undefined, { cache, policy: new CachedPolicy() }).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/`;
    const session = await (await fetch(base + "session", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    })).json();
    async function request(route: string, body?: unknown) {
      return fetch(base + route, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "x-labmachine-session": session.sessionId },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    assert.equal((await request("policy/cache")).status, 409);
    assert.equal((await request("cache/load", { runId: saved.id })).status, 200);
    const list = await (await request("policy/cache")).json();
    assert.equal(list.runId, saved.id);
    assert.deepEqual(list.entries, [{
      mode: "search", count: 1, total: saved.items.length, completedAt, indexName: "test-index",
    }]);
    const loaded = await (await request("policy/cache/load", { runId: saved.id, mode: "search" })).json();
    assert.equal(loaded.cached, true);
    assert.equal(loaded.items[0].cached, true);
    assert.equal(loaded.items.filter((item: PolicyItem) => item.status === "completed").length, 1);
    assert.equal((await request("policy/cache/load", { runId: saved.id, mode: "ungrounded" })).status, 404);
    assert.equal((await request("policy/cache/load", {
      runId: "00000000-0000-4000-8000-000000000000", mode: "search",
    })).status, 409);
    assert.equal((await request("policy/cache/load", { runId: saved.id, mode: "invalid" })).status, 400);
    assert.ok(snapshots > 0);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/`;
  async function request(route: string, sessionId = "", body?: unknown) {
    return fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "x-labmachine-session": sessionId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const { sessionId } = await (await request("session", "", {})).json();
  assert.equal((await request("cache/load", sessionId, { runId: saved.id })).status, 200);
  assert.equal((await request("policy/batch", sessionId, { mode: "ungrounded", live: true })).status, 202);
  const resumed = await (await request("session", sessionId, {})).json();
  assert.equal(resumed.sessionId, sessionId);
  assert.equal(resumed.runId, saved.id);
  assert.equal(resumed.policyMode, "ungrounded");
  const progress = await (await request("policy/results?mode=ungrounded", sessionId)).json();
  assert.equal(progress.id, job.id);
  assert.equal(progress.items[0].status, "extracting");
  assert.equal((await request("policy/batch", sessionId, { mode: "ungrounded", live: true })).status, 202);
  assert.equal(starts, 1);
  assert.equal((await request("policy/batch", sessionId, { mode: "search", live: true })).status, 409);
  const stranger = await (await request("session", "", {})).json();
  assert.notEqual(stranger.sessionId, sessionId);
  assert.equal(stranger.runId, undefined);
  assert.equal((await request("policy/results?mode=ungrounded", stranger.sessionId)).status, 409);
  job.status = "completed";
  release();
  const completedSession = await (await request("session", sessionId, {})).json();
  assert.equal(completedSession.policyMode, "ungrounded");
  assert.equal(completedSession.runId, saved.id);
});
