import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

export function renderedMarkdown(markdown) {
  // CU uses HTML tables for merged cells. Preserve table structure, not active content.
  const html = DOMPurify.sanitize(marked.parse(markdown, { gfm: true }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "audio", "video", "source", "style", "form", "input", "button"],
    FORBID_ATTR: ["style", "id", "name"],
  });
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const link of template.content.querySelectorAll("a")) {
    const href = link.getAttribute("href") ?? "";
    // Extraction must not cause local-file navigation or execute service-generated URLs.
    if (!/^https?:\/\//i.test(href)) link.removeAttribute("href");
    else {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
  return template.content;
}

export function createPolicyDocument({ api, previewPdf, get, liveCallsEnabled = () => false }) {
  let selection;
  let mode = "pdf";
  let generation = 0;
  const scrolls = new Map();
  const panel = get("policy-document-content");
  const tabs = get("policy-document-tabs");
  const metadata = get("policy-document-status");
  let generating = false;
  function active(value) {
    for (const button of tabs.querySelectorAll("[data-representation]")) {
      const selected = button.dataset.representation === value;
      button.setAttribute("aria-selected", String(selected));
      button.classList.toggle("secondary", !selected);
      button.tabIndex = selected ? 0 : -1;
    }
  }
  function close() {
    generation++;
    selection = undefined;
    tabs.hidden = true;
    panel.hidden = true;
    metadata.hidden = true;
  }
  function controls() {
    const pdf = mode === "pdf";
    get("pdf-scroll").hidden = !pdf;
    get("pdf-controls").hidden = !pdf;
    get("pdf-status").hidden = true;
    panel.hidden = pdf;
    metadata.hidden = pdf;
    panel.setAttribute("aria-labelledby", mode === "search" ? "policy-document-search-tab" : "policy-document-digital-tab");
  }
  async function show(next = mode, live = false) {
    if (!selection) return;
    if (mode === "pdf" && next !== "pdf") selection.page = Number(get("pdf-page").value) || selection.page;
    if (mode !== "pdf") scrolls.set(`${selection.file}:${mode}`, panel.scrollTop);
    mode = next;
    const current = ++generation;
    const source = selection;
    active(mode);
    controls();
    if (mode === "pdf") {
      await previewPdf(source.url, source.page);
      // A late PDF render must not expose controls over an extraction tab.
      if (!selection || mode !== "pdf") get("pdf-controls").hidden = true;
      return;
    }
    const requested = mode;
    panel.textContent = live ? "Extracting with Content Understanding. This may take a minute…" : "Loading cached extraction…";
    metadata.textContent = requested === "search"
      ? "Whole document · CU Search · document, table and figure understanding. This preview does not rebuild the Azure Search index."
      : "Whole document · CU Digital parse · embedded machine-readable content; not the exact Azure Search Minimal pipeline.";
    const render = (value) => {
      panel.replaceChildren();
      if (value.available === false) {
        const notice = document.createElement("p");
        notice.textContent = "No cached extraction exists for these document bytes and this analyzer.";
        const generate = document.createElement("button");
        generate.dataset.liveControl = "";
        generate.hidden = !liveCallsEnabled();
        generate.textContent = generating ? "An extraction is running…" : "Generate with CU (Azure charges)";
        generate.disabled = generating;
        generate.onclick = () => show(requested, true);
        panel.append(notice, generate);
        return;
      }
      metadata.textContent += ` ${value.analyzer} · ${value.apiVersion} · ${value.cached ? "Cached" : "Generated"} ${new Date(value.createdAt).toLocaleString()}.`;
      const rendered = renderedMarkdown(value.markdown);
      if (rendered.textContent.trim()) panel.append(rendered);
      else {
        const empty = document.createElement("p");
        empty.textContent = "The analyzer returned no readable Markdown text (the raw output may contain only figure references or page breaks). This is expected for image-only documents with Digital parse; no OCR fallback was substituted.";
        panel.append(empty);
      }
      const raw = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Raw extraction Markdown";
      const pre = document.createElement("pre");
      pre.textContent = value.markdown;
      raw.append(summary, pre);
      panel.append(raw);
      panel.scrollTop = scrolls.get(`${source.file}:${requested}`) ?? 0;
    };
    try {
      if (live && !liveCallsEnabled())
        throw new Error("Live policy-document extraction is disabled.");
      if (live) generating = true;
      const value = live
        ? await api("policy/document", { file: source.file, mode: requested, live: true })
        : await api(`policy/document?file=${encodeURIComponent(source.file)}&mode=${requested}`);
      if (current !== generation || selection !== source) return;
      render(value);
    } catch (error) {
      if (current !== generation || selection !== source) return;
      panel.replaceChildren();
      const message = document.createElement("p");
      message.className = "error";
      message.textContent = `Extraction unavailable: ${error instanceof Error ? error.message : String(error)}`;
      const retry = document.createElement("button");
      retry.className = "secondary";
      retry.textContent = "Reload cached extraction";
      retry.onclick = () => show(requested);
      panel.append(message, retry);
    } finally {
      if (live) generating = false;
    }
  }
  for (const button of tabs.querySelectorAll("[data-representation]")) {
    button.onclick = () => show(button.dataset.representation).catch((error) => {
      metadata.hidden = false;
      metadata.textContent = `Document preview failed: ${error instanceof Error ? error.message : String(error)}`;
    });
    button.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...tabs.querySelectorAll("[data-representation]")];
      const index = buttons.indexOf(button);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
      buttons[next].click();
    };
  }
  return {
    close,
    async open(url, page) {
      close();
      selection = { url, page, file: url.replace(/^\/data\//, "") };
      tabs.hidden = false;
      await show("pdf");
    },
  };
}
