import { createHash } from "node:crypto";
import { categories, LabError, record } from "./config.ts";
import type { CuClient } from "./cu.ts";

async function verifyRouter(client: Pick<CuClient, "detail">, id: string) {
  const detail = record(await client.detail(id));
  const config = record(detail?.config);
  const rules = record(config?.contentCategories);
  if (
    !detail ||
    detail.status !== "ready" ||
    config?.enableSegment !== true ||
    config.allowInPageSegments === true ||
    config.segmentPerPage === true ||
    config.omitContent === true ||
    !rules
  )
    throw new LabError(
      422,
      "Use a ready auto-segmenting page-boundary router that keeps parent content.",
    );
  const selected = categoryProfile(rules);
  if (record(rules.other)?.analyzerId !== undefined)
    throw new LabError(422, "Leave other without an extraction route.");
  for (const key of selected.filter((category) => category !== "other")) {
    const childId = record(rules[key])?.analyzerId;
    if (typeof childId !== "string")
      throw new LabError(422, `${key} needs a linked analyzer.`);
    const child = record(await client.detail(childId));
    if (!child || child.status !== "ready")
      throw new LabError(422, `${key} child is not ready.`);
    if (key === "repair_estimate") {
      const fields = record(record(child.fieldSchema)?.fields);
      for (const [field, type] of [
        ["vehicle", "string"],
        ["vin", "string"],
        ["odometer", "number"],
      ])
        if (
          record(fields?.[field])?.type !== type ||
          record(fields?.[field])?.method !== "extract"
        )
          throw new LabError(
            422,
            `Repair child needs ${field}: ${type}, Extract.`,
          );
    }
  }
  return { id, categories: rules, verifiedReadOnly: true };
}

function categoryProfile(rules: Record<string, unknown>) {
  const core = ["id_document", "tax_1099a", "repair_estimate", "other"];
  const hasInvoices =
    Object.hasOwn(rules, "towing_invoice") ||
    Object.hasOwn(rules, "rental_invoice");
  const selected = hasInvoices
    ? [...categories]
    : categories.filter((category) => core.includes(category));
  if (
    Object.keys(rules).length !== selected.length ||
    selected.some((category) => !Object.hasOwn(rules, category))
  )
    throw new LabError(
      422,
      "Use the four core categories, optionally adding both towing_invoice and rental_invoice.",
    );
  return selected;
}

export async function verifyAnalyzer(
  client: Pick<CuClient, "detail">,
  id: string,
) {
  const detail = record(await client.detail(id));
  const config = record(detail?.config);
  const rules = record(config?.contentCategories);
  if (
    !detail ||
    detail.status !== "ready" ||
    config?.enableSegment !== true ||
    config.allowInPageSegments === true ||
    config.segmentPerPage === true ||
    config.omitContent === true ||
    !rules
  )
    throw new LabError(
      422,
      "Connect a ready logical page-boundary classifier or routed analyzer.",
    );
  const selected = categoryProfile(rules);
  if (record(rules.other)?.analyzerId !== undefined)
    throw new LabError(422, "Leave other without an extraction route.");
  const routeCategories = selected.filter((category) => category !== "other");
  const linked = routeCategories.filter(
    (category) => typeof record(rules[category])?.analyzerId === "string",
  );
  if (linked.length !== 0 && linked.length !== routeCategories.length)
    throw new LabError(
      422,
      "Use classification-only or connect every non-Other category, not a partially linked router.",
    );
  if (linked.length) await verifyRouter(client, id);
  const children = await Promise.all(
    linked.map(async (category) => {
      const childId = String(record(rules[category])?.analyzerId);
      const child = record(await client.detail(childId));
      return {
        id: childId,
        definition: {
          config: child?.config,
          models: child?.models,
          fieldSchema: child?.fieldSchema,
        },
      };
    }),
  );
  const definition = {
    config,
    models: detail.models,
    fieldSchema: detail.fieldSchema,
    children,
  };
  return {
    id,
    mode: linked.length
      ? ("routed" as const)
      : ("classification-only" as const),
    categories: rules,
    models: detail.models ?? {},
    definition,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(definition))
      .digest("hex"),
    verifiedReadOnly: true,
  };
}
