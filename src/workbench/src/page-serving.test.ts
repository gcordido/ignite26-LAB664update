import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import express from "express";
import { test } from "node:test";

test("pages and vendor modules load beneath .copilot without exposing dotfiles", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "workbench-pages-"));
  const repositoryRoot = path.join(folder, ".copilot", "checkout");
  const root = path.join(repositoryRoot, "src", "workbench");
  const dataRoot = path.join(repositoryRoot, "data");
  const routes = [
    ["/", path.join(root, "web", "workbench.html"), "<html>Workbench</html>"],
    ["/index.html", path.join(root, "web", "workbench.html"), "<html>Workbench</html>"],
    ["/lab.html", path.join(repositoryRoot, "instructions", "lab.html"), "<html>Lab</html>"],
    ["/docs/policy-checks.md", path.join(repositoryRoot, "docs", "policy-checks.md"), "# Policy checks"],
    ["/docs/policy-setup.md", path.join(repositoryRoot, "docs", "policy-setup.md"), "# Policy setup"],
    ["/infra/README.md", path.join(repositoryRoot, "infra", "README.md"), "# Infrastructure"],
    ["/infra/policy-framework-agent.py", path.join(repositoryRoot, "infra", "policy-framework-agent.py"), "from agent_framework import Agent"],
    ["/infra/policy-agent-framework-setup.ipynb", path.join(repositoryRoot, "infra", "policy-agent-framework-setup.ipynb"), "{\"cells\":[]}"],
    ["/vendor/marked.js", path.join(root, "node_modules", "marked", "lib", "marked.esm.js"), "export const marked = true;"],
    ["/vendor/purify.js", path.join(root, "node_modules", "dompurify", "dist", "purify.es.mjs"), "export default {};"],
    ["/web/workbench.js", path.join(root, "web", "workbench.js"), "export const app = true;"],
    ["/data/.hidden.txt", path.join(dataRoot, ".hidden.txt"), "not public"],
    ["/web/.hidden.txt", path.join(root, "web", ".hidden.txt"), "not public"],
    ["/docs/.hidden.txt", path.join(repositoryRoot, "docs", ".hidden.txt"), "not public"],
    ["/infra/.hidden.txt", path.join(repositoryRoot, "infra", ".hidden.txt"), "not public"],
    ["/.tools/policy-agent-framework.json", path.join(repositoryRoot, ".tools", "policy-agent-framework.json"), "not public"],
  ];
  let server: ReturnType<express.Express["listen"]> | undefined;
  try {
    for (const [, file, contents] of routes) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
    const source = await readFile(new URL("./server.ts", import.meta.url), "utf8");
    // Run the production route registrations with a checkout under a hidden ancestor.
    const registrations = source.slice(source.indexOf("  const app = express();"), source.indexOf("  type Session ="));
    assert.ok(registrations.includes('res.sendFile("workbench.html"'));
    const app: express.Express = vm.runInNewContext(
      `(function () { ${registrations}\nreturn app; })()`,
      { express, path, root, repositoryRoot, dataRoot },
    );
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    for (const [url, , contents] of routes) {
      const response = await fetch(base + url);
      if (url.includes(".hidden") || url.startsWith("/.tools/")) {
        assert.notEqual(response.status, 200, url);
        assert.ok(!(await response.text()).includes(contents), url);
      } else {
        assert.equal(response.status, 200, url);
        assert.equal(await response.text(), contents, url);
      }
    }
  } finally {
    if (server) await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
    await rm(folder, { recursive: true, force: true });
  }
});
