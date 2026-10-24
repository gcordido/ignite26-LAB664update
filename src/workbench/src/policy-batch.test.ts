import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { Cache } from "./batch.ts";
import { PolicyService, type PolicyJob } from "./policy-service.ts";
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
