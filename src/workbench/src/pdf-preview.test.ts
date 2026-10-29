import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

test("PDF renders settle across scrollbar-height changes and only resize for a new width", async () => {
  const source = await readFile(new URL("../web/pdf-preview.js", import.meta.url), "utf8");
  let renders = 0;
  let documentError: Error | undefined;
  let recoveryError: Error | undefined;
  let recoveries = 0;
  let failedLoads = 0;
  let resized = () => {};
  const timers = new Map<number, () => void>();
  const nodes = new Map<string, {
    hidden: boolean;
    clientWidth: number;
    clientHeight: number;
    dataset: Record<string, string>;
    style: Record<string, string>;
    textContent: string;
    value: number;
    max: number;
    disabled: boolean;
    href: string;
    scrollLeft: number;
    scrollTop: number;
    setAttribute: () => void;
    addEventListener: () => void;
    replaceChildren: () => void;
    replaceWith: () => void;
    getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
  }>();
  function get(id: string) {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: false, clientWidth: 500, clientHeight: 650, dataset: {}, style: {},
      textContent: "", value: 1, max: 1, disabled: false, href: "", scrollLeft: 0, scrollTop: 0,
      setAttribute() {}, addEventListener() {}, replaceChildren() {},
      replaceWith() {
        const scroll = nodes.get("pdf-scroll")!;
        scroll.clientHeight = scroll.clientHeight === 650 ? 635 : 650;
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 650 }),
    });
    return nodes.get(id)!;
  }
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render() {
      renders++;
      if (renders > 5) throw new Error("PDF rendering did not settle.");
      return { promise: Promise.resolve(), cancel() {} };
    },
  };
  const engine = {
    GlobalWorkerOptions: {},
    getDocument() {
      if (documentError) failedLoads++;
      return {
        promise: documentError ? Promise.reject(documentError) :
          Promise.resolve({ numPages: 2, getPage: async () => page, destroy() {} }),
        destroy() {},
      };
    },
  };
  const context = vm.createContext({
    initialPdfJs: engine,
    async reloadPdfJs(url: string) {
      recoveries++;
      assert.match(url, /^\/vendor\/pdfjs\/pdf\.mjs\?worker-retry=\d+$/);
      if (recoveryError) throw recoveryError;
      documentError = undefined;
      return engine;
    },
    window: { devicePixelRatio: 1 },
    document: {
      getElementById: get,
      createElement: () => ({ style: {}, setAttribute() {}, getContext: () => ({}) }),
    },
    ResizeObserver: class {
      constructor(callback: () => void) { resized = callback; }
      observe() {}
    },
    setTimeout(callback: () => void) {
      const id = timers.size + 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/m, "")
    .replace("await import(", "await reloadPdfJs(").replaceAll("export ", ""), context);
  await vm.runInContext('previewPdf("/test.pdf", 1)', context);
  assert.equal(renders, 1, "A changed scrollbar height must not recursively render the PDF.");
  assert.equal(get("pdf-stage").dataset.ready, "true");
  async function flushResize() {
    resized();
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await flushResize();
  assert.equal(renders, 1, "Content changes at the same width must not render again.");
  get("pdf-scroll").clientWidth = 480;
  await flushResize();
  assert.equal(renders, 2, "A changed panel width must render at the new fit scale.");
  get("pdf-scroll").clientHeight = 600;
  await flushResize();
  assert.equal(renders, 2, "Height-only changes don't change fit-to-width scale.");
  get("pdf-scroll").hidden = true;
  get("pdf-scroll").clientWidth = 450;
  await flushResize();
  assert.equal(renders, 2, "Hidden viewers must not resize.");
  get("pdf-scroll").hidden = false;
  documentError = new Error('Setting up fake worker failed: "Failed to fetch dynamically imported module"');
  await vm.runInContext('previewPdf("/after-restart.pdf", 1)', context);
  assert.equal(recoveries, 1, "A cached worker failure must get one fresh renderer.");
  assert.equal(failedLoads, 1);
  assert.equal(get("pdf-stage").dataset.ready, "true");
  assert.equal(get("pdf-status").textContent, "");
  documentError = new Error("Invalid PDF structure.");
  await assert.rejects(vm.runInContext('previewPdf("/invalid.pdf", 1)', context), /Invalid PDF structure/);
  assert.equal(recoveries, 1, "Invalid PDFs must not trigger worker recovery.");
  documentError = new Error('Setting up fake worker failed: "Failed to fetch dynamically imported module"');
  recoveryError = new Error("Server offline");
  await assert.rejects(vm.runInContext('previewPdf("/offline.pdf", 1)', context), /Check that the workbench is running/);
  assert.equal(recoveries, 2, "Recovery must not loop when the server stays unavailable.");
  assert.match(get("pdf-status").textContent, /reload this page/);
  assert.equal(get("pdf-stage").hidden, true);
});
