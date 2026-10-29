import * as initialPdfJs from "/vendor/pdfjs/pdf.mjs";

let pdfJs = initialPdfJs;
pdfJs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
const get = (id) => document.getElementById(id);
const scroll = get("pdf-scroll");
let documentPdf;
let loading;
let renderTask;
let selectedUrl = "";
let pageNumber = 1;
let zoom = 1;
let regions = [];
let version = 0;
let selection = 0;
let wheelFrame = 0;
let wheelAnchor;
let drag;
let renderedWidth = 0;

function status(message) {
  get("pdf-status").textContent = message;
  get("pdf-status").hidden = !message;
}
function anchorAt(x, y) {
  const stage = get("pdf-stage").getBoundingClientRect();
  const area = scroll.getBoundingClientRect();
  return {
    u: Math.max(0, Math.min(1, (x - stage.left) / stage.width)),
    v: Math.max(0, Math.min(1, (y - stage.top) / stage.height)),
    x: x - area.left,
    y: y - area.top,
  };
}
function centerAnchor() {
  const bounds = scroll.getBoundingClientRect();
  return anchorAt(
    bounds.left + bounds.width / 2,
    bounds.top + bounds.height / 2,
  );
}
async function render({ anchor, reset = false, focus } = {}) {
  if (scroll.hidden) return;
  const current = ++version;
  renderTask?.cancel();
  scroll.setAttribute("aria-busy", "true");
  get("pdf-stage").dataset.ready = "false";
  const pdf = documentPdf;
  if (!pdf) return;
  let page;
  try {
    page = await pdf.getPage(pageNumber);
  } catch (error) {
    if (current !== version) return;
    throw error;
  }
  if (current !== version) return;
  const availableWidth = scroll.clientWidth;
  const base = page.getViewport({ scale: 1 });
  const fit = Math.max(100, availableWidth - 26) / base.width;
  const viewport = page.getViewport({ scale: fit * zoom });
  const canvas = document.createElement("canvas");
  canvas.id = "pdf-canvas";
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(viewport.width * ratio);
  canvas.height = Math.round(viewport.height * ratio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  canvas.setAttribute("aria-label", `PDF page ${pageNumber}`);
  const task = page.render({
    canvasContext: canvas.getContext("2d"),
    viewport,
    transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
  });
  renderTask = task;
  try {
    await task.promise;
  } catch (error) {
    if (current !== version || error.name === "RenderingCancelledException")
      return;
    throw error;
  }
  if (current !== version) return;
  if (scroll.hidden) return;
  const stage = get("pdf-stage");
  stage.style.width = `${viewport.width}px`;
  stage.style.height = `${viewport.height}px`;
  get("pdf-canvas").replaceWith(canvas);
  get("pdf-overlay").replaceChildren(
    ...regions
      .filter((region) => region.page === pageNumber)
      .map((region) => {
        const polygon = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "polygon",
        );
        const pairs = [];
        for (let index = 0; index < region.polygon.length; index += 2)
          pairs.push(`${region.polygon[index]},${region.polygon[index + 1]}`);
        polygon.setAttribute("points", pairs.join(" "));
        return polygon;
      }),
  );
  stage.hidden = false;
  get("preview-empty").hidden = true;
  if (scroll.clientWidth !== availableWidth)
    return render({ anchor, reset, focus });
  renderedWidth = availableWidth;
  stage.dataset.source = selectedUrl;
  stage.dataset.page = pageNumber;
  stage.dataset.zoom = zoom;
  stage.dataset.ready = "true";
  scroll.setAttribute("aria-busy", "false");
  get("pdf-controls").hidden = false;
  get("pdf-page").value = pageNumber;
  get("pdf-page").max = pdf.numPages;
  get("pdf-pages").textContent = `/ ${pdf.numPages}`;
  get("prev-page").disabled = pageNumber <= 1;
  get("next-page").disabled = pageNumber >= pdf.numPages;
  get("source-pdf").href = `${selectedUrl}#page=${pageNumber}`;
  status("");
  if (reset) {
    scroll.scrollLeft = 0;
    scroll.scrollTop = 0;
  }
  if (anchor) {
    const box = stage.getBoundingClientRect();
    const area = scroll.getBoundingClientRect();
    scroll.scrollLeft += box.left - area.left + anchor.u * box.width - anchor.x;
    scroll.scrollTop += box.top - area.top + anchor.v * box.height - anchor.y;
  } else if (focus || (zoom > 1 && reset)) {
    const box = stage.getBoundingClientRect();
    const area = scroll.getBoundingClientRect();
    const xs = focus?.polygon.filter((_, index) => index % 2 === 0);
    const ys = focus?.polygon.filter((_, index) => index % 2 === 1);
    const x = xs ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0.5;
    const y = ys ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0.5;
    if (zoom > 1)
      scroll.scrollLeft +=
        box.left - area.left + x * box.width - scroll.clientWidth / 2;
    scroll.scrollTop +=
      box.top - area.top + y * box.height - scroll.clientHeight / 2;
  }
}
function report(error) {
  status(`PDF preview failed: ${error.message}`);
  get("pdf-stage").hidden = true;
  scroll.setAttribute("aria-busy", "false");
}
export async function previewPdf(url, page, highlights = [], options = {}) {
  const current = ++selection;
  ++version;
  renderTask?.cancel();
  if (wheelFrame) {
    cancelAnimationFrame(wheelFrame);
    wheelFrame = 0;
  }
  if (url !== selectedUrl) {
    loading?.destroy();
    documentPdf?.destroy();
    documentPdf = undefined;
    selectedUrl = url;
    zoom = 1;
    get("pdf-stage").hidden = true;
    get("pdf-controls").hidden = true;
    status("Loading...");
    for (let attempt = 0; attempt < 2; attempt++) {
      loading = pdfJs.getDocument({ url, standardFontDataUrl: "/vendor/pdfjs-fonts/" });
      const task = loading;
      try {
        const pdf = await task.promise;
        if (task !== loading || current !== selection) {
          await pdf.destroy();
          return;
        }
        documentPdf = pdf;
        break;
      } catch (error) {
        if (task !== loading || current !== selection) return;
        if (attempt === 0 && error.message?.startsWith("Setting up fake worker failed:")) {
          // A failed worker import stays cached in PDF.js and the browser's module map.
          status("Reconnecting PDF preview...");
          await task.destroy();
          try {
            const retry = `worker-retry=${Date.now()}`;
            const fresh = await import(`/vendor/pdfjs/pdf.mjs?${retry}`);
            if (task !== loading || current !== selection) return;
            fresh.GlobalWorkerOptions.workerSrc = `/vendor/pdfjs/pdf.worker.mjs?${retry}`;
            pdfJs = fresh;
            continue;
          } catch (recoveryError) {
            if (task !== loading || current !== selection) return;
            selectedUrl = "";
            const failure = new Error(
              "The PDF renderer could not reconnect. Check that the workbench is running, then reload this page.",
              { cause: recoveryError },
            );
            report(failure);
            throw failure;
          }
        }
        selectedUrl = "";
        const failure = error.message?.startsWith("Setting up fake worker failed:")
          ? new Error("The PDF worker could not load. Check that the workbench is running, then reload this page.", { cause: error })
          : error;
        report(failure);
        throw failure;
      }
    }
  } else if (!documentPdf) {
    const task = loading;
    const pdf = await task.promise;
    if (task !== loading) return;
    documentPdf = pdf;
  }
  if (current !== selection) return;
  const selectedZoom = options.zoom ?? 1;
  if (!Number.isFinite(selectedZoom) || selectedZoom < 0.5 || selectedZoom > 5)
    throw new RangeError("PDF zoom must be between 50% and 500%.");
  zoom = selectedZoom;
  pageNumber = Math.min(documentPdf.numPages, Math.max(1, page));
  regions = highlights;
  get("pdf-controls").hidden = false;
  try {
    await render({ reset: true, focus: regions[0] });
  } catch (error) {
    report(error);
    throw error;
  }
}
export function resetPreview() {
  ++selection;
  ++version;
  renderTask?.cancel();
  loading?.destroy();
  documentPdf?.destroy();
  if (wheelFrame) cancelAnimationFrame(wheelFrame);
  wheelFrame = 0;
  loading = undefined;
  documentPdf = undefined;
  selectedUrl = "";
  regions = [];
  get("pdf-stage").hidden = true;
  get("pdf-controls").hidden = true;
  get("preview-empty").hidden = false;
  scroll.setAttribute("aria-busy", "false");
  status("");
}
for (const [id, delta] of [
  ["prev-page", -1],
  ["next-page", 1],
])
  get(id).onclick = () => {
    pageNumber = Math.min(
      documentPdf.numPages,
      Math.max(1, pageNumber + delta),
    );
    render({ reset: true }).catch(report);
  };
get("pdf-page").onchange = () => {
  const page = Number(get("pdf-page").value);
  if (!Number.isInteger(page) || page < 1 || page > documentPdf.numPages) {
    get("pdf-page").value = pageNumber;
    status(`Enter a page from 1 to ${documentPdf.numPages}.`);
    return;
  }
  pageNumber = page;
  render({ reset: true }).catch(report);
};
for (const [id, factor] of [
  ["zoom-out", 1 / 1.25],
  ["zoom-in", 1.25],
])
  get(id).onclick = () => {
    const anchor = centerAnchor();
    zoom = Math.min(5, Math.max(0.5, zoom * factor));
    render({ anchor }).catch(report);
  };
get("fit-page").onclick = () => {
  zoom = 1;
  render({ reset: true }).catch(report);
};
scroll.addEventListener(
  "wheel",
  (event) => {
    if (!documentPdf || get("pdf-stage").hidden || event.deltaY === 0) return;
    event.preventDefault();
    const delta =
      event.deltaY *
      (event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? scroll.clientHeight
          : 1);
    wheelAnchor = anchorAt(event.clientX, event.clientY);
    zoom = Math.min(5, Math.max(0.5, zoom * Math.exp(-delta * 0.0015)));
    if (!wheelFrame)
      wheelFrame = requestAnimationFrame(() => {
        wheelFrame = 0;
        render({ anchor: wheelAnchor }).catch(report);
      });
  },
  { passive: false },
);
scroll.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !documentPdf || get("pdf-stage").hidden) return;
  event.preventDefault();
  drag = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    left: scroll.scrollLeft,
    top: scroll.scrollTop,
  };
  scroll.setPointerCapture(event.pointerId);
  scroll.classList.add("dragging");
});
scroll.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.id) return;
  scroll.scrollLeft = drag.left - (event.clientX - drag.x);
  scroll.scrollTop = drag.top - (event.clientY - drag.y);
});
for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
  scroll.addEventListener(name, (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (scroll.hasPointerCapture(event.pointerId))
      scroll.releasePointerCapture(event.pointerId);
    drag = undefined;
    scroll.classList.remove("dragging");
  });
let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (documentPdf && !scroll.hidden && scroll.clientWidth > 0 &&
        scroll.clientWidth !== renderedWidth && get("pdf-stage").dataset.ready === "true")
      render({ anchor: centerAnchor() }).catch(report);
  }, 150);
}).observe(scroll);
