export function createSessionApi({
  fetch: request = globalThis.fetch,
  selectedRun = () => undefined,
  onSession = () => {},
  onRestored = () => {},
} = {}) {
  let sessionId = "";
  let restoring;

  async function send(route, body, id = sessionId) {
    const response = await request(`/api/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(id ? { "x-labmachine-session": id } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, value: await response.json() };
  }
  function checked({ response, value }) {
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
    return value;
  }
  async function start() {
    const value = checked(await send("session", {}, ""));
    if (typeof value.sessionId !== "string" || !value.sessionId)
      throw new Error("The workbench returned no private session ID.");
    sessionId = value.sessionId;
    onSession(sessionId);
    return value;
  }
  async function restore(expiredId) {
    if (restoring) return restoring;
    if (sessionId !== expiredId) return;
    restoring = (async () => {
      const runId = selectedRun();
      await start();
      if (runId) checked(await send("cache/load", { runId }));
      onRestored();
    })();
    try { await restoring; }
    finally { restoring = undefined; }
  }
  return async function api(route, body) {
    if (route === "session") return start();
    if (restoring) await restoring;
    const id = sessionId;
    let result = await send(route, body, id);
    if (result.response.status === 401) {
      await restore(id);
      if (body !== undefined && route !== "cache/load")
        throw new Error("Your private workbench session was restored. No live operation was retried. Select the action again to continue.");
      result = await send(route, body);
    }
    return checked(result);
  };
}
