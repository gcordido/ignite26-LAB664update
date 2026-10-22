import { previewPdf, resetPreview } from "./pdf-preview.js";
import { resizeColumns, splitPreview } from "./column-resize.js";
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
let policyStatus;
let policyBusy = false;
let policyMode = "ungrounded";
let policySource;
let policyPaneMode = "result";
const policyResults = new Map();
const policyResultScroll = new Map();
const policyChecks = [
  "Rental eligibility and need", "Daily rate", "Duration and repair alignment",
  "Charges and reimbursement calculation", "Authorization and payment readiness",
];
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
  selectedRun: () => run?.id,
  onSession: (id) => { sessionId = id; },
  onRestored: () => {
    policyChat.reset();
    queueMicrotask(() => {
      if (view === "policy" && policyPaneMode === "chat") renderPolicyOutput();
    });
    get("error").hidden = true;
    get("session-status").textContent = "Private session restored; saved results reloaded. Chat history was reset. No live operation was retried.";
  },
});
const policyChat = createPolicyChat({
  container: get("policy-chat"), api, onSource: openPolicySource, onError: fail,
});
const policyDocument = createPolicyDocument({ api, previewPdf, get });
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
  get("load-cache").disabled = busy || !get("cache").value;
  get("refresh-cache").disabled = busy || !sessionId;
  get("policy-run").disabled = busy || policyBusy || !run || !policyStatus?.configured;
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
  const changed = run?.id !== nextRun.id;
  run = nextRun;
  origin = nextOrigin;
  if (changed) {
    ++selectionVersion;
    selectedPacket = "";
    results.clear();
    policyResults.clear();
    policyResultScroll.clear();
    policyChat.reset();
    resetPreview();
    showPolicyPanel(view === "policy");
    get("array-dialog").close();
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
      .filter((item) => item.rawSaved && !results.has(item.id))
      .map(async (item) => {
        const result = await api(`packet/${item.id}`);
        if (run?.id === runId) results.set(item.id, result);
      }),
  );
  if (run?.id !== runId) return;
  if (changed) await refreshPolicy();
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
  for (const row of get("packet-table").querySelectorAll("tbody tr"))
    row.classList.toggle("selected", row.dataset.packet === id);
  get("download").disabled = !results.has(id);
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
  const values = run.items.map((item) => results.get(item.id)).filter(Boolean);
  const types = [...availableTypes(values), "policy"];
  if (!types.includes(view)) {
    view = "classification";
    allFields = false;
  }
  for (const button of get("view-types").querySelectorAll("[data-view]")) {
    button.hidden = !types.includes(button.dataset.view);
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  }
  get("policy-toolbar").hidden = view !== "policy";
  get("show-confidence").closest("label").hidden = view === "policy";
  if (view === "policy") {
    renderPolicyTable();
    return;
  }
  const classification = view === "classification";
  const columns = classification
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
    "towing_invoice",
    "rental_invoice",
  ];
  if (classification)
    columns.sort((a, b) => classOrder.indexOf(a) - classOrder.indexOf(b));
  get("field-setting").hidden = classification || !columns.length;
  get("all-fields").checked = allFields;
  const head = element("tr");
  head.append(element("th", "Customer/Packet"));
  for (const column of columns) {
    const th = element(
      "th",
      classification ? className(column) : fieldLabel(column),
    );
    th.title = column;
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
          ) + 28,
      ),
    );
  const natural = columns.map((column) => {
    const heading =
      textWidth(classification ? className(column) : fieldLabel(column), true) +
      28;
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
    (index, width) => columnWidths.set(widthKeys[index], width),
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
        if (!classification && selected.count > 1)
          customer.append(
            warning(
              `${selected.count} ${typeNames[view]} documents. Showing the first.`,
            ),
          );
        label.append(customer);
        row.append(label);
        for (const column of columns) {
          const cell = element("td");
          if (classification) {
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
                open.title = "Open item table";
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
  showPolicyPanel(false);
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
  get("array-dialog").style.width =
    `min(${Math.min(1400, totalWidth + extra + 30)}px, 94vw)`;
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
          get("array-dialog").close();
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
  get("array-dialog").showModal();
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
get("close-array").onclick = () => get("array-dialog").close();
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
    await renderRun(await api("batch", { live: true }), "live");
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
    controls();
  }
};
get("refresh-cache").onclick = () => caches().catch(fail);
get("download").onclick = async () => {
  const id = selectedPacket;
  try {
    const response = await api(`raw/${id}`);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(response, null, 2)], {
        type: "application/json",
      }),
    );
    const link = element("a");
    link.href = url;
    link.download = `${id}.cu.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    fail(error);
  }
};
api("session", {})
  .then(async (value) => {
    sessionId = value.sessionId;
    await Promise.all([
      caches(),
      analyzers(),
      api("packets").then((data) => (catalog = data)),
      api("policy/status").then((value) => {
        policyStatus = value;
        get("policy-mode").replaceChildren();
        if (value.configured) {
          const modes = Object.keys(value.modes);
          get("policy-mode").replaceChildren(...modes.map((mode) => {
            const option = element("option", policyModeLabel(mode));
            option.value = mode;
            return option;
          }));
          if (!modes.includes(policyMode)) policyMode = modes[0];
          get("policy-mode").value = policyMode;
        }
        get("policy-mode").disabled = !value.configured;
        policyMessage();
      }),
    ]);
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
  get("pdf-scroll").hidden = show;
  if (show) {
    resetPreview();
    get("pdf-controls").hidden = true;
    get("pdf-status").hidden = true;
  }
}
function policyMessage() {
  const mode = policyStatus?.modes?.[policyMode];
  get("policy-status").textContent = mode
    ? `${mode.indexName ?? "No policy retrieval"} · ${policyStatus.message}`
    : (policyStatus?.message ?? "Policy configuration is loading.");
}
function policyModeLabel(mode = policyMode) {
  return mode === "search" ? "Azure Search retrieval" : "No policy retrieval";
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
function renderPolicyTable() {
  get("field-setting").hidden = true;
  const table = get("packet-table");
  const keys = ["customer", ...policyChecks.map((check) => `policy:${check}`)];
  const widths = keys.map((key, index) => columnWidths.get(key) ?? (index ? 185 : 190));
  table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
  table.querySelector("colgroup").replaceChildren(...widths.map((width) => {
    const col = element("col"); col.style.width = `${width}px`; return col;
  }));
  const head = element("tr");
  head.append(element("th", "Customer/Packet"));
  for (const label of policyChecks) {
    const cell = element("th", label); cell.title = label; head.append(cell);
  }
  table.querySelector("thead").replaceChildren(head);
  resizeColumns(table, widths, (index, width) => columnWidths.set(keys[index], width));
  const items = policyResults.get(policyMode)?.items ?? [];
  table.querySelector("tbody").replaceChildren(...run.items.map((packet, index) => {
    const row = element("tr");
    row.dataset.packet = packet.id;
    row.classList.toggle("selected", selectedPacket === packet.id);
    const item = items.find((item) => item.id === packet.id);
    const customer = customerName(results.get(packet.id));
    const label = element("td");
    const name = element("button", `#${index + 1} ${customer || packet.id}`, "cell-content");
    name.onclick = () => { selectRow(packet.id); renderPolicyOutput(); };
    label.append(name);
    label.append(element("span", results.get(packet.id)?.claimSummaryPrepared
      ? "Claim fields prepared" : "Claim fields not prepared", "policy-preparation"));
    row.append(label);
    for (let column = 0; column < policyChecks.length; column++) {
      const cell = element("td");
      const check = item?.result?.Checks[column];
      const text = check ? check.Outcome === "NotApplicable" ? "Not applicable" : check.ReviewRequired ? "Review required" : "Satisfied"
        : item?.status === "failed" ? "Run error"
          : ({ pending: "Queued", extracting: "Extracting claim", reviewing: "Checking rules" }[item?.status] ?? "Not run");
      const button = element("button", text, "cell-content");
      const state = element("span", text, `policy-state ${check ? check.Outcome === "NotApplicable" ? "policy-na" : check.ReviewRequired ? "policy-review" : "policy-satisfied" : item?.error ? "policy-error" : ""}`);
      button.replaceChildren(state);
      button.title = check?.Reason ?? item?.error ?? "Run policy checks explicitly for this extraction mode.";
      button.onclick = () => { selectRow(packet.id); renderPolicyOutput(column); };
      cell.append(button);
      row.append(cell);
    }
    return row;
  }));
}
function renderPolicyOutput(focused) {
  if (view !== "policy" || policySource) return;
  showPolicyPanel(true);
  if (policyPaneMode === "chat" && selectedPacket) {
    const item = policyResults.get(policyMode)?.items.find((item) => item.id === selectedPacket);
    policyChat.show({ runId: run.id, mode: policyMode, packetId: selectedPacket,
      resultId: `${item?.inputHash ?? ""}:${item?.completedAt ?? ""}:${item?.indexName ?? ""}` }).catch(fail);
  }
  const panel = get("policy-output");
  panel.replaceChildren(element("h2", "Policy checks"));
  if (!selectedPacket) {
    panel.append(element("p", "Select a case to see the agent's checks, reasons and rule sources."));
    return;
  }
  const item = policyResults.get(policyMode)?.items.find((item) => item.id === selectedPacket);
  panel.append(element("p", `${customerName(results.get(selectedPacket)) || selectedPacket} · ${policyModeLabel()}`));
  if (!item?.result) {
    panel.append(element("p", item?.error ?? (item && item.status !== "not run"
      ? `Status: ${item.status}` : "Not run for this mode and packet. Select Run policy checks to evaluate."), item?.error ? "error" : "muted"));
    return;
  }
  panel.append(element("p", `${item.cached ? "Cached" : "Live"} · ${item.indexName ?? "No policy retrieval"}`, "muted"));
  panel.append(element("p", `Evaluated ${new Date(item.completedAt).toLocaleString()}. Satisfied does not mean coverage or payment approval.`, "muted"));
  for (const [index, check] of item.result.Checks.entries()) {
    const section = element("section", undefined, "policy-check");
    section.id = `policy-check-${index}`;
    section.append(element("h3", `${index + 1}. ${check.Check}`));
    section.append(element("span", check.Outcome === "NotApplicable" ? "Not applicable" : check.ReviewRequired ? "Review required" : "Satisfied",
      `policy-state ${check.Outcome === "NotApplicable" ? "policy-na" : check.ReviewRequired ? "policy-review" : "policy-satisfied"}`));
    const values = element("dl", undefined, "policy-values");
    for (const [label, value] of [["Expected", check.ExpectedValue], ["Actual", check.ActualValue]]) {
      const description = element("dd");
      description.append(element("strong", value));
      values.append(element("dt", `${label}:`), description);
    }
    section.append(values);
    const reasoning = element("p", undefined, "policy-reasoning");
    reasoning.append(element("em", `Reasoning: ${check.Reason}`));
    section.append(reasoning, element("p", "Source:", "policy-source-label"));
    const citations = item.citations?.[index] ?? [];
    if (!citations.length) section.append(element("p", "No applicable rule source cited.", "muted"));
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
      } else section.append(element("p", `${label} — source not verified; no link generated.`, "muted"));
    }
    panel.append(section);
  }
  const details = element("details");
  details.append(element("summary", "Full structured agent output"), element("pre", JSON.stringify(item.result, null, 2)));
  panel.append(details);
  if (focused !== undefined && policyPaneMode === "result") get(`policy-check-${focused}`)?.scrollIntoView({ block: "nearest" });
}
async function openPolicySource(citation, link) {
  const match = /^\/data\/policies\/rental\/((?:ocr-comparison-v2\/)?[a-z0-9-]+\.pdf)#page=([1-9]\d*)$/.exec(citation.href);
  if (!match) throw new Error("The policy source link is not a verified local PDF.");
  policySource = { link, scrollTop: get(policyPaneMode === "chat" ? "policy-chat" : "policy-output").scrollTop };
  get("policy-output").hidden = true;
  get("policy-chat").hidden = true;
  get("policy-pane-modes").hidden = true;
  get("pdf-scroll").hidden = false;
  get("policy-source-toolbar").hidden = false;
  get("policy-source-title").textContent = `${citation.DocumentId} · ${citation.RuleId} · ${citation.Section}`;
  get("download").hidden = true;
  get("policy-source-back").textContent = policyPaneMode === "chat" ? "Back to chat" : "Back to policy checks";
  get("policy-source-back").focus();
  await policyDocument.open(`/data/policies/rental/${match[1]}`, Number(match[2]));
}
get("policy-source-back").onclick = () => {
  const previous = policySource;
  showPolicyPanel(true);
  get(policyPaneMode === "chat" ? "policy-chat" : "policy-output").scrollTop = previous?.scrollTop ?? 0;
  previous?.link.focus({ preventScroll: true });
};
for (const mode of ["result", "chat"]) get(`policy-${mode}-mode`).onclick = () => {
  const key = `${run?.id}:${policyMode}:${selectedPacket}`;
  if (policyPaneMode === "result") policyResultScroll.set(key, get("policy-output").scrollTop);
  policyPaneMode = mode;
  for (const value of ["result", "chat"]) {
    const button = get(`policy-${value}-mode`);
    button.setAttribute("aria-pressed", String(value === mode));
    button.classList.toggle("secondary", value !== mode);
  }
  showPolicyPanel(true);
  renderPolicyOutput();
  if (mode === "result") get("policy-output").scrollTop = policyResultScroll.get(key) ?? 0;
};
get("policy-mode").onchange = async () => {
  policyMode = get("policy-mode").value;
  showPolicyPanel(true);
  policyMessage();
  renderTable();
  renderPolicyOutput();
  try { await refreshPolicy(); } catch (error) { fail(error); }
};
get("policy-run").onclick = () => {
  get("policy-confirm-summary").textContent =
    `${run.items.filter((item) => item.rawSaved).length} cases · ${policyModeLabel()}.`;
  get("policy-confirmation").showModal();
};
get("cancel-policy").onclick = () => get("policy-confirmation").close();
get("confirm-policy").onclick = async () => {
  if (busy || policyBusy) return;
  get("policy-confirmation").close();
  policyBusy = true; busy = true;
  controls();
  const mode = policyMode;
  const id = run.id;
  try {
    const job = await api("policy/batch", { mode, live: true });
    policyResults.set(mode, job);
    while (run?.id === id) {
      if (view === "policy" && mode === policyMode) { renderTable(); renderPolicyOutput(); }
      await new Promise((resolve) => setTimeout(resolve, 1400));
      await refreshPolicy(mode);
      const status = policyResults.get(mode);
      const completed = status.items.filter((item) => ["completed", "failed"].includes(item.status)).length;
      get("policy-status").textContent = `${completed}/${status.items.length} cases · ${mode} · ${status.status}`;
      if (status.status !== "running") break;
    }
    if (run?.id === id) {
      await Promise.all(run.items.filter((item) => item.rawSaved).map(async ({ id }) => {
        const value = await api(`packet/${id}`);
        if (run?.id === value.packetJson?.analysis.run_id) results.set(id, value);
      }));
    }
  } catch (error) { fail(error); }
  finally { policyBusy = false; busy = false; controls(); }
};
