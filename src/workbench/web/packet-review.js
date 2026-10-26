import { previewPdf } from "./pdf-preview.js";
import {
  fieldLabel,
  fieldRegions,
  policyFamily,
  documentLabel,
  readableReferences,
  policyProblem,
} from "./result-model.js";

const get = (id) => document.getElementById(id);
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
export function packetReviewer({
  api,
  select,
  getReport,
  setBusy,
  notify,
  close,
}) {
  let packetId;
  let report;
  let active = false;
  let checksRunning = false;
  let selectedFamily;
  const previews = new Map();
  let contextVersion = 0;
  function visibleChecks() {
    const checks = (report?.policies.checks ?? []).filter(
      (check) => !selectedFamily || policyFamily(check) === selectedFamily,
    );
    const issues = checks.filter((check) => check.status !== "pass");
    return issues.length ? issues : checks;
  }
  function error(value) {
    get("review-error").hidden = false;
    get("review-error").textContent =
      value instanceof Error ? value.message : String(value);
    get("review-error").scrollIntoView({ block: "nearest" });
  }
  function summary() {
    const reviewing =
      checksRunning && visibleChecks().some((check) => check.status === "fail");
    get("policy-summary").hidden = !reviewing;
    get("policy-summary").textContent = reviewing
      ? "Running LLM Agent review..."
      : "";
  }
  async function action(work) {
    if (active) return;
    active = true;
    setBusy(true);
    get("review-error").hidden = true;
    get("packet-review").setAttribute("aria-busy", "true");
    for (const button of get("packet-review").querySelectorAll(
      "button[data-cloud]",
    ))
      button.disabled = true;
    try {
      await work();
    } catch (value) {
      error(value);
    } finally {
      active = false;
      summary();
      setBusy(false);
      get("packet-review").removeAttribute("aria-busy");
      for (const button of get("packet-review").querySelectorAll(
        "button[data-cloud]",
      ))
        button.disabled = false;
    }
  }
  async function analyze(check, doc, analyzerId) {
    if (
      !window.confirm(
        `Rerun only ${doc.sourceId} for ${packetId} with analyzer ${analyzerId}? Azure charges apply. Results are a temporary policy preview, not saved. Original fields and policy status stay unchanged.`,
      )
    )
      return;
    await action(async () => {
      get("policy-summary").textContent =
        "Analyzing one document. This may take a few minutes...";
      get("policy-summary").hidden = false;
      const version = contextVersion;
      const { preview } = await api(`document/${packetId}`, {
        live: true,
        sourceId: doc.sourceId,
        analyzerId,
      });
      if (version !== contextVersion) return;
      previews.set(`${check.id}|${doc.sourceId}`, {
        checkId: check.id,
        doc,
        preview,
      });
      render();
    });
  }
  async function runChecks() {
    checksRunning = true;
    summary();
    try {
      const version = contextVersion;
      const fresh = await api(`checks/${packetId}`, {
        run: true,
        refresh: true,
      });
      if (version !== contextVersion) return;
      report = fresh;
      render();
    } finally {
      checksRunning = false;
      summary();
    }
  }
  function documentName(doc) {
    return documentLabel(doc);
  }
  function checkDocuments(check) {
    const ids = new Set(check.evidence.map((item) => item.documentId));
    return report.documents.filter(
      (doc) => ids.has(doc.id) || check.id.endsWith(`:${doc.id}`),
    );
  }
  function contextFor(check, doc, field) {
    const available = check.evidence.filter(
      (item) => item.documentId === doc.id,
    );
    const own = available.find((item) => item.field === field);
    if (own?.regions.length) return own;
    if (["FirstName", "LastName"].includes(field))
      return (
        available.find(
          (item) =>
            ["FirstName", "LastName"].includes(item.field) &&
            item.regions.length &&
            item.value != null,
        ) ?? own
      );
    return own;
  }
  function focusField(check, doc) {
    return (
      {
        "financial.total": "TotalAmount.Amount",
        "financial.line_items": "SubtotalAmount.Amount",
        "financial.tax_details": "TotalTaxAmount.Amount",
      }[policyFamily(check)] ??
      check.evidence.find(
        (item) =>
          item.documentId === doc.id && !item.field.endsWith("CurrencyCode"),
      )?.field
    );
  }
  function evidenceLink(check, doc, field, text, missing = false) {
    const link = node("button", text, "evidence-link");
    if (field) link.dataset.field = field;
    link.title = `${documentName(doc)} · ${field ? fieldLabel(field) : "source document"}${missing ? " missing; shows available source context" : ""}`;
    link.setAttribute("aria-label", `${documentName(doc)}, ${text}`);
    link.onclick = () =>
      showEvidence(
        doc,
        contextFor(check, doc, field),
        missing ? field : undefined,
      );
    return link;
  }
  function symbol(kind) {
    const paths = {
      fail: "M6 6l12 12M18 6 6 18",
      not_checkable: "M12 5v9m0 4v1",
      pass: "m5 12 4 4L19 6",
      extraction_error: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 9h8M8 15h5",
      packet_error: "m12 3 10 18H2L12 3Zm0 5v6m0 3v1",
      pending: "M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 4m0 3v1",
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", paths[kind] ?? paths.pending);
    svg.append(path);
    return svg;
  }
  function reviewNotes(check) {
    const content = node("div", undefined, "policy-notes");
    content.append(node("p", check.rule, "muted"));
    if (report.preview)
      content.append(
        node(
          "p",
          "Fresh LLM review preview — not saved. Original policy status is unchanged.",
          "muted",
        ),
      );
    const diagnosis = report.diagnoses?.[check.id];
    if (diagnosis?.status === "completed") {
      const result = diagnosis.result;
      content.append(
        node("p", readableReferences(result.reason, report.documents)),
        node(
          "p",
          `Suggested action: ${readableReferences(result.suggestion, report.documents)}`,
        ),
        node(
          "p",
          `${result.model} · ${result.cached || diagnosis.cached ? "cached" : "new review"} · advisory only`,
          "muted",
        ),
      );
      content.lastChild.title = `${result.deployment}${result.fallbackFrom ? `; fallback from ${result.fallbackFrom}` : ""}`;
    } else if (diagnosis?.status === "unavailable") {
      content.append(
        node("p", `LLM Agent review unavailable: ${diagnosis.error}`, "error"),
      );
    } else if (check.status === "fail") {
      content.append(
        node(
          "p",
          checksRunning
            ? "LLM Agent review is running..."
            : "No completed LLM Agent review is available.",
          "muted",
        ),
      );
    }
    const entries = check.evidence.flatMap((item) => {
      const doc = report.documents.find((doc) => doc.id === item.documentId);
      return doc ? [{ doc, item }] : [];
    });
    if (entries.length) content.append(evidenceTable(entries));
    for (const value of previews.values())
      if (value.checkId === check.id)
        content.append(renderPreview(check, value));
    const options = node("details");
    options.append(node("summary", "Refine extractor / rerun one document"));
    const guidance = node("p");
    const studio = node("a", "CU Studio");
    studio.href = "https://contentunderstanding.ai.azure.com/build";
    studio.target = "_blank";
    studio.rel = "noopener";
    guidance.append(
      "Update and build the extractor in ",
      studio,
      ", then rerun only this source PDF. Both issue types support reruns. Azure charges apply; preview results are not saved and do not change the original policy or extraction.",
    );
    options.append(guidance);
    const targets = node("div");
    renderRerunDocuments(check, targets);
    options.append(targets);
    content.append(options);
    return content;
  }
  function evidenceTable(entries, missing = "missing") {
    const visible = entries.filter(
      ({ item }) => !item.field.endsWith("CurrencyCode"),
    );
    const multiple = new Set(visible.map(({ doc }) => doc.id)).size > 1;
    const section = node("div", undefined, "policy-evidence");
    const sources = new Map();
    for (const entry of visible) {
      if (!sources.has(entry.doc.url)) sources.set(entry.doc.url, []);
      sources.get(entry.doc.url).push(entry);
    }
    for (const group of sources.values()) {
      const button = node(
        "button",
        sources.size === 1
          ? "Highlight all values"
          : `Highlight values in ${documentName(group[0].doc)}`,
        "evidence-link",
      );
      button.onclick = () => showAllEvidence(group);
      section.append(button);
    }
    const table = node("table");
    const head = node("tr");
    if (multiple) head.append(node("th", "Document"));
    head.append(node("th", "Field"), node("th", "Value"));
    const thead = node("thead");
    thead.append(head);
    const body = node("tbody");
    for (const { doc, item } of visible) {
      const row = node("tr");
      if (multiple) row.append(node("td", documentName(doc)));
      row.append(
        node("td", fieldLabel(item.field)),
        node("td", String(item.value ?? missing)),
      );
      body.append(row);
    }
    table.append(thead, body);
    section.append(table);
    return section;
  }
  function renderRerunDocuments(check, host) {
    const documents = checkDocuments(check).filter(
      (doc) => doc.sourceId && doc.category !== "other",
    );
    if (!documents.length) {
      host.replaceChildren(
        node(
          "p",
          "This check cannot be matched to a single source PDF. Inspect document boundaries in Studio before rerunning.",
          "muted",
        ),
      );
      return;
    }
    host.replaceChildren(
      ...documents.map((doc) => {
        const line = node("div", undefined, "rerun-document");
        const label = node("label", `${documentName(doc)} analyzer: `);
        const input = node("input");
        input.value = doc.analyzerId;
        input.setAttribute("aria-label", `Analyzer for ${doc.sourceId}`);
        const button = node("button", "Rerun this document", "secondary");
        button.dataset.cloud = "true";
        button.onclick = () => analyze(check, doc, input.value.trim());
        label.append(input);
        line.append(label, button);
        return line;
      }),
    );
  }
  function renderPreview(check, { doc: original, preview }) {
    const section = node("section", undefined, "policy-preview");
    section.append(
      node("h4", `Fresh rerun preview · ${documentName(original)}`),
      node(
        "p",
        "Not cached or saved. Original policy and extraction stay unchanged.",
        "muted",
      ),
    );
    const ids = new Set(preview.documents.map((doc) => doc.id));
    const checks = preview.policies.checks.filter(
      (value) =>
        policyFamily(value) === policyFamily(check) &&
        (value.evidence.some((item) => ids.has(item.documentId)) ||
          [...ids].some((id) => value.id.endsWith(`:${id}`))),
    );
    for (const value of checks) {
      const line = node("p", undefined, "policy-problem");
      const indicator = node(
        "span",
        undefined,
        `policy-indicator indicator-${value.status}`,
      );
      indicator.append(symbol(value.status));
      const status = { pass: "Pass", fail: "Error", not_checkable: "Warning" }[
        value.status
      ];
      line.append(
        indicator,
        node(
          "span",
          `Preview only · ${status}: ${readableReferences(value.message, preview.documents)}`,
        ),
      );
      section.append(line);
    }
    const fields = new Set(
      check.evidence
        .filter((item) => item.documentId === original.id)
        .map((item) => item.field),
    );
    for (const doc of preview.documents) {
      section.append(
        evidenceTable(
          [...fields].map((field) => ({
            doc,
            item: doc.document.facts.find((item) => item.field === field) ?? {
              field,
              regions: [],
            },
          })),
          "not returned",
        ),
      );
    }
    return section;
  }
  function render() {
    summary();
    const openNotes = new Set(
      [
        ...get("policy-checks").querySelectorAll(".policy-note:not([hidden])"),
      ].map((row) => row.dataset.check),
    );
    const order = { fail: 0, not_checkable: 1, pass: 2 };
    const checks = visibleChecks().sort(
      (a, b) => order[a.status] - order[b.status],
    );
    const hasReview = checks.some((check) => check.status === "fail");
    get("policy-review-header").hidden = !hasReview;
    get("policy-checks")
      .closest("table")
      .classList.toggle("without-review", !hasReview);
    get(hasReview ? "policy-review-header" : "policy-problem-header").append(
      get("close-review"),
    );
    get("packet-review").querySelector(".review-options").hidden = !hasReview;
    const reviewKinds = {
      packet_error: "Document issue",
      extraction_error: "Extraction issue",
    };
    get("policy-checks").replaceChildren(
      ...checks.flatMap((check, index) => {
        const row = node("tr", undefined, `policy-row policy-${check.status}`);
        row.dataset.check = check.id;
        const documents = checkDocuments(check);
        const problem = policyProblem(check, report.documents);
        const source = node("td", undefined, "policy-source");
        for (const doc of documents) {
          const field = problem.missing[0] ?? focusField(check, doc);
          source.append(
            evidenceLink(
              check,
              doc,
              field,
              documentName(doc),
              problem.missing.includes(field),
            ),
          );
        }
        if (!documents.length)
          source.append(node("span", "No source", "muted"));
        const issue = node("td");
        const line = node("div", undefined, "policy-problem");
        const indicator = node(
          "span",
          undefined,
          `policy-indicator indicator-${check.status}`,
        );
        indicator.title = `${check.status === "fail" ? "Fixed check failed" : check.status === "pass" ? "Fixed check passed" : "Not checkable"}: ${check.rule}`;
        indicator.setAttribute("role", "img");
        indicator.setAttribute(
          "aria-label",
          check.status === "fail"
            ? "Error"
            : check.status === "pass"
              ? "Pass"
              : "Warning",
        );
        indicator.append(symbol(check.status));
        const values = node("div", undefined, "policy-problem-values");
        if (problem.missing.length) {
          for (const field of problem.missing) {
            const doc =
              documents.find((doc) =>
                check.evidence.some(
                  (item) => item.documentId === doc.id && item.field === field,
                ),
              ) ?? documents[0];
            const label = `${fieldLabel(field)}: missing`;
            values.append(
              doc
                ? evidenceLink(check, doc, field, label, true)
                : node("span", label),
            );
            if (doc && ["FirstName", "LastName"].includes(field)) {
              const context = contextFor(check, doc, field);
              if (context?.value != null && context.field !== field) {
                const link = evidenceLink(
                  check,
                  doc,
                  context.field,
                  `Returned ${fieldLabel(context.field)}: ${context.value}`,
                );
                link.classList.add("returned-context");
                values.append(link);
              }
            }
          }
        } else if (documents[0]) {
          const doc = documents[0];
          const field = focusField(check, doc);
          values.append(evidenceLink(check, doc, field, problem.text));
        } else values.append(node("span", problem.text));
        line.append(indicator, values);
        issue.append(line);
        row.append(source, issue);
        if (check.status !== "fail") {
          if (hasReview) row.append(node("td"));
          return [row];
        }
        const diagnosis = report.diagnoses?.[check.id];
        const kind =
          diagnosis?.status === "completed"
            ? diagnosis.result.category
            : "pending";
        if (
          diagnosis?.status === "completed" &&
          !Object.hasOwn(reviewKinds, kind)
        )
          throw new Error(
            "Unsupported review category. Refresh the Workbench to load the current review format.",
          );
        const label =
          diagnosis?.status === "completed"
            ? reviewKinds[kind]
            : diagnosis?.status === "unavailable"
              ? "Unavailable"
              : checksRunning
                ? "Reviewing..."
                : "Not reviewed";
        const review = node("td", undefined, "policy-review-cell");
        const badge = node(
          "button",
          undefined,
          `review-badge review-${diagnosis?.status === "completed" ? kind : "neutral"}`,
        );
        badge.append(symbol(kind), node("span", label));
        badge.title =
          diagnosis?.status === "completed"
            ? `Possible ${label.toLowerCase()} · advisory LLM Agent review. Click for reasoning, source fields and suggested action.`
            : "View source fields and check details.";
        const notes = node("tr", undefined, "policy-note");
        notes.id = `review-note-${index}`;
        notes.dataset.check = check.id;
        notes.hidden = !openNotes.has(check.id);
        const cell = node("td");
        cell.colSpan = 3;
        cell.append(reviewNotes(check));
        notes.append(cell);
        badge.setAttribute("aria-controls", notes.id);
        badge.setAttribute("aria-expanded", String(!notes.hidden));
        badge.onclick = () => {
          notes.hidden = !notes.hidden;
          badge.setAttribute("aria-expanded", String(!notes.hidden));
        };
        review.append(badge);
        row.append(review);
        return [row, notes];
      }),
    );
    if (active)
      for (const button of get("packet-review").querySelectorAll(
        "button[data-cloud]",
      ))
        button.disabled = true;
  }
  function evidenceRegions(doc, fact) {
    return fact?.field === "TotalTaxAmount.Amount"
      ? fieldRegions(
          doc.document.facts.find((item) => item.field === fact.field),
          doc.document,
        )
      : (fact?.regions ?? []);
  }
  function showAllEvidence(entries) {
    select(packetId);
    const seen = new Set();
    const directDocuments = new Set(
      entries
        .filter(({ item }) => item.regions?.length)
        .map(({ doc }) => doc.id),
    );
    const regions = entries
      .flatMap(({ doc, item }) =>
        item.regions?.length
          ? item.regions
          : directDocuments.has(doc.id)
            ? []
            : evidenceRegions(doc, item),
      )
      .filter((region) => {
        const key = `${region.page}:${region.polygon.join(",")}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const pages = [...new Set(regions.map((region) => region.page))].sort(
      (a, b) => a - b,
    );
    const messages = [];
    if (!regions.length)
      messages.push(
        "No source boxes were returned; showing the source document.",
      );
    else {
      if (pages.length > 1)
        messages.push(
          `Evidence is highlighted on pages ${pages.join(", ")}; use the page controls to inspect each page.`,
        );
      if (
        entries.some(
          ({ doc, item }) =>
            item.field === "TotalTaxAmount.Amount" &&
            !item.regions.length &&
            evidenceRegions(doc, item).length,
        )
      )
        messages.push(
          "Tax-detail context is shown where no separate Tax source box was returned.",
        );
      if (
        entries.some(
          ({ doc, item }) =>
            item.value == null || !evidenceRegions(doc, item).length,
        )
      )
        messages.push(
          "Missing values or values without source boxes cannot be highlighted.",
        );
    }
    previewPdf(
      entries[0].doc.url,
      regions[0]?.page ?? entries[0].doc.start,
      regions,
      { zoom: 1 },
    )
      .then(() => {
        get("pdf-status").textContent = messages.join(" ");
        get("pdf-status").hidden = !messages.length;
      })
      .catch(notify);
  }
  function showEvidence(doc, fact, missingField) {
    select(packetId);
    const ownRegions = fact?.regions ?? [];
    const regions = evidenceRegions(doc, fact);
    const taxContext =
      fact?.field === "TotalTaxAmount.Amount" &&
      !ownRegions.length &&
      regions.length;
    previewPdf(doc.url, regions[0]?.page ?? doc.start, regions, {
      zoom: 1,
    })
      .then(() => {
        const status = missingField
          ? regions.length
            ? `${fieldLabel(missingField)} was not extracted; showing ${taxContext ? "tax-detail" : fieldLabel(fact.field)} source context.`
            : `No source region was returned for ${fieldLabel(missingField)}; showing ${documentName(doc)}.`
          : regions.length
            ? taxContext
              ? "Showing tax-detail source context; no separate Tax source box was returned."
              : ""
            : "No highlight returned";
        get("pdf-status").textContent = status;
        get("pdf-status").hidden = !status;
      })
      .catch(notify);
  }
  get("close-review").onclick = close;
  get("rerun-checks").onclick = () =>
    action(async () => {
      await runChecks();
    });
  return {
    reset() {
      ++contextVersion;
      previews.clear();
    },
    open(id, column) {
      if (active) return;
      ++contextVersion;
      previews.clear();
      packetId = id;
      selectedFamily = column?.id;
      report = undefined;
      select(id);
      get("review-title").textContent = `${column?.label ?? "Policy"} issues`;
      get("review-error").hidden = true;
      get("policy-checks").replaceChildren();
      try {
        report = getReport(id);
        if (!report)
          throw new Error(
            "No policy report was loaded for this packet. Reload Cache Results.",
          );
        render();
      } catch (value) {
        error(value);
      }
    },
  };
}
