import { previewPdf } from "./pdf-preview.js";
import {
  fieldLabel,
  fieldRegions,
  policyFamily,
  documentLabel,
  policyProblem,
  policyChecks,
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
  let visible = false;
  let selectedFamily;
  const previews = new Map();
  function visibleChecks() {
    const checks = policyChecks(report, selectedFamily);
    const issues = checks.filter((check) => check.status !== "pass");
    return issues.length ? issues : checks;
  }
  function error(value) {
    get("review-error").hidden = false;
    get("review-error").textContent =
      value instanceof Error ? value.message : String(value);
    get("review-error").scrollIntoView({ block: "nearest" });
  }
  function previewKey(doc) {
    return `${report.source.runId}|${packetId}|${doc.sourceId}`;
  }
  async function analyze(doc, analyzerId) {
    if (active) return;
    const id = packetId;
    const key = previewKey(doc);
    const state = { analyzerId, status: "running" };
    previews.set(key, state);
    active = true;
    setBusy(true);
    get("review-error").hidden = true;
    get("packet-review").setAttribute("aria-busy", "true");
    render();
    try {
      const { preview } = await api(`document/${id}`, {
        live: true,
        sourceId: doc.sourceId,
        analyzerId,
      });
      if (previews.get(key) === state) {
        state.preview = preview;
        state.status = "completed";
      }
    } catch (value) {
      if (previews.get(key) === state) {
        state.status = "failed";
        state.error = value instanceof Error ? value.message : String(value);
      }
      if (!visible) notify(value);
    } finally {
      active = false;
      setBusy(false);
      get("packet-review").removeAttribute("aria-busy");
      if (visible && report) {
        render();
        if (packetId === id && previews.get(key) === state && state.preview) {
          const section = [...get("policy-checks").querySelectorAll(".policy-preview")]
            .find((section) => section.dataset.previewId === state.preview.id);
          section?.querySelector(".policy-source .evidence-link")?.click();
        }
      }
    }
  }
  function documentName(doc) {
    return documentLabel(doc);
  }
  function checkDocuments(check, documents = report.documents) {
    const ids = new Set(check.evidence.map((item) => item.documentId));
    return documents.filter(
      (doc) => ids.has(doc.id) || check.id.endsWith(`:${doc.id}`),
    );
  }
  function contextFor(check, doc, field) {
    return check.evidence.find(
      (item) => item.documentId === doc.id && item.field === field,
    );
  }
  function focusField(check, doc) {
    return (
      {
        "financial.total": "TotalAmount.Amount",
        "financial.line_items": "SubtotalAmount.Amount",
        "cross.repair_estimates": "TotalAmount.Amount",
      }[policyFamily(check)] ??
      check.evidence.find(
        (item) =>
          item.documentId === doc.id && !item.field.endsWith("CurrencyCode"),
      )?.field
    );
  }
  function evidenceLink(check, doc, field, text, missing = false, includeComponents = false) {
    const link = node("button", text, "evidence-link");
    const family = policyFamily(check);
    const amounts = family === "financial.total"
      ? /^(?:(?:SubtotalAmount|TotalTaxAmount|TotalAmount)\.Amount|TaxDetails\[\d+\]\.Amount\.Amount)$/
      : family === "financial.line_items"
        ? /^(?:LineItems\[\d+\]\.(?:TotalAmount\.Amount|Parts?Amount|LaborAmount)|SubtotalAmount\.Amount)$/
        : undefined;
    const operands = amounts && includeComponents
      ? formulaEntries(check, [doc], true)
          .filter(({ item }) => !item.field.endsWith("CurrencyCode"))
      : amounts && !missing
        ? check.evidence
            .filter(
              (item) =>
                item.documentId === doc.id &&
                amounts.test(item.field),
            )
            .map((item) => ({ doc, item }))
        : [];
    if (field) link.dataset.field = field;
    link.title = operands.length
      ? `${documentName(doc)} · highlight formula amounts${includeComponents ? ", parts and labor" : " and subtotal"}`
      : `${documentName(doc)} · ${field ? fieldLabel(field) : "source document"}${missing ? " missing; shows available source context" : ""}`;
    link.setAttribute("aria-label", `${documentName(doc)}, ${text}`);
    link.onclick = () =>
      operands.length
        ? showAllEvidence(operands)
        : showEvidence(
            doc,
            contextFor(check, doc, field),
            missing ? field : undefined,
          );
    return link;
  }
  function symbol(kind) {
    const paths = {
      fail: "M6 6l12 12M18 6 6 18",
      warn: "M12 5v9m0 4v1",
      not_checkable: "M12 5v9m0 4v1",
      pass: "m5 12 4 4L19 6",
    };
    if (!Object.hasOwn(paths, kind))
      throw new Error(`Unknown extraction-check status: ${kind}`);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", paths[kind]);
    svg.append(path);
    return svg;
  }
  function formulaEntries(check, documents, includeComponents = false) {
    const entries = check.evidence.flatMap((item) => {
      const doc = documents.find((doc) => doc.id === item.documentId);
      return doc ? [{ doc, item }] : [];
    });
    if (includeComponents) {
      const seen = new Set(entries.map(({ doc, item }) => `${doc.id}|${item.field}`));
      const related = new Set(entries.map(({ doc }) => doc.id));
      for (const doc of documents) {
        if (!related.has(doc.id)) continue;
        for (const item of doc.document.facts) {
          const key = `${doc.id}|${item.field}`;
          if (/^LineItems\[\d+\]\.(?:PartsAmount|LaborAmount)$/.test(item.field) &&
              item.value != null && !seen.has(key)) {
            entries.push({ doc, item });
            seen.add(key);
          }
        }
      }
    }
    const order = new Map(documents.map((doc, index) => [doc.id, index]));
    return entries
      .map((entry, index) => {
        const match = /^LineItems\[(\d+)\]\.(.+)$/.exec(entry.item.field);
        const fieldRank = {
          "TotalAmount.Amount": 0,
          PartsAmount: 1,
          LaborAmount: 2,
        }[match?.[2]] ?? 3;
        return {
          ...entry,
          sort: match
            ? [order.get(entry.doc.id) ?? 0, 0, Number(match[1]), fieldRank, index]
            : [order.get(entry.doc.id) ?? 0, 1, 0, 0, index],
        };
      })
      .sort((left, right) => {
        for (let index = 0; index < left.sort.length; index++)
          if (left.sort[index] !== right.sort[index])
            return left.sort[index] - right.sort[index];
        return 0;
      })
      .map(({ sort, ...entry }) => entry);
  }
  function reviewNotes(check) {
    const content = node("div", undefined, "policy-notes");
    content.append(
      node(
        "p",
        policyFamily(check) === "financial.line_items"
          ? "Repair estimate line items amounts should sum to the explicit SubTotal amount."
          : check.rule,
        "check-explanation",
      ),
    );
    const documents = checkDocuments(check);
    const entries = formulaEntries(check, documents);
    if (entries.length) {
      const fields = evidenceTable(entries, "not returned");
      fields.querySelector("table").setAttribute("aria-label", "Original extracted fields");
      content.append(fields);
    }
    const guidance = node("p");
    const studio = node("a", "CU Studio");
    studio.href = "https://contentunderstanding.ai.azure.com/build";
    studio.target = "_blank";
    studio.rel = "noopener";
    guidance.append(
      "Update and build the extractor in ",
      studio,
      " to improve extraction quality, then rerun this source PDF and see updated results.",
    );
    content.append(guidance);
    const targets = node("div");
    renderRerunDocuments(check, targets);
    content.append(targets);
    for (const doc of documents) {
      const state = doc.sourceId && previews.get(previewKey(doc));
      if (state?.preview) content.append(renderPreview(check, state.preview));
    }
    return content;
  }
  function evidenceTable(entries, missing = "missing") {
    const visible = entries.filter(
      ({ item }) => !item.field.endsWith("CurrencyCode"),
    );
    const multiple = new Set(visible.map(({ doc }) => doc.id)).size > 1;
    const section = node("div", undefined, "policy-evidence");
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
        const key = previewKey(doc);
        const state = previews.get(key);
        const line = node("form", undefined, "rerun-document");
        const name = `Updated ${doc.category.replaceAll("_", " ")} analyzer name`;
        const label = node("label", name);
        const input = node("input");
        input.value = state?.analyzerId ?? "";
        input.required = true;
        input.maxLength = 128;
        input.pattern = "[A-Za-z0-9_.-]{3,128}";
        input.placeholder = "Enter your built analyzer name";
        input.disabled = active;
        input.setAttribute("aria-label", name);
        const button = node("button", "Rerun", "secondary");
        button.type = "submit";
        button.dataset.cloud = "true";
        button.disabled = active || !input.value.trim();
        input.oninput = () => {
          const draft = previews.get(key) ?? { status: "idle" };
          draft.analyzerId = input.value.trim();
          previews.set(key, draft);
          button.disabled = active || !draft.analyzerId;
        };
        line.onsubmit = (event) => {
          event.preventDefault();
          if (input.reportValidity()) return analyze(doc, input.value.trim());
        };
        label.append(input);
        line.append(label, button);
        if (state?.status === "running") {
          const progress = node("p", undefined, "rerun-progress");
          progress.setAttribute("role", "status");
          const spinner = node("span", undefined, "spinner");
          spinner.setAttribute("aria-hidden", "true");
          progress.append(spinner, node("span", "Rerunning this source PDF..."));
          line.append(progress);
        } else if (state?.error) {
          const message = node("p", state.error, "error");
          message.setAttribute("role", "alert");
          line.append(message);
        }
        return line;
      }),
    );
  }
  function renderPreview(check, preview) {
    const section = node("section", undefined, "policy-preview");
    section.dataset.previewId = preview.id;
    section.append(
      node("h4", "Updated result"),
      node("p", `Analyzer: ${preview.analyzerId}`, "muted"),
    );
    const ids = new Set(preview.documents.map((doc) => doc.id));
    const checks = preview.policies.checks.filter(
      (value) =>
        policyFamily(value) === policyFamily(check) &&
        (value.evidence.some((item) => ids.has(item.documentId)) ||
          [...ids].some((id) => value.id.endsWith(`:${id}`))),
    );
    if (!checks.length)
      throw new Error("The rerun returned no result for this extraction check.");
    const table = node("table");
    table.setAttribute("aria-label", "Updated extraction check");
    const head = node("tr");
    head.append(node("th", "Source document"), node("th", "Problem / evidence"));
    const thead = node("thead");
    thead.append(head);
    const body = node("tbody");
    body.append(...checks.map((value) => resultRow(value, preview.documents, "rerun")));
    table.append(thead, body);
    const fields = evidenceTable(
      checks.flatMap((value) =>
        formulaEntries(
          value,
          preview.documents,
          policyFamily(value) === "financial.line_items",
        ),
      ),
      "not returned",
    );
    fields.querySelector("table").setAttribute("aria-label", "Updated extracted fields");
    section.append(table, fields);
    return section;
  }
  function resultRow(check, allDocuments, version) {
    const row = node("tr", undefined, `policy-row policy-${check.status}`);
    row.dataset.check = check.id;
    row.dataset.result = version;
    const documents = checkDocuments(check, allDocuments);
    const problem = policyProblem(check, allDocuments);
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
          version === "rerun" && policyFamily(check) === "financial.line_items",
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
    indicator.title = `${check.status === "fail" ? "Fixed check failed" : check.status === "pass" ? "Fixed check passed" : check.status === "warn" ? "Review needed" : "Not checkable"}: ${check.rule}`;
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
    if (policyFamily(check) === "cross.repair_estimates") {
      for (const doc of documents) {
        const facts = check.evidence.filter(
          (item) => item.documentId === doc.id,
        );
        const shop = facts.find((item) => item.field === "VendorName")?.value;
        const total = facts.find((item) => item.field === "TotalAmount.Amount");
        const code = facts.find(
          (item) => item.field === "TotalAmount.CurrencyCode",
        )?.value;
        const name =
          typeof shop === "string" ? shop.replace(/\s+/g, " ").trim() : documentName(doc);
        const currency = typeof code === "string" && code.trim() ? `${code.trim()} ` : "";
        const amount =
          typeof total?.value === "number" && Number.isFinite(total.value)
            ? `${currency}${total.value.toFixed(2)}`
            : "total not extracted";
        values.append(
          evidenceLink(check, doc, total?.field ?? "VendorName", `${name}: ${amount}`),
        );
      }
      if (check.status === "not_checkable")
        values.append(node("span", problem.text, "muted"));
    } else if (problem.missing.length) {
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
            ? evidenceLink(
                check,
                doc,
                field,
                label,
                true,
                version === "rerun" &&
                  policyFamily(check) === "financial.line_items",
              )
            : node("span", label),
        );
      }
    } else if (documents[0]) {
      const doc = documents[0];
      const field = focusField(check, doc);
      values.append(
        evidenceLink(
          check,
          doc,
          field,
          problem.text,
          false,
          version === "rerun" &&
            policyFamily(check) === "financial.line_items",
        ),
      );
    } else values.append(node("span", problem.text));
    line.append(indicator, values);
    issue.append(line);
    row.append(source, issue);
    row.onclick = (event) => {
      if (!event.target.closest("button, a"))
        source.querySelector(".evidence-link")?.click();
    };
    return row;
  }
  function render() {
    const order = { fail: 0, warn: 1, not_checkable: 1, pass: 2 };
    const checks = visibleChecks().sort(
      (a, b) => order[a.status] - order[b.status],
    );
    get("policy-checks").replaceChildren(
      ...checks.flatMap((check) => {
        const row = resultRow(check, report.documents, "original");
        const hasPreview = checkDocuments(check).some(
          (doc) => doc.sourceId && previews.get(previewKey(doc))?.preview,
        );
        if (policyFamily(check) === "cross.repair_estimates" ||
            (check.status === "pass" && !hasPreview))
          return [row];
        const notes = node("tr", undefined, "policy-note");
        notes.dataset.check = check.id;
        const cell = node("td");
        cell.colSpan = 2;
        cell.append(reviewNotes(check));
        notes.append(cell);
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
  return {
    reset() {
      visible = false;
      previews.clear();
      report = undefined;
      packetId = undefined;
    },
    hide() {
      visible = false;
    },
    open(id, column) {
      visible = true;
      packetId = id;
      selectedFamily = column?.id;
      report = undefined;
      select(id);
      get("review-title").textContent = `${column?.label ?? "Extraction"} results`;
      get("review-error").hidden = true;
      get("policy-checks").replaceChildren();
      try {
        report = getReport(id);
        if (!report?.source?.runId)
          throw new Error(
            "No policy report was loaded for this packet. Reload Cache Results.",
          );
        render();
        if (["financial.line_items", "financial.total"].includes(selectedFamily))
          get("policy-checks")
            .querySelector(".policy-source .evidence-link")
            ?.click();
      } catch (value) {
        error(value);
      }
    },
  };
}
