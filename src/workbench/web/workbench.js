import { previewPdf, resetPreview } from "./pdf-preview.js";
import { resizeColumns, splitPreview } from "./column-resize.js";
import { packetReviewer } from "./packet-review.js";
import { createSessionApi } from "./session-api.js";
import { createPolicyChat } from "./policy-chat.js";
import { createPolicyDocument } from "./policy-document.js";
import {
  typeNames,
  availableTypes,
  firstEntry,
  fieldColumns,
  fieldLabel,
  customerName,
  hasValue,
  itemColumns,
  itemField,
  monetarySum,
  fieldRegions,
  formatCurrency,
  formatValue,
  policyColumns,
  policyChecks,
  policySummary,
} from "./result-model.js";

const get = (id) => document.getElementById(id);
const results = new Map();
let sessionId = "";
let busy = false;
let run;
let origin = "cached";
let view = "classification";
let allFields = false;
let showConfidence = false;
let selectedPacket = "";
let selectionVersion = 0;
let watcherVersion = 0;
let clickTimer;
let focusedCell = "";
let focusedZoom = 1;
let catalog;
let expansion;
const detailPanels = {
  policy: get("packet-review"),
  items: get("array-panel"),
  agent: get("agent-panel"),
};
let policyStatus;
let policyBusy = false;
let policyAvailabilityTimer;
let policyMode = "search";
let policySource;
let policyPaneMode = "result";
const policyResults = new Map();
const policyResultScroll = new Map();
const policyCheckNames = [
  "Rental eligibility and need",
  "Daily rate",
  "Duration and repair alignment",
  "Charges and reimbursement calculation",
  "Authorization and payment readiness",
];
const policyShortNames = [
  "Rental eligibility",
  "Daily rate",
  "Rental period",
  "Reimbursement",
  "Payment readiness",
];
let focusedPolicyCheck = 0;
const columnWidths = new Map();
const textMeasure = document.createElement("canvas").getContext("2d");
function textWidth(value, bold = false) {
  textMeasure.font = `${bold ? 600 : 400} 13px "Segoe UI", Arial`;
  return Math.ceil(textMeasure.measureText(String(value)).width);
}
splitPreview(document.querySelector("main"), get("pane-splitter"));
document.querySelector("main").addEventListener("pane-resize", () => {
  if (run) renderTable();
});

const api = createSessionApi({
  storage: window.sessionStorage,
  selectedRun: () => run?.id,
  onSession: (id) => {
    sessionId = id;
  },
  onRestored: () => {
    policyChat.reset();
    queueMicrotask(() => {
      if (view === "policy" && policyPaneMode === "chat") renderPolicyOutput();
    });
    get("error").hidden = true;
    get("session-status").textContent =
      "Private session restored; saved results reloaded. Chat history was reset. No live operation was retried.";
  },
});
const policyChat = createPolicyChat({
  container: get("policy-chat"),
  api,
  onSource: openPolicySource,
  onError: fail,
});
const policyDocument = createPolicyDocument({ api, previewPdf, get });
const packetReview = packetReviewer({
  api,
  select(id) {
    clearTimeout(clickTimer);
    selectRow(id);
  },
  setBusy(value) {
    busy = value;
    controls();
  },
  getReport: (id) => results.get(id)?.policyReview,
  notify: fail,
  close: collapseDetails,
});
function updateElapsed() {
  if (!run) return;
  const end =
    run.status === "running" ? Date.now() : Date.parse(run.completedAt);
  const elapsed = Math.max(
    0,
    Math.floor((end - Date.parse(run.startedAt)) / 1000),
  );
  if (!Number.isFinite(elapsed)) return;
  const minutes = Math.floor(elapsed / 60);
  get("elapsed-time").textContent =
    `${minutes}:${String(elapsed % 60).padStart(2, "0")}`;
}
setInterval(updateElapsed, 1000);
function fail(error) {
  get("error").hidden = false;
  get("error").textContent =
    error instanceof Error ? error.message : String(error);
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const pageLabel = (segment) =>
  segment.start === segment.end
    ? `page ${segment.start}`
    : `page ${segment.start}-${segment.end}`;
const className = (category) =>
  typeNames[category] ?? (category === "tax_1099a" ? "1099-A" : category);
function arrayLabel(field) {
  const sum = monetarySum(field);
  return `${field.count} items${sum ? ` \u00b7 ${formatCurrency(sum.amount, sum.currency)}` : ""}`;
}
function controls() {
  get("analyze").disabled =
    busy || !sessionId || !catalog || !get("analyzer").value.trim();
  get("load-cache").disabled = busy || policyBusy || !get("cache").value;
  get("refresh-cache").disabled = busy || !sessionId;
  get("review-packet").disabled = busy || !run;
  for (const button of get("packet-table").querySelectorAll(
    ".packet-policy-summary, .policy-matrix-button",
  ))
    button.disabled = busy || policyBusy;
  get("policy-run").disabled =
    policyMode !== "search" ||
    busy ||
    policyBusy ||
    policyStatus?.batchRunning ||
    !run ||
    !policyStatus?.configured;
  get("policy-run").title =
    policyMode === "search"
      ? ""
      : "Select Azure Search retrieval to run policy checks.";
  get("policy-mode").disabled = !policyStatus?.configured;
}
async function caches() {
  const savedRuns = await api("cache");
  const previous = get("cache").value;
  get("cache").replaceChildren(
    ...savedRuns.map((saved) => {
      const date = new Date(saved.startedAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      const count = saved.items.filter((item) => item.rawSaved).length;
      const option = element(
        "option",
        `${date} \u00b7 ${saved.analyzer.id} \u00b7 ${count}/${saved.items.length}${saved.status === "completed" ? "" : ` \u00b7 ${saved.status}`}`,
      );
      option.value = saved.id;
      option.dataset.analyzerId = saved.analyzer.id;
      option.title = `${saved.analyzer.id} / ${saved.apiVersion}`;
      return option;
    }),
  );
  if (savedRuns.some((saved) => saved.id === previous))
    get("cache").value = previous;
  else {
    const complete = savedRuns.find((saved) => saved.status === "completed");
    if (complete) get("cache").value = complete.id;
  }
  controls();
}
async function renderRun(nextRun, nextOrigin) {
  const preloaded = nextRun.packetResults;
  if (
    nextOrigin === "cached" &&
    (!Array.isArray(preloaded) ||
      nextRun.items.some(
        (item) =>
          item.rawSaved &&
          !preloaded.some((result) => result.packet.id === item.id),
      ))
  )
    throw new Error(
      "Cached results are incomplete. Reload Cache Results after restarting the Workbench.",
    );
  const changed = run?.id !== nextRun.id || Array.isArray(preloaded);
  run = nextRun;
  origin = nextOrigin;
  if (changed) {
    ++selectionVersion;
    selectedPacket = "";
    results.clear();
    packetReview.reset();
    resetPreview();
    expansion = undefined;
    parkDetails();
    policyResults.clear();
    policyResultScroll.clear();
    policyChat.reset();
    showPolicyPanel(view === "policy");
  }
  if (preloaded)
    for (const result of preloaded) {
      result.sourceItemStatus = run.items.find(
        (item) => item.id === result.packet.id,
      )?.status;
      results.set(result.packet.id, result);
    }
  get("batch").hidden = false;
  const badge = get("origin");
  badge.textContent = `${origin === "live" ? "Live" : "Cached"}${run.status === "failed" ? " \u00b7 Failed" : ""}`;
  badge.className = `badge${origin === "live" ? " live" : ""}`;
  badge.title = `${run.analyzer.id} / ${JSON.stringify(run.analyzer.models)} / ${run.apiVersion}\n${run.startedAt}\nDataset: ${run.datasetHash}\nDefinition: ${run.analyzer.fingerprint}${origin === "cached" ? "\nHistorical native JSON; no Azure analysis." : ""}`;
  if (run.currentDatasetMatches === false)
    fail(new Error("The saved results belong to a different source dataset."));
  const completed = run.items.filter(
    (item) => item.status === "completed",
  ).length;
  const active = run.items.filter((item) => item.status === "running").length;
  get("run-progress").hidden = run.status !== "running";
  get("progress").textContent =
    `${completed} / ${run.items.length}${active ? ` \u00b7 ${active} running` : ""}`;
  get("progress-bar").max = run.items.length;
  get("progress-bar").value = completed;
  updateElapsed();
  renderTable();
  const runId = run.id;
  await Promise.all(
    run.items
      .filter(
        (item) =>
          item.rawSaved &&
          results.get(item.id)?.sourceItemStatus !== item.status,
      )
      .map(async (item) => {
        const result = await api(`packet/${item.id}`);
        result.sourceItemStatus = item.status;
        if (run?.id === runId) results.set(item.id, result);
      }),
  );
  if (run?.id !== runId) return;
  if (changed) {
    if (nextRun.agentReviews)
      for (const [mode, value] of Object.entries(nextRun.agentReviews))
        policyResults.set(mode, value);
    else await refreshPolicy();
    const job = policyResults.get(policyMode);
    if (job?.status === "running") void watchPolicy(job).catch(fail);
  }
  renderTable();
  if (run.status === "failed") {
    const failure = run.items.find((item) => item.error);
    if (failure) fail(new Error(failure.error));
  }
}
function warning(message) {
  const icon = element("span", "!", "warning-icon");
  icon.title = message;
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", message);
  return icon;
}
async function analyzers() {
  const status = await api("status");
  if (!status.endpointConfigured) {
    const option = element("option", "Cache only - no Azure endpoint");
    option.value = "";
    get("analyzer").replaceChildren(option);
    get("analyzer").disabled = true;
    return;
  }
  const items = (await api("analyzers")).filter(
    (item) => !item.id.startsWith("prebuilt-") && item.compatible,
  );
  const options = items.map((item) => {
    const option = element("option", item.name);
    option.value = item.id;
    option.disabled = !item.compatible;
    option.title = item.compatible
      ? item.id
      : "Not a ready packet classifier or router";
    return option;
  });
  get("analyzer").replaceChildren(...options);
  const preferred = items.find((item) => item.compatible);
  get("analyzer").value = preferred?.id ?? "";
  get("analyzer").disabled = !preferred;
  if (!preferred)
    throw new Error("No ready packet classifier or router is available.");
  controls();
}
function selectRow(id) {
  policySource = undefined;
  selectedPacket = id;
  for (const row of get("packet-table").querySelectorAll(
    ":scope > tbody > tr[data-packet]",
  ))
    row.classList.toggle("selected", row.dataset.packet === id);
  get("download").disabled = !results.has(id);
  controls();
}
function cellButton(text, action, className = "cell-content") {
  const button = element("button", text, className);
  button.title = text;
  const key = () =>
    `${run?.id}|${view}|${button.closest("tr[data-packet]")?.dataset.packet ?? button.dataset.packet}|${button.dataset.field ?? `${button.dataset.category ?? "customer"}:${button.dataset.instance ?? ""}`}`;
  button.onclick = () => {
    const row = button.closest("tr[data-packet]");
    if (row) selectRow(row.dataset.packet);
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      if (button.isConnected) {
        focusedCell = key();
        focusedZoom = 1;
        action({ zoom: 1 }).catch(fail);
      }
    }, 350);
  };
  button.ondblclick = () => {
    clearTimeout(clickTimer);
    const zoom =
      focusedCell === key() &&
      focusedZoom === 3 &&
      (get("pdf-stage").dataset.ready !== "true" ||
        Number(get("pdf-stage").dataset.zoom) > 1)
        ? 1
        : 3;
    focusedCell = key();
    focusedZoom = zoom;
    action({ zoom }).catch(fail);
  };
  return button;
}
function confidence(parent, value) {
  parent.querySelector(":scope > .cell-confidence")?.remove();
  parent.classList.remove("has-confidence");
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  parent.dataset.confidence = String(value);
  if (!showConfidence) return;
  const percent = Math.round(value * 100);
  const level = percent > 80 ? "high" : percent >= 50 ? "medium" : "low";
  const badge = element(
    "span",
    `${percent}%`,
    `cell-confidence confidence-${level}`,
  );
  badge.title = `${level[0].toUpperCase() + level.slice(1)} confidence`;
  badge.setAttribute("aria-label", `${percent}% ${level} confidence`);
  parent.append(badge);
  parent.classList.add("has-confidence");
}
function renderTable() {
  parkDetails();
  if (expansion?.view !== view) expansion = undefined;
  const values = run.items.map((item) => results.get(item.id)).filter(Boolean);
  const types = [...availableTypes(values), "policies", "policy"];
  if (!types.includes(view)) {
    view = "classification";
    allFields = false;
  }
  for (const button of get("view-types").querySelectorAll("[data-view]")) {
    button.hidden = !types.includes(button.dataset.view);
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  }
  get("policy-toolbar").hidden = view !== "policy";
  get("checks-description").hidden = !["policies", "policy"].includes(view);
  get("checks-description").textContent =
    view === "policy"
      ? "Agent review against rental SOPs. Satisfied does not authorize coverage or payment."
      : "Fixed field, arithmetic, and consistency checks. LLM issue diagnoses are advisory.";
  get("show-confidence").closest("label").hidden = view === "policy";
  if (view === "policy") {
    get("packet-table").classList.add("policy-grid");
    get("field-setting").hidden = true;
    renderPolicyTable();
    return;
  }
  const classification = view === "classification";
  const policyView = view === "policies";
  const policyDefinitions = policyView ? policyColumns(values, allFields) : [];
  const columns = policyView
    ? policyDefinitions.map((column) => column.id)
    : classification
      ? [
          ...new Set(
            values.flatMap((result) =>
              (result.review?.segments ?? [])
                .filter((segment) => segment.category !== "other")
                .map((segment) => segment.category),
            ),
          ),
        ]
      : fieldColumns(values, view, allFields);
  if (classification && run.status === "running")
    for (const category of Object.keys(run.analyzer.categories))
      if (category !== "other" && !columns.includes(category))
        columns.push(category);
  const classOrder = [
    "id_document",
    "tax_1099a",
    "repair_estimate",
    "statement",
    "towing_invoice",
    "rental_invoice",
  ];
  if (classification)
    columns.sort((a, b) => classOrder.indexOf(a) - classOrder.indexOf(b));
  get("field-setting").hidden = classification || !columns.length;
  get("all-fields").checked = allFields;
  get("field-setting-label").textContent = policyView
    ? "All checks"
    : "All fields";
  get("field-setting").title = policyView
    ? "Primary checks keep every warning/error, plus Amount balance and Claimant match. Enable All checks to show clean checks too."
    : "Show all returned fields.";
  get("confidence-setting").hidden = policyView;
  get("packet-table").classList.toggle("policy-grid", policyView);
  get("packet-table").setAttribute(
    "aria-label",
    policyView ? "Policy checks across packets" : "Customer results",
  );
  const head = element("tr");
  head.append(element("th", "Customer/Packet"));
  for (const column of columns) {
    const th = element(
      "th",
      policyView
        ? policyDefinitions.find((item) => item.id === column).label
        : classification
          ? className(column)
          : fieldLabel(column),
    );
    th.title = policyView
      ? policyDefinitions.find((item) => item.id === column).description
      : column;
    th.dataset.column = column;
    head.append(th);
  }
  const customerWidth =
    columnWidths.get("customer") ??
    Math.max(
      160,
      ...run.items.map(
        (item, index) =>
          textWidth(
            `#${index + 1} ${customerName(results.get(item.id))}`,
            true,
          ) +
          28 +
          (!policyView && values.some((result) => result.policies) ? 78 : 0),
      ),
    );
  const natural = columns.map((column) => {
    if (policyView)
      return Math.max(
        82,
        ...policyDefinitions
          .find((item) => item.id === column)
          .label.split(" ")
          .map((word) => textWidth(word, true) + 24),
      );
    const heading =
      textWidth(
        policyView
          ? policyDefinitions.find((item) => item.id === column).label
          : classification
            ? className(column)
            : fieldLabel(column),
        true,
      ) + 28;
    if (classification)
      return Math.max(
        heading,
        ...values.map(
          (result) =>
            Math.max(
              1,
              (result.review?.segments ?? []).filter(
                (segment) => segment.category === column,
              ).length,
            ) * 110,
        ),
      );
    const content = values.flatMap((result) => {
      const entry = firstEntry(result, view).entry;
      const field = entry?.document.fields.find(
        (field) => field.field === column,
      );
      if (!hasValue(field)) return [];
      return [
        textWidth(
          field.kind === "array"
            ? arrayLabel(field)
            : formatValue(field, entry.document.facts),
        ) + (field.kind === "array" ? 54 : 24),
      ];
    });
    return Math.min(420, Math.max(heading, 70, ...content));
  });
  const fixed = columns.reduce(
    (sum, column) => sum + (columnWidths.get(`${view}:${column}`) ?? 0),
    0,
  );
  const autoCount = columns.filter(
    (column) => !columnWidths.has(`${view}:${column}`),
  ).length;
  const needed = natural.reduce(
    (sum, width, index) =>
      sum + (columnWidths.has(`${view}:${columns[index]}`) ? 0 : width),
    0,
  );
  const available = Math.max(
    0,
    get("packets").clientWidth - customerWidth - fixed,
  );
  const extra = Math.max(0, available - needed);
  const widths = columns.map(
    (column, index) =>
      columnWidths.get(`${view}:${column}`) ??
      natural[index] + Math.floor(extra / Math.max(1, autoCount)),
  );
  get("packet-table").style.width =
    `${customerWidth + widths.reduce((sum, value) => sum + value, 0)}px`;
  get("packet-table")
    .querySelector("colgroup")
    .replaceChildren(
      ...[customerWidth, ...widths].map((width) => {
        const col = element("col");
        col.style.width = `${width}px`;
        return col;
      }),
    );
  get("packet-table").querySelector("thead").replaceChildren(head);
  const widthKeys = [
    "customer",
    ...columns.map((column) => `${view}:${column}`),
  ];
  resizeColumns(
    get("packet-table"),
    [customerWidth, ...widths],
    (index, width) => {
      columnWidths.set(widthKeys[index], width);
      sizeDetails();
    },
  );
  get("packet-table")
    .querySelector("tbody")
    .replaceChildren(
      ...run.items.map((item, index) => {
        const result = results.get(item.id);
        const row = element("tr");
        row.dataset.packet = item.id;
        row.classList.toggle("selected", selectedPacket === item.id);
        const label = element("td");
        const customer = element("div", undefined, "customer-cell");
        const name = `#${index + 1}${customerName(result) ? ` ${customerName(result)}` : ""}`;
        const button = cellButton(name, (options) =>
          showCustomer(item.id, options),
        );
        button.title = `${name} / ${item.id}`;
        button.disabled = !result;
        customer.append(button);
        if (result?.policies && !policyView) {
          const count = result.policies.counts.fail;
          const check = element(
            "button",
            count ? `${count} review` : "Checks",
            `packet-policy-summary${count ? " needs-review" : ""}`,
          );
          check.title = `${count} fixed policy checks need attention. A check result is not a claim decision.`;
          check.disabled = busy;
          check.onclick = () => showPolicyView(item.id);
          customer.append(check);
        }
        if (item.status === "running") {
          const spinner = element("span", undefined, "spinner");
          spinner.setAttribute("role", "img");
          spinner.setAttribute("aria-label", "Analyzing");
          customer.append(spinner);
        }
        if (item.error || result?.reviewError || result?.packetJsonError)
          customer.append(
            warning(item.error ?? result.reviewError ?? result.packetJsonError),
          );
        const selected = firstEntry(result, view);
        if (!classification && !policyView && selected.count > 1)
          customer.append(
            warning(
              `${selected.count} ${typeNames[view]} documents. Showing the first.`,
            ),
          );
        label.append(customer);
        row.append(label);
        for (const column of columns) {
          const cell = element("td");
          if (policyView) {
            const checks = policyChecks(result, column);
            const summary = policySummary(checks);
            const definition = policyDefinitions.find(
              (item) => item.id === column,
            );
            if (summary) {
              const status =
                summary.status === "pass"
                  ? "Pass"
                  : summary.status === "fail"
                    ? "Error"
                    : "Warn";
              const button = element(
                "button",
                `${status}${summary.counts[summary.status] > 1 ? ` (${summary.counts[summary.status]})` : ""}`,
                `cell-content policy-matrix-button policy-${summary.status}`,
              );
              button.dataset.policy = column;
              button.setAttribute("aria-expanded", "false");
              button.disabled = busy;
              button.title = `${definition.description}\nWorst of ${summary.total} document checks: ${summary.counts.fail} errors, ${summary.counts.not_checkable} warnings, ${summary.counts.pass} passed.\n${checks.map((check) => check.message).join("\n")}`;
              button.setAttribute(
                "aria-label",
                `${name}, ${definition.label}, ${status}, worst of ${summary.total} document checks`,
              );
              button.onclick = () =>
                showPolicyDetails(item.id, definition).catch(fail);
              cell.append(button);
            } else {
              cell.textContent = "\u2014";
              cell.title = "No applicable extracted document for this check.";
            }
          } else if (classification) {
            const segments = (result?.review?.segments ?? []).filter(
              (segment) => segment.category === column,
            );
            if (segments.length) {
              cell.className = "classification-result";
              const group = element("div", undefined, "classification-cell");
              group.style.setProperty("--instances", String(segments.length));
              for (const [index, segment] of segments.entries()) {
                const check = element("span", undefined, "check");
                check.setAttribute("role", "img");
                check.setAttribute("aria-label", "Classified");
                const button = cellButton(
                  "",
                  (options) =>
                    inspect(item.id, segment, undefined, undefined, options),
                  "class-instance",
                );
                button.dataset.category = column;
                button.dataset.instance = index + 1;
                button.title = pageLabel(segment);
                button.setAttribute(
                  "aria-label",
                  `${name}, ${className(column)}, instance ${index + 1}, ${pageLabel(segment)}`,
                );
                button.append(check, element("span", pageLabel(segment)));
                confidence(button, segment.confidence);
                group.append(button);
              }
              cell.append(group);
            }
          } else if (selected.entry) {
            const field = selected.entry.document.fields.find(
              (field) => field.field === column,
            );
            if (hasValue(field)) {
              const text =
                field.kind === "array"
                  ? arrayLabel(field)
                  : formatValue(field, selected.entry.document.facts);
              const button = cellButton(text, (options) =>
                inspect(
                  item.id,
                  selected.entry.segment,
                  field,
                  selected.entry.document,
                  options,
                ),
              );
              button.dataset.field = column;
              if (field.kind === "array") {
                const group = element("div", undefined, "array-cell");
                const open = element(
                  "button",
                  undefined,
                  "icon-button array-open",
                );
                open.append(element("span", undefined, "table-icon"));
                open.dataset.field = column;
                open.setAttribute("aria-expanded", "false");
                open.title = "Expand item table";
                open.setAttribute(
                  "aria-label",
                  `Open ${fieldLabel(column)} for ${name}`,
                );
                open.onclick = () => {
                  inspect(
                    item.id,
                    selected.entry.segment,
                    field,
                    selected.entry.document,
                    { zoom: 1 },
                  ).catch(fail);
                  showArray(item.id, selected.entry, field);
                };
                group.append(button, open);
                cell.append(group);
              } else {
                if (typeof field.value === "number") cell.className = "numeric";
                cell.append(button);
                confidence(cell, field.confidence);
              }
            }
          }
          row.append(cell);
        }
        return row;
      }),
    );
  mountDetails(columns.length);
}
function parkDetails() {
  get("inline-panels").append(...Object.values(detailPanels));
}
function collapseDetails() {
  packetReview.reset();
  expansion = undefined;
  renderTable();
}
function expandDetails(packetId, kind, key) {
  if (
    expansion?.packetId === packetId &&
    expansion.kind === kind &&
    expansion.key === key &&
    expansion.view === view
  ) {
    collapseDetails();
    return false;
  }
  expansion = { packetId, kind, key, view };
  selectRow(packetId);
  renderTable();
  return true;
}
function sizeDetails() {
  if (!expansion) return;
  const owner = get("packet-table").querySelector(
    ":scope > tbody > .expanded-packet",
  );
  if (!owner) return;
  const left = owner.cells[0].getBoundingClientRect().width;
  const panel = detailPanels[expansion.kind];
  panel.style.setProperty("--inline-left", `${left}px`);
  panel.style.setProperty(
    "--inline-width",
    `${Math.max(0, get("packets").clientWidth - left - 2)}px`,
  );
}
function mountDetails(columnCount) {
  if (!expansion || !columnCount) return;
  const owner = [...get("packet-table").querySelector("tbody").children].find(
    (row) => row.dataset.packet === expansion.packetId,
  );
  if (!owner) return;
  const row = element("tr", undefined, "inline-detail-row");
  row.id = "inline-details";
  row.dataset.detailFor = expansion.packetId;
  const cell = element("td");
  cell.colSpan = columnCount;
  const panel = detailPanels[expansion.kind];
  cell.append(panel);
  row.append(cell);
  owner.cells[0].rowSpan = 2;
  owner.classList.add("expanded-packet");
  owner.after(row);
  sizeDetails();
  const button = [
    ...owner.querySelectorAll(
      expansion.kind === "policy"
        ? "[data-policy]"
        : expansion.kind === "agent"
          ? "[data-agent-check]"
          : ".array-open",
    ),
  ].find(
    (button) =>
      (button.dataset.policy ??
        button.dataset.agentCheck ??
        button.dataset.field) === expansion.key,
  );
  if (button) {
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-controls", row.id);
    button.closest("td").classList.add("expanded-cell");
  }
}
async function showPolicyDetails(id, definition) {
  if (expandDetails(id, "policy", definition.id))
    await packetReview.open(id, definition);
}
function showPolicyView(packetId) {
  view = "policies";
  allFields = false;
  renderTable();
  if (packetId) selectRow(packetId);
}
async function showCustomer(id, options) {
  const result = results.get(id);
  const entry = firstEntry(result, view).entry;
  const segment =
    entry?.segment ??
    result?.review?.segments.find(
      (segment) => segment.category === "id_document",
    ) ??
    result?.review?.segments[0];
  const document = entry?.document ?? segment?.documents[0];
  const named = document?.facts.find(
    (fact) => fact.field === "CustomerName" && hasValue(fact),
  );
  const names = (document?.facts ?? []).filter(
    (fact) => ["FirstName", "LastName"].includes(fact.field) && hasValue(fact),
  );
  const field =
    named ??
    (names.length
      ? { ...names[0], regions: names.flatMap((fact) => fact.regions) }
      : undefined);
  await inspect(id, segment, field, document, options);
}
async function inspect(id, segment, field, document, options) {
  policyDocument.close();
  policySource = undefined;
  get("policy-source-toolbar").hidden = true;
  get("download").hidden = false;
  get("pdf-scroll").hidden = false;
  const current = ++selectionVersion;
  selectRow(id);
  const regions = fieldRegions(field, document);
  await previewPdf(
    `/data/packets/${id}.pdf`,
    regions[0]?.page ?? segment?.start ?? 1,
    regions,
    options,
  );
  if (current !== selectionVersion) return;
  get("pdf-status").textContent =
    field && field.kind !== "array" && !regions.length
      ? "No highlight returned"
      : "";
  get("pdf-status").hidden = !get("pdf-status").textContent;
}
function showArray(id, entry, field) {
  if (!expandDetails(id, "items", field.field)) return;
  get("array-title").textContent = fieldLabel(field.field);
  get("array-summary").textContent = arrayLabel(field);
  const columns = itemColumns(field);
  const widths = columns.map(
    (column) =>
      columnWidths.get(`items:${field.field}:${column}`) ??
      (column === "Description"
        ? 340
        : column === "Quantity"
          ? 90
          : /Amount$/.test(column)
            ? 135
            : 160),
  );
  const totalWidth = 48 + widths.reduce((sum, width) => sum + width, 0);
  const extra = Math.max(0, 640 - totalWidth);
  if (widths.length)
    widths[Math.max(0, columns.indexOf("Description"))] += extra;
  const table = element("table");
  table.style.width = `${totalWidth + extra}px`;
  const colgroup = element("colgroup");
  for (const width of [48, ...widths]) {
    const col = element("col");
    col.style.width = `${width}px`;
    colgroup.append(col);
  }
  const head = element("tr");
  head.append(element("th", "#"));
  for (const column of columns) {
    const th = element("th", fieldLabel(column));
    th.dataset.column = column;
    th.title = column;
    const values = field.items.flatMap((item) =>
      item
        .filter(
          (fact) =>
            itemField(fact.field, field.field) === column && hasValue(fact),
        )
        .map((fact) => fact.value),
    );
    if (values.length && values.every((value) => typeof value === "number"))
      th.className = "numeric";
    head.append(th);
  }
  const thead = element("thead");
  thead.append(head);
  const tbody = element("tbody");
  for (const [index, facts] of field.items.entries()) {
    const row = element("tr");
    row.append(element("td", String(index + 1)));
    for (const column of columns) {
      const cell = element("td");
      const fact = facts.find(
        (fact) => itemField(fact.field, field.field) === column,
      );
      if (hasValue(fact)) {
        const text = formatValue(fact, facts);
        const button = cellButton(text, async (options) => {
          await inspect(id, entry.segment, fact, entry.document, options);
        });
        button.dataset.field = fact.field;
        button.dataset.packet = id;
        if (typeof fact.value === "number") cell.className = "numeric";
        cell.append(button);
      }
      row.append(cell);
    }
    tbody.append(row);
  }
  table.append(colgroup, thead, tbody);
  resizeColumns(table, [48, ...widths], (index, width) => {
    if (index > 0)
      columnWidths.set(`items:${field.field}:${columns[index - 1]}`, width);
  });
  get("array-table").replaceChildren(table);
}
for (const button of get("view-types").querySelectorAll("[data-view]"))
  button.onclick = () => {
    clearTimeout(clickTimer);
    ++selectionVersion;
    view = button.dataset.view;
    allFields = false;
    showPolicyPanel(view === "policy");
    renderTable();
    if (view === "policy") renderPolicyOutput();
    else if (selectedPacket) showCustomer(selectedPacket).catch(fail);
  };
get("all-fields").onchange = () => {
  allFields = get("all-fields").checked;
  renderTable();
};
get("show-confidence").onchange = () => {
  showConfidence = get("show-confidence").checked;
  for (const cell of get("packet-table").querySelectorAll("[data-confidence]"))
    confidence(cell, Number(cell.dataset.confidence));
};
get("close-array").onclick = collapseDetails;
get("analyzer").onchange = controls;
get("cache").onchange = controls;
get("analyze").onclick = () => {
  if (busy || !catalog) return;
  const dialog = get("run-confirmation");
  get("confirm-summary").textContent =
    `${catalog.packets.length} packets \u00b7 ${catalog.packets.reduce((sum, packet) => sum + packet.pages, 0)} pages \u00b7 up to 5 at once`;
  dialog.showModal();
  const anchor = get("analyze").getBoundingClientRect();
  dialog.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - dialog.offsetWidth - 12))}px`;
  dialog.style.top = `${Math.min(anchor.bottom + 8, window.innerHeight - dialog.offsetHeight - 12)}px`;
};
get("cancel-run").onclick = () => get("run-confirmation").close();
get("confirm-run").onclick = async () => {
  if (busy) return;
  get("run-confirmation").close();
  ++watcherVersion;
  busy = true;
  get("error").hidden = true;
  controls();
  try {
    await api("connect", { analyzerId: get("analyzer").value.trim() });
    await renderRun(
      await api("batch", {
        live: true,
      }),
      "live",
    );
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const current = await api("batch");
      await renderRun(current.run, "live");
      if (!current.busy) {
        await caches();
        get("cache").value = current.run.id;
        if (current.run.status === "failed")
          throw new Error(current.error ?? "Analysis failed.");
        break;
      }
    }
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    controls();
  }
};
get("load-cache").onclick = async () => {
  const current = ++watcherVersion;
  busy = true;
  get("error").hidden = true;
  get("cache-loading").hidden = false;
  get("batch").setAttribute("aria-busy", "true");
  controls();
  try {
    const id = get("cache").value;
    await renderRun(await api("cache/load", { runId: id }), "cached");
    if (run.status === "running") {
      void (async () => {
        while (
          current === watcherVersion &&
          run?.id === id &&
          run.status === "running"
        ) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          if (current !== watcherVersion) return;
          await renderRun(await api("cache/load", { runId: id }), "cached");
        }
        if (current === watcherVersion) await caches();
      })().catch(fail);
    }
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    get("cache-loading").hidden = true;
    get("batch").removeAttribute("aria-busy");
    controls();
  }
};
get("refresh-cache").onclick = () => caches().catch(fail);
async function downloadNative(route, filename) {
  const response = await api(route);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(response, null, 2)], { type: "application/json" }),
  );
  const link = element("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
get("download").onclick = async () => {
  const id = selectedPacket;
  try {
    await downloadNative(`raw/${id}`, `${id}.cu.json`);
  } catch (error) {
    fail(error);
  }
};
api("session", {})
  .then(async (value) => {
    sessionId = value.sessionId;
    if (value.policyMode) {
      policyMode = value.policyMode;
      view = "policy";
    }
    await Promise.all([
      caches(),
      analyzers(),
      api("packets").then((data) => (catalog = data)),
      api("policy/status").then((value) => {
        policyStatus = value;
        get("policy-mode").replaceChildren();
        if (value.configured) {
          const modes = Object.keys(value.modes);
          get("policy-mode").replaceChildren(
            ...modes.map((mode) => {
              const option = element("option", policyModeLabel(mode));
              option.value = mode;
              return option;
            }),
          );
          if (!modes.includes(policyMode)) policyMode = modes[0];
          get("policy-mode").value = policyMode;
        }
        get("policy-mode").disabled = !value.configured;
        policyMessage();
      }),
    ]);
    const cachedAnalyzer = get("cache").selectedOptions[0]?.dataset.analyzerId;
    if (
      [...get("analyzer").options].some(
        (option) => option.value === cachedAnalyzer,
      )
    )
      get("analyzer").value = cachedAnalyzer;
    if (value.runId) {
      await renderRun(await api("cache/current"), "cached");
    }
    if (policyStatus?.batchRunning && !policyBusy)
      void updatePolicyAvailability().catch(fail);
    controls();
  })
  .catch((error) => {
    get("policy-mode").replaceChildren();
    get("policy-mode").disabled = true;
    fail(error);
  });

function showPolicyPanel(show) {
  policyDocument.close();
  policySource = undefined;
  get("policy-source-toolbar").hidden = true;
  get("download").hidden = false;
  get("policy-pane-modes").hidden = !show;
  get("policy-output").hidden = !show || policyPaneMode !== "result";
  get("policy-chat").hidden = !show || policyPaneMode !== "chat";
  get("pdf-scroll").hidden = false;
}
function policyMessage() {
  const mode = policyStatus?.modes?.[policyMode];
  get("policy-status").title = policyStatus?.message ?? "";
  get("policy-status").textContent =
    policyStatus?.batchRunning && !policyBusy
      ? "A policy batch is already running. Waiting for it to finish; no duplicate will be submitted. Reload this tab to reconnect to its progress."
      : mode
        ? `${mode.indexName ?? "No policy retrieval"} · ${mode.extractionMode === "standard" ? "Search-managed CU extraction" : "CU Layout"}`
        : (policyStatus?.message ?? "Policy configuration is loading.");
}
function policyModeLabel(mode = policyMode) {
  return mode === "search" ? "Azure Search retrieval" : "No policy retrieval";
}
async function updatePolicyAvailability() {
  clearTimeout(policyAvailabilityTimer);
  policyStatus = await api("policy/status");
  controls();
  if (policyStatus.batchRunning && !policyBusy) {
    policyMessage();
    policyAvailabilityTimer = setTimeout(
      () => updatePolicyAvailability().catch(fail),
      2500,
    );
  } else if (!policyBusy) policyMessage();
}
async function refreshPolicy(mode = policyMode) {
  if (!run) return;
  const id = run.id;
  const value = await api(`policy/results?mode=${mode}`);
  if (run?.id !== id || value.runId !== id) return;
  if (value.configurationMessage) {
    policyStatus = { configured: false, message: value.configurationMessage };
    policyMessage();
    controls();
  }
  policyResults.set(mode, value);
  if (view === "policy" && mode === policyMode) {
    renderTable();
    renderPolicyOutput();
  }
}
async function watchPolicy(job) {
  if (policyBusy) return;
  policyBusy = true;
  controls();
  const { mode, runId } = job;
  try {
    while (run?.id === runId) {
      const status = policyResults.get(mode);
      const completed = status.items.filter((item) =>
        ["completed", "failed"].includes(item.status),
      ).length;
      const active = status.items.find((item) =>
        ["extracting", "reviewing"].includes(item.status),
      );
      const elapsed = Math.max(
        0,
        Math.floor((Date.now() - Date.parse(job.startedAt)) / 1000),
      );
      get("policy-status").textContent =
        `${completed}/${status.items.length} cases · ${policyModeLabel(mode)} · ${status.status}` +
        (active
          ? ` · ${active.id}: ${active.status === "extracting" ? "Extracting claim fields with CU (also required without retrieval)" : "Agent checking rules"}`
          : "") +
        ` · ${Math.floor(elapsed / 60)}m ${elapsed % 60}s elapsed`;
      if (status.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 1400));
      await refreshPolicy(mode);
    }
    if (run?.id === runId) {
      await Promise.all(
        run.items
          .filter((item) => item.rawSaved)
          .map(async ({ id }) => {
            const value = await api(`packet/${id}`);
            if (run?.id === value.packetJson?.analysis.run_id)
              results.set(id, value);
          }),
      );
      renderTable();
    }
  } catch (error) {
    throw new Error(
      `Policy progress could not be refreshed: ${error.message}. The server batch may still be running. Reload this tab to reconnect; do not submit another batch.`,
    );
  } finally {
    policyBusy = false;
    await updatePolicyAvailability();
  }
}
function renderPolicyTable() {
  get("field-setting").hidden = true;
  const table = get("packet-table");
  const keys = [
    "customer",
    ...policyCheckNames.map((check) => `policy:${check}`),
  ];
  const widths = keys.map(
    (key, index) => columnWidths.get(key) ?? (index ? 185 : 190),
  );
  table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
  table.querySelector("colgroup").replaceChildren(
    ...widths.map((width) => {
      const col = element("col");
      col.style.width = `${width}px`;
      return col;
    }),
  );
  const head = element("tr");
  head.append(element("th", "Customer/Packet"));
  for (const [index, label] of policyCheckNames.entries()) {
    const cell = element("th", policyShortNames[index]);
    cell.title = label;
    head.append(cell);
  }
  table.querySelector("thead").replaceChildren(head);
  resizeColumns(table, widths, (index, width) => {
    columnWidths.set(keys[index], width);
    sizeDetails();
  });
  const items = policyResults.get(policyMode)?.items ?? [];
  table.querySelector("tbody").replaceChildren(
    ...run.items.map((packet, index) => {
      const row = element("tr");
      row.dataset.packet = packet.id;
      row.classList.toggle("selected", selectedPacket === packet.id);
      const item = items.find((item) => item.id === packet.id);
      const customer = customerName(results.get(packet.id));
      const label = element("td");
      const name = element(
        "button",
        `#${index + 1} ${customer || packet.id}`,
        "cell-content",
      );
      name.onclick = () => openAgentCheck(packet.id, 0);
      label.append(name);
      if (!results.get(packet.id)?.claimSummaryPrepared)
        label.append(
          element("span", "Claim fields not prepared", "policy-preparation"),
        );
      row.append(label);
      for (let column = 0; column < policyCheckNames.length; column++) {
        const cell = element("td");
        const check = item?.result?.Checks[column];
        const text = check
          ? check.Outcome === "NotApplicable"
            ? "Not applicable"
            : check.ReviewRequired
              ? "Review required"
              : "Satisfied"
          : item?.status === "failed"
            ? "Run error"
            : ({
                pending: "Queued",
                extracting: "Extracting claim",
                reviewing: "Checking rules",
              }[item?.status] ?? "Not run");
        const button = element("button", text, "cell-content");
        const state = element(
          "span",
          text,
          `policy-state ${check ? (check.Outcome === "NotApplicable" ? "policy-na" : check.ReviewRequired ? "policy-review" : "policy-satisfied") : item?.error ? "policy-error" : ""}`,
        );
        button.replaceChildren(state);
        button.title =
          check?.Reason ??
          item?.error ??
          "Run policy checks explicitly for this extraction mode.";
        button.dataset.agentCheck = String(column);
        button.setAttribute("aria-expanded", "false");
        button.onclick = () => openAgentCheck(packet.id, column);
        cell.append(button);
        row.append(cell);
      }
      return row;
    }),
  );
  mountDetails(policyCheckNames.length);
}
function openAgentCheck(packetId, column) {
  if (!expandDetails(packetId, "agent", String(column))) return;
  focusedPolicyCheck = column;
  renderPolicyOutput(column);
  void showAgentClaim(packetId).catch(fail);
}
async function showAgentClaim(packetId) {
  const result = results.get(packetId);
  const segment =
    result?.review?.segments.find(
      (segment) => segment.category === "rental_invoice",
    ) ?? result?.review?.segments[0];
  await inspect(packetId, segment, undefined, segment?.documents[0], {
    zoom: 1,
  });
}
function renderPolicyOutput(focused) {
  if (view !== "policy" || policySource) return;
  if (focused !== undefined) focusedPolicyCheck = focused;
  showPolicyPanel(true);
  if (policyPaneMode === "chat" && selectedPacket) {
    const item = policyResults
      .get(policyMode)
      ?.items.find((item) => item.id === selectedPacket);
    policyChat
      .show({
        runId: run.id,
        mode: policyMode,
        packetId: selectedPacket,
        resultId: `${item?.inputHash ?? ""}:${item?.completedAt ?? ""}:${item?.indexName ?? ""}`,
      })
      .catch(fail);
  }
  const panel = get("policy-output");
  get("agent-title").textContent = policyCheckNames[focusedPolicyCheck];
  panel.replaceChildren();
  if (!selectedPacket) {
    panel.append(
      element(
        "p",
        "Select a case to see the agent's checks, reasons and rule sources.",
      ),
    );
    return;
  }
  const item = policyResults
    .get(policyMode)
    ?.items.find((item) => item.id === selectedPacket);
  if (!item?.result) {
    panel.append(
      element(
        "p",
        item?.error ??
          (item && item.status !== "not run"
            ? `Status: ${item.status}`
            : "Not run for this mode and packet. Select Run policy checks to evaluate."),
        item?.error ? "error" : "muted",
      ),
    );
    return;
  }
  for (const [index, check] of item.result.Checks.entries()) {
    if (index !== focusedPolicyCheck) continue;
    const section = element("section", undefined, "policy-check");
    section.id = `policy-check-${index}`;
    section.append(
      element(
        "span",
        check.Outcome === "NotApplicable"
          ? "Not applicable"
          : check.ReviewRequired
            ? "Review required"
            : "Satisfied",
        `policy-state ${check.Outcome === "NotApplicable" ? "policy-na" : check.ReviewRequired ? "policy-review" : "policy-satisfied"}`,
      ),
    );
    const values = element("dl", undefined, "policy-values");
    for (const [label, value] of [
      ["Expected", check.ExpectedValue],
      ["Actual", check.ActualValue],
    ]) {
      const description = element("dd");
      description.append(element("strong", value));
      values.append(element("dt", `${label}:`), description);
    }
    section.append(values);
    const reasoning = element("p", undefined, "policy-reasoning");
    reasoning.append(element("em", `Reasoning: ${check.Reason}`));
    section.append(reasoning, element("p", "Source:", "policy-source-label"));
    const citations = item.citations?.[index] ?? [];
    if (!citations.length)
      section.append(element("p", "No applicable rule source cited.", "muted"));
    for (const citation of citations) {
      const label = `${citation.DocumentId} v${citation.Version.replace(/^v(?=\d)/, "")} · ${citation.RuleId} · ${citation.Section}`;
      if (citation.href?.startsWith("/data/policies/rental/")) {
        const link = element("a", label);
        link.href = citation.href;
        link.onclick = (event) => {
          event.preventDefault();
          openPolicySource(citation, link).catch(fail);
        };
        section.append(link);
      } else
        section.append(
          element(
            "p",
            `${label} — source not verified; no link generated.`,
            "muted",
          ),
        );
    }
    panel.append(section);
  }
  const details = element("details");
  details.append(
    element("summary", "Structured output and provenance"),
    element(
      "p",
      `${item.cached ? "Cached" : "Live"} · ${item.indexName ?? "No policy retrieval"}`,
      "muted",
    ),
    element(
      "p",
      `Evaluated ${new Date(item.completedAt).toLocaleString()}. Satisfied does not mean coverage or payment approval.`,
      "muted",
    ),
    element("pre", JSON.stringify(item.result, null, 2)),
  );
  panel.append(details);
  if (focused !== undefined && policyPaneMode === "result")
    get(`policy-check-${focused}`)?.scrollIntoView({ block: "nearest" });
}
async function openPolicySource(citation, link) {
  const match =
    /^\/data\/policies\/rental\/((?:ocr-comparison-v2\/)?[a-z0-9-]+\.pdf)#page=([1-9]\d*)$/.exec(
      citation.href,
    );
  if (!match)
    throw new Error("The policy source link is not a verified local PDF.");
  policySource = {
    link,
    scrollTop: get("packets").scrollTop,
  };
  get("pdf-scroll").hidden = false;
  get("policy-source-toolbar").hidden = false;
  get("policy-source-title").textContent =
    `${citation.DocumentId} · ${citation.RuleId} · ${citation.Section}`;
  get("download").hidden = true;
  get("policy-source-back").textContent = "Back to claim document";
  get("policy-source-back").focus();
  await policyDocument.open(
    `/data/policies/rental/${match[1]}`,
    Number(match[2]),
  );
}
get("policy-source-back").onclick = () => {
  const previous = policySource;
  showPolicyPanel(true);
  void showAgentClaim(selectedPacket).catch(fail);
  get("packets").scrollTop = previous?.scrollTop ?? 0;
  previous?.link.focus({ preventScroll: true });
};
get("close-agent").onclick = collapseDetails;
for (const mode of ["result", "chat"])
  get(`policy-${mode}-mode`).onclick = () => {
    const key = `${run?.id}:${policyMode}:${selectedPacket}`;
    if (policyPaneMode === "result")
      policyResultScroll.set(key, get("packets").scrollTop);
    policyPaneMode = mode;
    for (const value of ["result", "chat"]) {
      const button = get(`policy-${value}-mode`);
      button.setAttribute("aria-pressed", String(value === mode));
      button.classList.toggle("secondary", value !== mode);
    }
    showPolicyPanel(true);
    renderPolicyOutput();
    if (mode === "result")
      get("packets").scrollTop = policyResultScroll.get(key) ?? 0;
  };
get("policy-mode").onchange = async () => {
  policyMode = get("policy-mode").value;
  controls();
  showPolicyPanel(true);
  if (selectedPacket) void showAgentClaim(selectedPacket).catch(fail);
  policyMessage();
  renderTable();
  renderPolicyOutput();
  try {
    await refreshPolicy();
  } catch (error) {
    fail(error);
  }
};
get("policy-run").onclick = () => {
  if (get("policy-run").disabled) return;
  get("policy-confirm-summary").textContent =
    `${run.items.filter((item) => item.rawSaved).length} cases · ${policyModeLabel()}. ` +
    "Cases run sequentially. Missing claim fields are extracted with CU first, even without policy retrieval.";
  get("policy-confirmation").showModal();
};
get("cancel-policy").onclick = () => get("policy-confirmation").close();
get("confirm-policy").onclick = async () => {
  if (policyMode !== "search" || busy || policyBusy) return;
  get("policy-confirmation").close();
  busy = true;
  get("error").hidden = true;
  controls();
  const mode = policyMode;
  try {
    const job = await api("policy/batch", { mode, live: true });
    policyResults.set(mode, job);
    if (view === "policy") {
      renderTable();
      renderPolicyOutput();
    }
    await watchPolicy(job);
  } catch (error) {
    fail(error);
  } finally {
    policyBusy = false;
    busy = false;
    try {
      await updatePolicyAvailability();
    } catch (error) {
      fail(error);
    }
    controls();
  }
};
