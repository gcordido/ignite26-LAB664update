import { previewPdf, resetPreview } from "./pdf-preview.js";
import { resizeColumns, splitPreview } from "./column-resize.js";
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

async function api(route, body) {
  const response = await fetch(`/api/${route}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId ? { "x-labmachine-session": sessionId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}
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
    resetPreview();
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
  const level = percent >= 90 ? "high" : percent >= 70 ? "medium" : "low";
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
  const types = availableTypes(values);
  if (!types.includes(view)) {
    view = "classification";
    allFields = false;
  }
  for (const button of get("view-types").querySelectorAll("[data-view]")) {
    button.hidden = !types.includes(button.dataset.view);
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
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
        if (item.error || result?.reviewError)
          customer.append(warning(item.error ?? result.reviewError));
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
    view = button.dataset.view;
    allFields = false;
    renderTable();
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
    ]);
    controls();
  })
  .catch(fail);
