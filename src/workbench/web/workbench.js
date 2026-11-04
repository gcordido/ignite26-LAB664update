import { previewPdf, resetPreview } from "./pdf-preview.js";
import { resizeColumns, splitPreview } from "./column-resize.js";
import { packetReviewer } from "./packet-review.js";
import { createSessionApi } from "./session-api.js";
import { createPolicyChat } from "./policy-chat.js";
import { createPolicyDocument } from "./policy-document.js";
import { claimFieldSources, policyRuleSources } from "./policy-evidence-links.js";
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
let liveCallsEnabled = false;
let run;
let origin = "cached";
let view = "classification";
let lastExtractionView = "classification";
let allFields = false;
let showConfidence = false;
let selectedPacket = "";
let selectionVersion = 0;
let watcherVersion = 0;
let clickTimer;
let focusedCell = "";
let focusedZoom = 1;
let catalog;
let savedExtractionRun;
let savedPolicyEntries = [];
let expansion;
const detailPanels = {
  policy: get("packet-review"),
  items: get("array-panel"),
  agent: get("agent-panel"),
};
let policyStatus;
let policyBusy = false;
let policyAvailabilityTimer;
const policyMode = "search";
let policySource;
const claimEvidenceRequests = new Map();
let policyPaneMode = "result";
let pendingPolicyRun;
const policyResults = new Map();
const policyPolls = new Map();
const policyProgressErrors = new Map();
let policyCacheBusy = false;
let policyCacheVersion = 0;
const policyResultScroll = new Map();
const policyCheckNames = [
  "Daily rate",
  "Effective terms",
  "Repair estimate",
];
const policyShortNames = [...policyCheckNames];
const policyCheckDescriptions = [
  "Is the claimed daily base rate within the effective insured-vehicle cap?",
  "Were the matched policy and genuine amendment in force on the actual loss date?",
  "Is each supplied repair-estimate total within this state's routine review authority?",
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
const policyDocument = createPolicyDocument({
  api, previewPdf, get, liveCallsEnabled: () => liveCallsEnabled,
});
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
setInterval(updatePolicyActivity, 1000);
function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  get("error").hidden = false;
  get("error").textContent = message;
  if (get("app-settings").open) {
    get("settings-error").textContent = message;
    get("settings-error").hidden = false;
  }
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
  for (const control of document.querySelectorAll("[data-live-control]"))
    control.hidden = !liveCallsEnabled;
  get("enable-live-calls").disabled = busy || policyBusy;
  get("analyze").disabled =
    !liveCallsEnabled || busy || policyBusy ||
    !sessionId || !catalog || !get("analyzer").value.trim();
  get("load-cache").disabled = busy || policyBusy || !savedExtractionRun;
  for (const button of get("packet-table").querySelectorAll(
    ".policy-matrix-button",
  ))
    button.disabled = busy || policyBusy;
  get("policy-run").disabled =
    !liveCallsEnabled ||
    policyMode !== "search" ||
    busy ||
    policyBusy ||
    policyStatus?.batchRunning ||
    !run ||
    !policyStatus?.configured;
  for (const button of get("policy-output").querySelectorAll(".policy-retry")) {
    button.disabled = get("policy-run").disabled;
    button.title = button.disabled
      ? "Wait for the current operation to finish before retrying."
      : "Retry this case only. Azure charges may apply.";
  }
  const saved = policyResults.get(policyMode);
  get("policy-chat-mode").disabled =
    !policyStatus?.configured ||
    !saved?.items.some((item) => item.id === selectedPacket && item.status === "completed");
  get("policy-chat-mode").title = !policyStatus?.configured
    ? "Follow-up chat needs the prepared policy-agent connection."
    : "";
  get("load-policy-cache").disabled = busy || policyBusy || policyCacheBusy ||
    (!savedPolicyEntries.some((entry) => entry.mode === policyMode) &&
      !(!run && policyMode === "search" && policyStatus?.bundledDemo && savedExtractionRun));
}
async function policyCaches() {
  const version = ++policyCacheVersion;
  const runId = run?.id;
  if (!runId) {
    get("policy-cache-status").textContent =
      "Load cached results to open the included CU run and saved policy checks. Loading makes no Azure calls.";
    controls();
    return;
  }
  policyCacheBusy = true;
  get("policy-cache-status").textContent = "Checking for compatible saved policy results…";
  controls();
  try {
    const saved = await api("policy/cache");
    if (version !== policyCacheVersion || run?.id !== runId || saved.runId !== runId) return;
    savedPolicyEntries = saved.entries;
    const entry = savedPolicyEntries.find((entry) => entry.mode === policyMode);
    get("policy-cache-status").textContent = saved.message ??
      (entry
        ? `${entry.count}/${entry.total} ${entry.source === "bundled" ? "bundled demo" : "saved"} cases available. Loading makes no Azure calls.`
        : "No saved policy checks are available for this retrieval option.");
    policyMessage();
  } catch (error) {
    if (version === policyCacheVersion && run?.id === runId) {
      savedPolicyEntries = [];
      get("policy-cache-status").textContent = `Could not list saved policy results: ${error.message}. Return to Check policies to retry.`;
    }
    throw error;
  } finally {
    if (version === policyCacheVersion) {
      policyCacheBusy = false;
      controls();
    }
  }
}
async function caches() {
  const savedRuns = await api("cache");
  savedExtractionRun = savedRuns.find((saved) => saved.id === savedExtractionRun?.id) ??
    savedRuns.find((saved) => saved.status === "completed" &&
      saved.datasetHash === catalog?.datasetHash) ??
    savedRuns.find((saved) => saved.status === "completed") ?? savedRuns[0];
  get("load-cache").title = savedExtractionRun
    ? `${savedExtractionRun.analyzer.id} · ${new Date(savedExtractionRun.startedAt).toLocaleString()}`
    : "No saved extraction results available.";
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
  const changedRun = run?.id !== nextRun.id;
  const changed = changedRun || Array.isArray(preloaded);
  run = nextRun;
  origin = nextOrigin;
  if (changed) {
    ++selectionVersion;
    selectedPacket = "";
    results.clear();
    if (changedRun) packetReview.reset();
    else packetReview.hide();
    resetPreview();
    expansion = undefined;
    parkDetails();
    policyResults.clear();
    savedPolicyEntries = [];
    policyPolls.clear();
    policyProgressErrors.clear();
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
    await policyCaches();
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
  if (!liveCallsEnabled) return;
  const status = await api("status");
  if (!liveCallsEnabled) return;
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
  const preferred = items.find((item) => item.id === (run ?? savedExtractionRun)?.analyzer.id) ??
    items.find((item) => item.compatible);
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
  renderWorkflowNavigation();
  for (const button of get("view-types").querySelectorAll("[data-view]")) {
    button.hidden = !types.includes(button.dataset.view);
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  }
  get("checks-description").hidden = view !== "policies";
  get("checks-description").textContent =
    view === "policy"
      ? "Agent review against rental SOPs. Satisfied does not authorize coverage or payment."
      : "Review extraction checks, improve the extractor in CU Studio, and rerun the affected source PDF.";
  get("show-confidence").closest("label").hidden = view === "policy";
  if (view === "policy") {
    get("packet-table").classList.add("policy-grid");
    get("field-setting").hidden = true;
    renderPolicyTable();
    return;
  }
  const classification = view === "classification";
  const policyView = view === "policies";
  const policyDefinitions = policyView ? policyColumns(values) : [];
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
  get("field-setting").hidden = classification || policyView || !columns.length;
  get("all-fields").checked = allFields;
  get("field-setting-label").textContent = "All fields";
  get("field-setting").title = "Show all returned fields.";
  get("confidence-setting").hidden = policyView;
  get("packet-table").classList.toggle("policy-grid", policyView);
  get("packet-table").setAttribute(
    "aria-label",
    policyView ? "Policy checks across packets" : "Customer results",
  );
  const head = element("tr");
  head.append(element("th", "Customer/Packet"));
  for (const column of columns) {
    const definition = policyView
      ? policyDefinitions.find((item) => item.id === column)
      : undefined;
    const th = element(
      "th",
      policyView
        ? undefined
        : classification
          ? className(column)
          : fieldLabel(column),
    );
    if (definition)
      th.append(
        element("span", definition.label, "policy-column-title"),
        element("span", definition.summary, "policy-column-description"),
      );
    th.title = definition?.description ?? column;
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
              const warnings = summary.counts.warn + summary.counts.not_checkable;
              const count =
                status === "Warn" ? warnings : summary.counts[summary.status];
              const button = element(
                "button",
                undefined,
                `cell-content policy-matrix-button policy-${summary.status}`,
              );
              button.append(
                element(
                  "span",
                  `${status}${count > 1 ? ` (${count})` : ""}`,
                  `policy-state ${
                    summary.status === "pass"
                      ? "policy-satisfied"
                      : summary.status === "fail"
                        ? "policy-error"
                        : summary.status === "not_checkable"
                          ? "policy-waiting"
                          : "policy-review"
                  }`,
                ),
              );
              button.dataset.policy = column;
              button.setAttribute("aria-expanded", "false");
              button.disabled = busy;
              button.title = `${definition.description}\nWorst of ${summary.total} document checks: ${summary.counts.fail} errors, ${warnings} warnings, ${summary.counts.pass} passed.\n${checks.map((check) => check.message).join("\n")}`;
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
  get("inline-panels").append(detailPanels.policy, detailPanels.items);
}
function collapseDetails() {
  packetReview.hide();
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
  if (!expansion || expansion.kind === "agent") return;
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
  const panel = detailPanels[expansion.kind];
  owner.classList.add("expanded-packet");
  if (expansion.kind !== "agent") {
    const row = element("tr", undefined, "inline-detail-row");
    row.id = "inline-details";
    row.dataset.detailFor = expansion.packetId;
    const cell = element("td");
    cell.colSpan = columnCount;
    cell.append(panel);
    row.append(cell);
    owner.cells[0].rowSpan = 2;
    owner.after(row);
    sizeDetails();
  }
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
    button.setAttribute("aria-controls", expansion.kind === "agent" ? panel.id : "inline-details");
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
function renderWorkflowNavigation() {
  const workflow = ["policies", "policy"].includes(view) ? view : "extract";
  for (const button of get("workflow-pivots").querySelectorAll("[data-workflow]"))
    button.setAttribute("aria-pressed", String(button.dataset.workflow === workflow));
  get("view-types").hidden = workflow !== "extract";
  get("extraction-toolbar").hidden = workflow !== "extract";
  get("policy-resources").hidden = workflow !== "policy";
  get("show-confidence").closest("label").hidden = workflow === "policy";
  get("results-heading").hidden = workflow === "policy";
  get("policy-table-intro").hidden = workflow !== "policy";
  get("results-heading").textContent = {
    extract: "Parse and extract", policies: "Business rules validation", policy: "Check Policies: Rental Car",
  }[workflow];
}
function activateView(next) {
  clearTimeout(clickTimer);
  ++selectionVersion;
  if (!["policies", "policy"].includes(view)) lastExtractionView = view;
  view = next;
  allFields = false;
  showPolicyPanel(view === "policy");
  renderWorkflowNavigation();
  if (!run) {
    get("batch").hidden = view !== "policy";
    if (view === "policy") void policyCaches().catch(fail);
    return;
  }
  renderTable();
  if (view === "policy") renderPolicyOutput();
  else if (selectedPacket) showCustomer(selectedPacket).catch(fail);
  if (view === "policy" && !busy && !policyBusy && !policyCacheBusy)
    void policyCaches().catch(fail);
}
for (const button of document.querySelectorAll("[data-view]"))
  button.onclick = () => activateView(button.dataset.view);
get("workflow-pivots").querySelector('[data-workflow="extract"]').onclick =
  () => {
    if (["policies", "policy"].includes(view)) activateView(lastExtractionView);
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
get("open-settings").onclick = async () => {
  try {
    const status = await api("status");
    get("cache-folder").value = status.cache.root;
    get("extraction-cache-folder").value = status.cache.extraction;
    get("policy-cache-folder").value =
      policyResults.get(policyMode)?.cacheFolder ?? status.cache.policy;
    get("enable-live-calls").checked = liveCallsEnabled;
    get("settings-error").hidden = true;
    controls();
    get("app-settings").showModal();
  } catch (error) {
    fail(error);
  }
};
get("close-settings").onclick = () => get("app-settings").close();
get("enable-live-calls").onchange = async () => {
  liveCallsEnabled = get("enable-live-calls").checked;
  get("settings-error").hidden = true;
  controls();
  if (liveCallsEnabled) {
    try {
      await analyzers();
    } catch (error) {
      fail(error);
    }
  }
};
get("analyzer").onchange = controls;
get("analyze").onclick = () => {
  if (get("analyze").disabled) return;
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
  if (get("analyze").disabled) return;
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
        savedExtractionRun = current.run;
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
async function loadExtractionCache() {
  if (!savedExtractionRun)
    throw new Error("No saved extraction results are available in the selected cache folder.");
  const current = ++watcherVersion;
  busy = true;
  get("error").hidden = true;
  get("settings-error").hidden = true;
  get("cache-loading").hidden = false;
  get("batch").setAttribute("aria-busy", "true");
  controls();
  try {
    const id = savedExtractionRun.id;
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
  } finally {
    busy = false;
    get("cache-loading").hidden = true;
    get("batch").removeAttribute("aria-busy");
    controls();
  }
}
async function loadSavedResults() {
  await loadExtractionCache();
  if (!policyBusy) await loadPolicyCache();
}
get("load-cache").onclick = () => loadSavedResults().catch(fail);
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
      view = "policy";
    }
    await Promise.all([
      api("packets").then((data) => (catalog = data)),
      updatePolicyAvailability(),
    ]);
    await caches();
    if (value.runId) {
      await renderRun(await api("cache/current"), "cached");
      if (!policyBusy) await loadPolicyCache();
    } else await loadSavedResults();
    if (view !== "policy" && !selectedPacket) {
      const first = run.items.find((item) => results.has(item.id));
      if (first) await showCustomer(first.id);
    }
    controls();
    if (globalThis.location?.hash === "#policy-documents") await openPolicyDocuments();
  })
  .catch(fail);

function showPolicyPanel(show) {
  policyDocument.close();
  policySource = undefined;
  get("policy-source-toolbar").hidden = true;
  get("download").hidden = false;
  get("policy-pane-modes").hidden = !show;
  get("policy-output").hidden = !show || policyPaneMode !== "result";
  get("policy-chat").hidden = !show || policyPaneMode !== "chat";
  get("policy-review-pane").hidden = !show;
  const selected = show && expansion?.kind === "agent" && expansion.view === view;
  get("agent-panel").hidden = !selected;
  get("policy-review-empty").hidden = selected;
  get("preview").setAttribute("aria-label", show ? "Policy check details" : "Document preview");
  get("pane-splitter").setAttribute("aria-label", show ? "Resize policy details" : "Resize document preview");
  get("pdf-scroll").hidden = show;
  get("pdf-controls").hidden = show || get("pdf-stage").dataset.ready !== "true";
  get("pdf-status").hidden = show;
}
function policyMessage() {
  const cached = policyResults.get(policyMode);
  const bundled = cached?.source === "bundled";
  const mode = bundled ? cached : policyStatus?.modes?.[policyMode];
  get("policy-status").title = policyStatus?.message ?? "";
  get("policy-status").textContent =
    bundled
      ? `Saved policy results · ${mode.indexName} · ${mode.extractionMode === "standard" ? "Search-managed CU extraction" : "CU Layout"}`
    : policyStatus?.batchRunning && !policyBusy
      ? "A policy batch is already running. Waiting for it to finish; no duplicate will be submitted. Reload this tab to reconnect to its progress."
      : mode
        ? `${mode.indexName ?? "No policy retrieval"} · ${mode.extractionMode === "standard" ? "Search-managed CU extraction" : "CU Layout"}`
        : policyStatus?.bundledDemo
          ? "Saved policy reviews are available. Loading makes no Azure calls."
          : (policyStatus?.message ?? "Policy configuration is loading.");
  renderPolicyResources();
}
function policyModeLabel(mode = policyMode) {
  return mode === "search" ? "FoundryIQ" : "No policy retrieval";
}
function renderPolicyResources() {
  const saved = policyResults.get(policyMode);
  const names = [...new Set((saved?.items ?? [])
    .filter((item) => item.status === "completed" && item.indexName)
    .map((item) => item.indexName))];
  const name = saved?.indexName ?? (names.length === 1 ? names[0] : undefined);
  const candidate = saved?.resources ?? (saved?.source === "bundled"
    ? policyStatus?.bundledDemo?.resources
    : name && name !== policyStatus?.resources?.index?.name
      ? undefined
      : policyStatus?.resources ?? (!saved ? policyStatus?.bundledDemo?.resources : undefined));
  const resources = names.length > 1 || (name && candidate?.index?.name !== name) ? undefined : candidate;
  const render = (id, label, href, message) => {
    const node = get(id);
    node.title = message ?? "";
    if (href && new URL(href).origin === "https://portal.azure.com") {
      node.replaceChildren();
      const link = element("a", label);
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      node.append(link);
    } else node.textContent = label;
  };
  const unavailable = "Verified resource metadata is unavailable for these policy results.";
  render("policy-index-resource", names.length > 1 ? "Multiple saved index generations" :
    name ?? resources?.index?.name ?? "Unavailable",
    resources?.index?.href, resources?.index?.message ?? (!resources ? unavailable : ""));
  const active = policyStatus?.resources?.index?.name;
  const context = get("policy-resource-context");
  context.hidden = !name || !active || name === active;
  context.textContent = context.hidden ? "" : `Showing saved result sources. Live checks use index ${active}.`;
}
async function openPolicyDocuments() {
  const dialog = get("policy-document-list");
  if (!dialog.open) dialog.showModal();
  const status = get("policy-document-list-status");
  status.textContent = "Resolving local dataset folders...";
  get("policy-document-list-files").replaceChildren();
  try {
    const { datasets } = await api("policy/datasets");
    const ids = ["original", "search", "digital"];
    if (!Array.isArray(datasets) || datasets.length !== 3 ||
        datasets.some((dataset, index) => dataset.id !== ids[index] ||
          typeof dataset.label !== "string" || typeof dataset.path !== "string" ||
          !/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(dataset.path) ||
          new URL(dataset.href).protocol !== "file:"))
      throw new Error("The local policy dataset folders are invalid.");
    for (const dataset of datasets) {
      const row = element("li");
      const link = element("a", dataset.path);
      link.href = dataset.href;
      link.dataset.datasetId = dataset.id;
      let opening = false;
      link.onclick = async (event) => {
        event.preventDefault();
        if (opening) return;
        opening = true;
        link.setAttribute("aria-disabled", "true");
        status.textContent = `Requesting Windows Explorer for ${dataset.label}...`;
        try {
          await api("policy/datasets/open", { id: dataset.id });
          status.textContent = `Folder requested in Windows Explorer: ${dataset.path}`;
        } catch (error) {
          status.textContent = `Could not open folder: ${error.message} Use Copy path instead.`;
        } finally {
          opening = false;
          link.removeAttribute("aria-disabled");
        }
      };
      const fallback = element("input");
      fallback.value = dataset.path;
      fallback.readOnly = true;
      fallback.hidden = true;
      fallback.setAttribute("aria-label", `${dataset.label} path to copy manually`);
      const copy = element("button", "Copy path");
      copy.className = "secondary";
      copy.onclick = async () => {
        try {
          if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
          await navigator.clipboard.writeText(dataset.path);
          status.textContent = `Copied path: ${dataset.path}`;
        } catch (error) {
          fallback.hidden = false;
          fallback.focus();
          fallback.select();
          status.textContent = `Could not copy automatically: ${error.message} Copy the selected path manually.`;
        }
      };
      row.append(element("strong", dataset.label), link, copy, fallback);
      get("policy-document-list-files").append(row);
    }
    status.textContent = "Three local datasets. The source folder may also contain supporting metadata.";
  } catch (error) {
    status.textContent = `Policy documents unavailable: ${error.message}`;
    throw error;
  }
}
get("policy-local-documents").onclick = (event) => {
  event.preventDefault();
  void openPolicyDocuments().catch(fail);
};
get("policy-document-list-close").onclick = () => get("policy-document-list").close();
globalThis.addEventListener?.("hashchange", () => {
  if (globalThis.location?.hash === "#policy-documents")
    void openPolicyDocuments().catch(fail);
});
async function updatePolicyAvailability() {
  clearTimeout(policyAvailabilityTimer);
  try {
    policyStatus = await api("policy/status");
  } catch (error) {
    policyStatus = {
      configured: false,
      message: `Could not load policy configuration: ${error.message}`,
    };
    policyMessage();
    controls();
    throw error;
  }
  controls();
  if (policyStatus.batchRunning && !policyBusy) {
    policyMessage();
    policyAvailabilityTimer = setTimeout(
      () => updatePolicyAvailability().catch(fail),
      2500,
    );
  } else if (!policyBusy) policyMessage();
}
function storePolicyResults(mode, value) {
  const previous = policyResults.get(mode);
  if (!value.configurationMessage && previous && previous.runId === value.runId) {
    const items = new Map(previous.items.map((item) => [item.id, item]));
    for (const item of value.items) {
      if (item.status === "not run" && items.get(item.id)?.status === "failed")
        continue;
      items.set(item.id, item);
    }
    value = { ...value, items: [...items.values()] };
  }
  policyResults.set(mode, value);
}
async function refreshPolicy(mode = policyMode) {
  if (!run) return;
  const id = run.id;
  const value = await api(`policy/results?mode=${mode}`);
  if (run?.id !== id || value.runId !== id) return;
  if (value.configurationMessage) {
    policyStatus = { ...policyStatus, configured: false, message: value.configurationMessage };
    policyMessage();
    controls();
  }
  storePolicyResults(mode, value);
  policyMessage();
  policyPolls.set(mode, Date.now());
  policyProgressErrors.delete(mode);
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
      renderPolicyRunStatus();
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
    policyProgressErrors.set(mode, error.message);
    renderPolicyOutput();
    throw new Error(
      `Policy progress could not be refreshed: ${error.message}. The server batch may still be running. Reload this tab to reconnect; do not submit another batch.`,
    );
  } finally {
    policyBusy = false;
    await updatePolicyAvailability();
    await policyCaches();
  }
}
function renderPolicyRunStatus() {
  const job = policyResults.get(policyMode);
  const running = job?.status === "running";
  get("policy-run-status").hidden = !running;
  get("policy-status").hidden = running;
  if (!running) return;
  const setText = (id, value) => {
    const node = get(id);
    if (node.textContent !== value) node.textContent = value;
  };
  const active = job.items.find((item) =>
    item.status === "reviewing",
  );
  const completed = job.items.filter((item) =>
    ["completed", "failed"].includes(item.status),
  ).length;
  const interrupted = policyProgressErrors.has(policyMode);
  setText("policy-run-label", interrupted
    ? "Progress connection interrupted"
    : "Agent checking three comparisons");
  get("policy-run-status").querySelector(".spinner").hidden = interrupted;
  const customer = active ? customerName(results.get(active.id)) : "";
  setText("policy-run-packet", active
    ? `${active.id}${customer ? ` · ${customer}` : ""}`
    : "Waiting for the next packet");
  setText("policy-run-detail", interrupted
    ? "The server may still be running. Reload to reconnect; do not start a duplicate review."
    : `${completed}/${job.items.length} packets finished · ${policyModeLabel()} · ${
      active ? "Checking three comparisons and citations" : "Preparing next case from saved Parse evidence"
    }`);
  const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(job.startedAt)) / 1000));
  get("policy-run-elapsed").textContent = Number.isFinite(elapsed)
    ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`
    : "—";
}
function updatePolicyActivity() {
  renderPolicyRunStatus();
  const activity = get("policy-output").querySelector(".policy-activity");
  if (!activity) return;
  const job = policyResults.get(policyMode);
  const item = job?.items.find((item) => item.id === selectedPacket);
  const started = Date.parse(item?.stageStartedAt ?? job?.startedAt);
  const elapsed = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const timer = activity.querySelector(".policy-activity-time");
  if (timer) timer.textContent = Number.isFinite(elapsed)
    ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s in this stage`
    : "Waiting for the next status update";
  const connection = activity.querySelector(".policy-activity-connection");
  const last = policyPolls.get(policyMode);
  if (connection) connection.textContent = policyProgressErrors.has(policyMode)
    ? `Progress updates stopped: ${policyProgressErrors.get(policyMode)}. Reload to reconnect; do not start a duplicate review.`
    : last
      ? `Workbench responded ${Math.max(0, Math.floor((Date.now() - last) / 1000))}s ago.`
      : "Connecting to workbench progress…";
}
function renderPolicyTable() {
  get("field-setting").hidden = true;
  const table = get("packet-table");
  const keys = [
    "customer",
    ...policyCheckNames.map((check) => `policy:${check}`),
  ];
  const availableWidth = Math.max(360, table.parentElement?.clientWidth || 640);
  const widths = keys.map(
    (key, index) => columnWidths.get(key) ??
      Math.floor(availableWidth * (index ? 0.76 / policyCheckNames.length : 0.24)),
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
    const cell = element("th");
    cell.append(
      element("span", policyShortNames[index], "policy-column-title"),
      element("span", policyCheckDescriptions[index], "policy-column-description"),
    );
    cell.title = policyCheckDescriptions[index];
    head.append(cell);
  }
  table.querySelector("thead").replaceChildren(head);
  resizeColumns(table, widths, (index, width) => {
    columnWidths.set(keys[index], width);
    sizeDetails();
  });
  const policyResult = policyResults.get(policyMode);
  const items = policyResult?.items ?? [];
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
      row.append(label);
      for (let column = 0; column < policyCheckNames.length; column++) {
        const cell = element("td");
        const check = item?.result?.Checks.find((check) => check.Check === policyCheckNames[column]);
        const text = check
          ? check.Outcome === "NotApplicable"
            ? "N/A"
            : check.Outcome === "InProgress"
              ? "Waiting for info"
            : check.ReviewRequired
              ? "Review required"
              : "Satisfied"
          : item?.status === "failed"
            ? "Run error"
            : ({
                pending: "Queued",
                reviewing: "Checking three comparisons",
              }[item?.status] ?? "Not run");
        const button = element("button", text, "cell-content");
        const state = element(
          "span",
          text,
          `policy-state ${check ? (check.Outcome === "NotApplicable" ? "policy-na" : check.Outcome === "InProgress" ? "policy-waiting" : check.ReviewRequired ? "policy-review" : "policy-satisfied") : item?.error ? "policy-error" : ""}`,
        );
        button.replaceChildren(state);
        if (check?.Outcome === "NotApplicable")
          button.setAttribute("aria-label", `${policyShortNames[column]}: Not applicable`);
        if (check?.Outcome === "InProgress")
          button.setAttribute("aria-label", `${policyShortNames[column]}: Waiting for info, missing claim information`);
        button.title =
          (check?.Outcome === "InProgress"
            ? `Waiting for claim data: ${check.Headline ?? check.Reason}`
            : check?.Headline ?? check?.Reason) ??
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
  if (!expandDetails(packetId, "agent", String(column))) {
    showPolicyPanel(true);
    return;
  }
  focusedPolicyCheck = column;
  renderPolicyOutput(column);
  get("policy-review-pane").scrollTop = 0;
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
        check: policyCheckNames[focusedPolicyCheck],
        resultId: `${item?.inputHash ?? ""}:${item?.completedAt ?? ""}:${item?.indexName ?? ""}`,
      })
      .catch(fail);
  }
  const panel = get("policy-output");
  get("agent-title").textContent = policyShortNames[focusedPolicyCheck];
  get("policy-check-context").textContent = selectedPacket
    ? `${customerName(results.get(selectedPacket)) || selectedPacket} · ${selectedPacket}`
    : "";
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
    if (item && ["pending", "reviewing"].includes(item.status)) {
      const activity = element("div", undefined, "policy-activity");
      const heading = element("p", undefined, "policy-activity-heading");
      const paused = policyProgressErrors.has(policyMode);
      if (!paused && item.status !== "pending")
        heading.append(element("span", undefined, "spinner"));
      heading.querySelector(".spinner")?.setAttribute("aria-hidden", "true");
      const title = element("span", paused ? "Progress connection interrupted" : ({
        pending: "Queued for policy review",
        reviewing: "Agent checking three comparisons",
      }[item.status]));
      title.setAttribute("role", "status");
      heading.append(title);
      activity.append(heading,
        element("p", item.status === "pending"
          ? "Cases run sequentially. This case will start after the cases ahead of it."
          : "The agent is evaluating three comparisons using saved Parse fields and selected first-pass page text. No claim CU reanalysis is run. Search and model calls can take several minutes; results appear after the response and source citations are verified."),
        element("p", "", "policy-activity-time"),
        element("p", "", "policy-activity-connection muted"));
      panel.append(activity);
      updatePolicyActivity();
      return;
    }
    panel.append(
      element(
        "p",
        item?.error ??
          (item && item.status !== "not run"
            ? `Status: ${item.status}`
            : "No saved policy checks are available for this case and retrieval option."),
        item?.error ? "error" : "muted",
      ),
    );
    if (item?.status === "failed" && policyMode === "search") {
      const packetId = selectedPacket;
      const retry = element("button", "Retry this case", "policy-retry secondary");
      retry.dataset.liveControl = "";
      retry.onclick = () => confirmPolicyRun([packetId]);
      const notice = element("p", "Retries the three checks for this case only, using saved Parse fields and selected first-pass page text. No claim CU reanalysis is run; Azure charges may apply.", "muted");
      notice.dataset.liveControl = "";
      panel.append(retry, notice);
      controls();
    }
    return;
  }
  for (const [index, check] of item.result.Checks.entries()) {
    if (check.Check !== policyCheckNames[focusedPolicyCheck]) continue;
    const section = element("section", undefined, "policy-check");
    section.id = `policy-check-${index}`;
    section.append(
      element(
        "span",
        check.Outcome === "NotApplicable"
          ? "N/A · Not applicable"
          : check.Outcome === "InProgress"
            ? "Waiting for info"
          : check.ReviewRequired
            ? "Review required"
            : "Satisfied",
        `policy-state ${check.Outcome === "NotApplicable" ? "policy-na" : check.Outcome === "InProgress" ? "policy-waiting" : check.ReviewRequired ? "policy-review" : "policy-satisfied"}`,
      ),
    );
    if (check.Outcome === "InProgress")
      section.append(element("p", "Review complete. Waiting for claim evidence needed by this comparison; add it, then rerun. Unrelated repair completion or payment approval isn't required.", "policy-waiting-note"));
    if (check.Headline) section.append(element("h4", check.Headline, "policy-finding"));
    else section.append(element("p",
      "Saved review uses the earlier format. Run again for a short headline and field comparison.",
      "muted"));
    if (check.Comparisons?.length) {
      const comparison = element("table", undefined, "policy-comparison");
      const caption = element("caption", "Claim facts compared with policy rules");
      const head = element("thead");
      const header = element("tr");
      for (const label of ["From", "Field or rule", "Value"]) {
        const cell = element("th", label);
        cell.scope = "col";
        header.append(cell);
      }
      head.append(header);
      const body = element("tbody");
      for (const pair of check.Comparisons) {
        for (const [source, field, label, value] of [
          ["Claim", pair.ClaimField, pair.ClaimLabel, pair.ClaimValue],
          ["Policy", pair.PolicyField, pair.PolicyLabel, pair.PolicyValue],
        ]) {
          const row = element("tr");
          const name = element("td");
          name.append(element("span", label, "policy-evidence-label"),
            element("span", field, "policy-evidence-field"));
          const amount = element("td");
          amount.append(element("strong", value));
          if (source === "Claim")
            addClaimComparisonSources(amount, field, value, selectedPacket,
              `${item.inputHash ?? ""}:${item.completedAt ?? ""}`);
          else
            addPolicyComparisonSources(amount, field, value, item.citations?.[index] ?? []);
          row.append(element("td", source), name, amount);
          body.append(row);
        }
      }
      comparison.append(caption, head, body);
      section.append(comparison, element("p", check.Reason, "policy-reasoning"));
    }
    const explanation = element("details", undefined, "policy-explanation");
    explanation.append(element("summary", "Review details"));
    const values = element("dl", undefined, "policy-values");
    for (const [label, value] of [
      ["Claim evidence", check.ActualValue],
      ["Policy requirement", check.ExpectedValue],
    ]) {
      const description = element("dd");
      description.append(element("strong", value));
      values.append(element("dt", label), description);
    }
    explanation.append(values, element("p", check.Reason));
    section.append(explanation, element("p", "Sources", "policy-source-label"));
    const citations = item.citations?.[index] ?? [];
    if (!citations.length)
      section.append(element("p", "No applicable rule source cited.", "muted"));
    for (const citation of citations) {
      const sourceName = citation.DocumentId.startsWith("DEC-") ? "Declarations"
        : citation.DocumentId.startsWith("RNT-") ? "Rental terms"
          : citation.DocumentId.startsWith("END-") ? "Endorsement"
            : citation.DocumentId.startsWith("SHARED-") ? "Shared processing rules"
              : /^[A-Z]{2}-RENTAL-/.test(citation.DocumentId) ? "State processing rules"
                : citation.DocumentId;
      const page = citation.href?.match(/#page=(\d+)$/)?.[1];
      const label = `${sourceName}${page ? ` · page ${page}` : ""} · ${citation.RuleId}`;
      if (citation.href?.startsWith("/data/policies/rental/")) {
        const link = element("a", label);
        link.href = citation.href;
        link.title = `${citation.DocumentId} v${citation.Version.replace(/^v(?=\d)/, "")} · ${citation.Section}`;
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
  if (item.historical)
    panel.append(element("p",
      "Saved review from an earlier prompt. Run policy checks to evaluate with the current instructions.",
      "muted"));
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
function comparisonLink(text, href, title, open) {
  const link = element("a", text, "policy-value-link");
  link.href = href;
  link.title = title;
  link.onclick = (event) => {
    event.preventDefault();
    open(link).catch(fail);
  };
  return link;
}
function addPolicyComparisonSources(cell, field, value, citations) {
  const sources = policyRuleSources(citations, field);
  if (sources.length === 1) {
    const citation = sources[0];
    cell.replaceChildren(element("strong"));
    cell.firstChild.append(comparisonLink(value, citation.href,
      `View ${citation.DocumentId} · ${citation.Section}`, (link) => openPolicySource(citation, link)));
  } else if (sources.length > 1) {
    for (const citation of sources) {
      const link = comparisonLink(`${citation.DocumentId} · ${citation.Section}`, citation.href,
        "View supporting policy page", (link) => openPolicySource(citation, link));
      link.classList.add("policy-value-source");
      cell.append(link);
    }
  } else cell.append(element("span", "No linked rule source", "policy-source-unavailable"));
}
function addClaimComparisonSources(cell, field, value, packetId, reviewVersion) {
  const key = `${run.id}:${policyMode}:${packetId}:${reviewVersion}`;
  if (!claimEvidenceRequests.has(key)) {
    const request = api(`policy/claim-evidence?runId=${encodeURIComponent(run.id)}&packetId=${encodeURIComponent(packetId)}&mode=${encodeURIComponent(policyMode)}`);
    claimEvidenceRequests.set(key, request);
    request.catch(() => claimEvidenceRequests.delete(key));
  }
  const notice = element("span", "Locating claim source…", "policy-source-unavailable");
  cell.append(notice);
  claimEvidenceRequests.get(key).then((evidence) => {
    if (!cell.isConnected) return;
    notice.remove();
    const matches = claimFieldSources(evidence.fields, field);
    const pages = new Map();
    for (const fact of matches) {
      if (!fact.regions.length && fact.pages) {
        const key = `${fact.href}:${fact.pages.start}-${fact.pages.end}`;
        if (!pages.has(key)) pages.set(key, { ...fact, page: fact.pages.start });
        continue;
      }
      for (const region of fact.regions) {
        const key = `${fact.href}:${region.page}`;
        if (!pages.has(key)) pages.set(key, { ...fact, page: region.page, regions: [] });
        pages.get(key).regions.push(region);
      }
    }
    const sources = [...pages.values()];
    const pageLabel = (source) => source.pages && !source.regions.length
      ? source.pages.start === source.pages.end
        ? `page ${source.pages.start}` : `pages ${source.pages.start}–${source.pages.end}`
      : `page ${source.page}`;
    const sourceTitle = (source) => source.pages && !source.regions.length
      ? `First-pass parsed page text · ${pageLabel(source)} · derived interpretation, not a typed CU fact`
      : `View extracted ${field} · claim ${pageLabel(source)}`;
    if (sources.length === 1) {
      const source = sources[0];
      cell.replaceChildren(element("strong"));
      cell.firstChild.append(comparisonLink(value, `${source.href}#page=${source.page}`,
        sourceTitle(source), (link) => openClaimSource(source, field, link)));
    } else if (sources.length > 1) {
      for (const source of sources) {
        const link = comparisonLink(`Claim · ${pageLabel(source)}`, `${source.href}#page=${source.page}`,
          sourceTitle(source), (link) => openClaimSource(source, field, link));
        link.classList.add("policy-value-source");
        cell.append(link);
      }
    } else cell.append(element("span", "No supplied source location", "policy-source-unavailable"));
    if (sources.some((source) => source.pages && !source.regions.length))
      cell.append(element("span", "First-pass parsed page text · derived interpretation, not a typed CU fact", "policy-source-unavailable"));
  }).catch((error) => {
    if (!cell.isConnected) return;
    notice.textContent = `Claim source unavailable: ${error.message}`;
    notice.classList.add("error");
    if (!notice.isConnected) cell.append(notice);
  });
}
function beginPolicySource(link, title) {
  policyDocument.close();
  policySource = {
    link,
    scrollTop: get("policy-review-pane").scrollTop,
  };
  get("policy-review-pane").hidden = true;
  get("pdf-scroll").hidden = false;
  get("policy-source-toolbar").hidden = false;
  get("policy-source-title").textContent = title;
  get("download").hidden = true;
  get("policy-source-back").textContent = "Back to policy check";
  get("policy-source-back").focus();
  return policySource;
}
async function openClaimSource(source, field, link) {
  if (source.href !== `/data/packets/${selectedPacket}.pdf` ||
      !Number.isInteger(source.page) || source.page < 1)
    throw new Error("The claim source is not from the selected packet.");
  const textSource = source.pages && !source.regions.length;
  const pageRange = textSource && source.pages.end !== source.pages.start
    ? `pages ${source.pages.start}–${source.pages.end}` : `page ${source.page}`;
  const selected = beginPolicySource(link, textSource
    ? `First-pass parsed page text · Claim ${selectedPacket} · ${pageRange} · derived interpretation, not a typed CU fact`
    : `${field} · Claim ${selectedPacket} · ${pageRange}`);
  get("pdf-status").hidden = false;
  try {
    await previewPdf(source.href, source.page, source.regions);
  } finally {
    if (policySource !== selected && view === "policy") {
      get("pdf-scroll").hidden = !policySource;
      get("pdf-controls").hidden = !policySource;
      get("pdf-status").hidden = !policySource;
    }
  }
}
async function openPolicySource(citation, link) {
  const match =
    /^\/data\/policies\/rental\/((?:ocr-comparison-v2\/)?[a-z0-9-]+\.pdf)#page=([1-9]\d*)$/.exec(
      citation.href,
    );
  if (!match)
    throw new Error("The policy source link is not a verified local PDF.");
  beginPolicySource(link, `${citation.DocumentId} · ${citation.RuleId} · ${citation.Section}`);
  await policyDocument.open(
    `/data/policies/rental/${match[1]}`,
    Number(match[2]),
  );
}
get("policy-source-back").onclick = () => {
  const previous = policySource;
  showPolicyPanel(true);
  if (previous?.listing) {
    void openPolicyDocuments().catch(fail);
    return;
  }
  get("policy-review-pane").scrollTop = previous?.scrollTop ?? 0;
  previous?.link.focus({ preventScroll: true });
};
get("close-agent").onclick = () => {
  collapseDetails();
  showPolicyPanel(true);
  get("packet-table").querySelector(`tr.selected [data-agent-check="${focusedPolicyCheck}"]`)?.focus();
};
function selectPolicyPane(mode) {
  const key = `${run?.id}:${policyMode}:${selectedPacket}`;
  if (policyPaneMode === "result")
    policyResultScroll.set(key, get("policy-review-pane").scrollTop);
  policyPaneMode = mode;
  for (const value of ["result", "chat"]) {
    const button = get(`policy-${value}-mode`);
    button.setAttribute("aria-pressed", String(value === mode));
    button.classList.toggle("secondary", value !== mode);
  }
  showPolicyPanel(view === "policy");
  renderPolicyOutput();
  if (mode === "result")
    get("policy-review-pane").scrollTop = policyResultScroll.get(key) ?? 0;
}
for (const mode of ["result", "chat"])
  get(`policy-${mode}-mode`).onclick = () => selectPolicyPane(mode);
async function loadPolicyCache() {
  if (get("load-policy-cache").disabled) return;
  const mode = policyMode;
  busy = true;
  get("error").hidden = true;
  get("settings-error").hidden = true;
  get("cache-loading").hidden = false;
  get("policy-cache-status").textContent = "Loading saved policy checks and verifying their sources…";
  controls();
  try {
    if (!run) {
      if (!savedExtractionRun)
        throw new Error("No saved CU run is available for the included policy demo.");
      await renderRun(await api("cache/load", { runId: savedExtractionRun.id }), "cached");
    }
    const runId = run.id;
    const entry = savedPolicyEntries.find((entry) => entry.mode === mode);
    const value = await api("policy/cache/load", { runId, mode,
      ...(entry?.source ? { source: entry.source } : {}) });
    if (run?.id !== runId || value.runId !== runId) return;
    policyResults.set(mode, value);
    policyChat.reset();
    if (value.source === "bundled") {
      const current = await api("cache/current");
      const packetId = selectedPacket;
      await renderRun(current, "cached");
      if (packetId && !selectedPacket && view !== "policy" && results.has(packetId))
        await showCustomer(packetId);
      selectPolicyPane("result");
    }
    renderTable();
    renderPolicyOutput();
    const count = value.items.filter((item) => item.status === "completed").length;
    get("policy-cache-status").textContent = `Loaded saved policy checks for ${count}/${value.items.length} cases. No Azure calls were made.`;
    policyMessage();
  } catch (error) {
    get("policy-cache-status").textContent = `Could not load saved policy results: ${error.message}. Return to Check policies to reload the list.`;
    throw error;
  } finally {
    busy = false;
    get("cache-loading").hidden = true;
    controls();
  }
}
get("load-policy-cache").onclick = () => loadPolicyCache().catch(fail);
function confirmPolicyRun(packetIds) {
  if (get("policy-run").disabled) return;
  get("app-settings").close();
  pendingPolicyRun = { runId: run.id, mode: policyMode, packetIds };
  const packetId = packetIds?.[0];
  get("policy-confirm-summary").textContent =
    (packetId
      ? `1 case: ${customerName(results.get(packetId)) || packetId} · ${policyModeLabel()}. Only this case's three checks will be retried. `
      : `${run.items.filter((item) => item.rawSaved).length} cases · three checks per case · ${policyModeLabel()}.`);
  get("policy-confirmation").showModal();
}
get("policy-run").onclick = () => confirmPolicyRun();
get("policy-confirmation").onclose = () => { pendingPolicyRun = undefined; };
get("cancel-policy").onclick = () => get("policy-confirmation").close();
get("confirm-policy").onclick = async () => {
  if (get("policy-run").disabled || !pendingPolicyRun) return;
  const selection = pendingPolicyRun;
  if (run?.id !== selection.runId || policyMode !== selection.mode) {
    get("policy-confirmation").close();
    fail(new Error("The selected run or retrieval mode changed. Open the confirmation again."));
    return;
  }
  get("policy-confirmation").close();
  pendingPolicyRun = undefined;
  busy = true;
  get("error").hidden = true;
  controls();
  const mode = policyMode;
  try {
    const job = await api("policy/batch", { mode, live: true,
      ...(selection.packetIds ? { packetIds: selection.packetIds } : {}) });
    policyProgressErrors.delete(mode);
    policyPolls.set(mode, Date.now());
    storePolicyResults(mode, job);
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
