import assert from "node:assert/strict";
import { once } from "node:events";
import { realpath, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dataRoot, LabError } from "./config.ts";
import { policyDatasets } from "./policy-datasets.ts";
import { createApp } from "./server.ts";

test("three datasets resolve actual absolute directories and distinct genuine native output folders", async () => {
  const datasets = await policyDatasets();
  assert.deepEqual(datasets.map(value => value.id), ["original", "search", "digital"]);
  const expected = [
    path.join(dataRoot, "policies", "rental", "ocr-comparison-v2"),
    path.join(dataRoot, "policy-document-demo", "search"),
    path.join(dataRoot, "policy-document-demo", "digital"),
  ];
  for (const [index, dataset] of datasets.entries()) {
    assert.equal(dataset.path, await realpath(expected[index]));
    assert.ok(path.isAbsolute(dataset.path));
    assert.equal(path.normalize(fileURLToPath(dataset.href)), path.normalize(dataset.path + path.sep));
    const files = await readdir(dataset.path);
    assert.equal(files.filter(file => file.endsWith(index ? ".response.json" : ".pdf")).length, 21);
    if (index) assert.equal(files.filter(file => file.endsWith(".md")).length, 21);
  }
});

test("folder launch requires a private session, local origin and exact fixed dataset ID; errors stay explicit", async () => {
  const opened: string[] = [];
  let blocked = false;
  const noCloud = async () => { throw new Error("Azure must never be called"); };
  const server = createApp({ analyze: noCloud, detail: noCloud }, {
    openPolicyFolder: async (folder) => {
      if (blocked) throw new LabError(501, "Platform cannot open folders. Copy the path instead.");
      opened.push(folder);
    },
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown, headers: Record<string, string>) =>
    fetch(`${base}/api/policy/datasets/open`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(`${base}/api/policy/datasets`)).status, 401);
    assert.equal((await post({ id: "original" }, { origin: base })).status, 401);
    const session = await (await fetch(`${base}/api/session`, { method: "POST" })).json();
    const headers = { "x-labmachine-session": session.sessionId, origin: base };
    const response = await fetch(`${base}/api/policy/datasets`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const { datasets } = await response.json();
    const forbiddenMetadata: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { host: "evil.example", origin: "http://evil.example" },
      { "sec-fetch-site": "cross-site" },
    ];
    for (const changed of forbiddenMetadata)
      assert.equal((await fetch(`${base}/api/policy/datasets`,
        { headers: { ...headers, ...changed } })).status, 403);
    for (const dataset of datasets) {
      const request = await post({ id: dataset.id }, headers);
      assert.equal(request.status, 200);
      assert.deepEqual(await request.json(), { requested: true, id: dataset.id });
    }
    assert.deepEqual(opened, datasets.map((dataset: { path: string }) => dataset.path));
    for (const body of [
      { id: "../" }, { id: "C:\\Windows" }, { id: "search & calc.exe" },
      { id: "search", path: "C:\\Windows" }, { id: "search", command: "calc.exe" }, {},
    ]) assert.equal((await post(body, headers)).status, 400);
    const rejectedHeaders: Record<string, string>[] = [
      { origin: "https://evil.example" }, { origin: "null" }, { origin: "" },
      { "sec-fetch-site": "cross-site" }, { host: "evil.example", origin: "http://evil.example" },
    ];
    for (const changed of rejectedHeaders)
      assert.equal((await post({ id: "original" }, { ...headers, ...changed })).status, 403);
    assert.equal(opened.length, 3);
    blocked = true;
    const failure = await post({ id: "digital" }, headers);
    assert.equal(failure.status, 501);
    assert.match((await failure.json()).error, /Copy the path/);
    assert.equal(opened.length, 3);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
