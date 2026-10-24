import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionApi } from "../web/session-api.js";

function server() {
  const calls: { route: string; body: unknown; session?: string }[] = [];
  let active = "", counter = 0, loaded = "", rejectLoads = false, alwaysExpired = false;
  return {
    calls,
    expire: () => { active = ""; loaded = ""; },
    failLoads: () => { rejectLoads = true; },
    alwaysExpire: () => { alwaysExpired = true; },
    fetch: async (route: string, init: { body?: string; headers: Record<string, string> }) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      const session = init.headers["x-labmachine-session"];
      calls.push({ route, body, session });
      let status = 200, value: unknown;
      if (route === "/api/session") {
        if (!active || session !== active) active = `session-${++counter}`;
        value = { sessionId: active };
      } else if (alwaysExpired || !active || session !== active) {
        status = 401;
        value = { error: "Reload the workbench to start a private lab session." };
      } else if (route === "/api/cache/load") {
        if (rejectLoads) {
          status = 404;
          value = { error: "Saved run not found." };
        } else {
          loaded = body.runId;
          value = { id: loaded };
        }
      } else value = { runId: loaded };
      return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    },
  };
}

test("expired reads renew one private session, restore the selected run and retry", async () => {
  const fake = server();
  const ids: string[] = [];
  let restored = 0;
  const api = createSessionApi({
    fetch: fake.fetch, selectedRun: () => "saved-run",
    onSession: (id: string) => ids.push(id), onRestored: () => { restored++; },
  });

  await api("session", {});
  fake.expire();
  const values = await Promise.all([api("packet/packet-01"), api("policy/results?mode=existing")]);
  assert.ok(values.every((value) => value.runId === "saved-run"));
  assert.deepEqual(ids, ["session-1", "session-2"]);
  assert.equal(restored, 1);
  assert.equal(fake.calls.filter((call) => call.route === "/api/cache/load").length, 1);
  assert.ok(fake.calls.filter((call) => call.route !== "/api/session").every((call) => call.session));
});

test("refresh reuses the tab's private session without replaying a batch", async () => {
  const fake = server();
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const first = createSessionApi({ fetch: fake.fetch, storage });
  assert.equal((await first("session", {})).sessionId, "session-1");
  const refreshed = createSessionApi({ fetch: fake.fetch, storage });
  assert.equal((await refreshed("session", {})).sessionId, "session-1");
  await refreshed("policy/results?mode=ungrounded");
  assert.equal(fake.calls.at(-1)?.session, "session-1");
  assert.ok(!fake.calls.some((call) => call.route === "/api/policy/batch"));
  fake.expire();
  const restarted = createSessionApi({ fetch: fake.fetch, storage });
  assert.equal((await restarted("session", {})).sessionId, "session-2");
  assert.equal(values.get("lab664-private-session"), "session-2");
});

test("expired sessions never silently replay live writes", async () => {
  for (const route of ["batch", "policy/batch", "policy/chat", "policy/document", "connect"]) {
    const fake = server();
    const api = createSessionApi({ fetch: fake.fetch });
    await api("session", {});
    fake.expire();
    await assert.rejects(() => api(route, { live: true }), /No live operation was retried/);
    assert.equal(fake.calls.filter((call) => call.route === `/api/${route}`).length, 1);
    await api("cache");
    assert.equal(fake.calls.at(-1)?.session, "session-2");
  }
});

test("explicit cache loads can retry, while failed restoration and repeated 401s surface errors", async () => {
  const fake = server();
  const api = createSessionApi({ fetch: fake.fetch });
  await api("session", {});
  fake.expire();
  assert.equal((await api("cache/load", { runId: "chosen-run" })).id, "chosen-run");
  fake.alwaysExpire();
  await assert.rejects(() => api("cache"), /Reload the workbench/);
  assert.equal(fake.calls.filter((call) => call.route === "/api/session").length, 3);

  const failed = server();
  const restore = createSessionApi({ fetch: failed.fetch, selectedRun: () => "missing-run" });
  await restore("session", {});
  failed.expire();
  failed.failLoads();
  await assert.rejects(() => restore("packet/packet-01"), /Saved run not found/);
  assert.equal(failed.calls.filter((call) => call.route === "/api/packet/packet-01").length, 1);
});
