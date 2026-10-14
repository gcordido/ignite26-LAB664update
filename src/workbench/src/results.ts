import { categories, LabError, record } from "./config.ts";

export type Fact = {
  field: string;
  value: string | number | boolean | null;
  status: "present" | "missing";
  confidence?: number;
  source?: string;
  regions: { page: number; polygon: number[] }[];
};
export type ResultField =
  | (Fact & { kind: "scalar" })
  | { kind: "array"; field: string; count: number; items: Fact[][] };
export type Document = {
  path?: string;
  analyzerId: string;
  category?: string;
  facts: Fact[];
  fields: ResultField[];
};
export function contents(value: unknown): Record<string, unknown>[] {
  const wrapper = record(value);
  const raw =
    wrapper && Object.hasOwn(wrapper, "response") ? wrapper.response : value;
  const result = record(record(raw)?.result);
  if (!result || !Array.isArray(result.contents))
    throw new LabError(422, "CU result.contents is missing.");
  return result.contents.map((content) => {
    const item = record(content);
    if (!item) throw new LabError(422, "CU content must be an object.");
    return item;
  });
}
export function normalize(value: unknown): Document[] {
  const documents: Document[] = [];
  const allContents = contents(value);
  const parent = allContents.find((item) => item.path === "input1");
  for (const content of allContents) {
    const fields = record(content.fields);
    if (!fields || Object.keys(fields).length === 0) continue;
    const facts: Fact[] = [];
    const displayFields: ResultField[] = [];
    function visit(
      value: unknown,
      fieldPath: string,
      target = facts,
      display = true,
    ) {
      const field = record(value);
      if (!field) throw new LabError(422, `Invalid field object: ${fieldPath}`);
      if (Array.isArray(field.valueArray)) {
        const items = field.valueArray.map((item, index) => {
          const itemFacts: Fact[] = [];
          visit(item, `${fieldPath}[${index}]`, itemFacts, false);
          target.push(...itemFacts);
          return itemFacts;
        });
        if (display)
          displayFields.push({
            kind: "array",
            field: fieldPath,
            count: items.length,
            items,
          });
        return;
      }
      if (field.type === "array") {
        if (display)
          displayFields.push({ kind: "scalar", ...fact(field, fieldPath) });
        target.push(fact(field, fieldPath));
        return;
      }
      const object = record(field.valueObject);
      if (object) {
        for (const [name, child] of Object.entries(object))
          visit(child, `${fieldPath}.${name}`, target, display);
        return;
      }
      const result = fact(field, fieldPath);
      target.push(result);
      if (display) displayFields.push({ ...result, kind: "scalar" });
    }
    function fact(field: Record<string, unknown>, fieldPath: string): Fact {
      const scalar = [
        "valueString",
        "valueDate",
        "valueTime",
        "valueNumber",
        "valueInteger",
        "valueBoolean",
      ]
        .map((key) => field[key])
        .find(
          (value) =>
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean",
        );
      return {
        field: fieldPath,
        value:
          scalar === undefined ? null : (scalar as string | number | boolean),
        status: scalar === undefined ? "missing" : "present",
        ...(typeof field.confidence === "number"
          ? { confidence: field.confidence }
          : {}),
        ...(typeof field.source === "string" ? { source: field.source } : {}),
        regions: sourceRegions(field.source, content, parent),
      };
    }
    for (const [name, field] of Object.entries(fields)) visit(field, name);
    documents.push({
      path: typeof content.path === "string" ? content.path : undefined,
      analyzerId:
        typeof content.analyzerId === "string"
          ? content.analyzerId
          : "not provided",
      category:
        typeof content.category === "string" ? content.category : undefined,
      facts,
      fields: displayFields,
    });
  }
  return documents;
}
export function sourceRegions(
  source: unknown,
  content: Record<string, unknown>,
  parent?: Record<string, unknown>,
) {
  const regions: Fact["regions"] = [];
  if (typeof source !== "string") return regions;
  for (const match of source.matchAll(/D\(([^)]+)\)/g)) {
    const values = match[1]
      .split(",")
      .map((value) => (value.trim() ? Number(value) : Number.NaN));
    const [page, ...coordinates] = values;
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      coordinates.length !== 8 ||
      !values.every(Number.isFinite) ||
      (typeof content.startPageNumber === "number" &&
        page < content.startPageNumber) ||
      (typeof content.endPageNumber === "number" &&
        page > content.endPageNumber)
    )
      continue;
    const ownPages = Array.isArray(content.pages) ? content.pages : [];
    const parentPages = Array.isArray(parent?.pages) ? parent.pages : [];
    const dimensions = record(
      [...ownPages, ...parentPages].find(
        (value) => record(value)?.pageNumber === page,
      ),
    );
    const width = dimensions?.width;
    const height = dimensions?.height;
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    )
      continue;
    const polygon = coordinates.map(
      (value, index) => value / (index % 2 === 0 ? width : height),
    );
    if (polygon.some((value) => value < 0 || value > 1)) continue;
    regions.push({ page, polygon });
  }
  return regions;
}
export function ranges(value: unknown, pageCount: number) {
  const parents = contents(value).filter(
    (content) => content.path === "input1" && Array.isArray(content.segments),
  );
  if (parents.length !== 1)
    throw new LabError(
      422,
      "Expected one input1 parent segmentation; do not count nested children.",
    );
  const segments = parents[0].segments;
  if (!Array.isArray(segments))
    throw new LabError(422, "Parent segments missing.");
  const rows = segments
    .map((segment) => {
      const item = record(segment);
      if (
        !item ||
        typeof item.category !== "string" ||
        !categories.some((category) => category === item.category) ||
        typeof item.startPageNumber !== "number" ||
        typeof item.endPageNumber !== "number" ||
        !Number.isInteger(item.startPageNumber) ||
        !Number.isInteger(item.endPageNumber) ||
        item.startPageNumber < 1 ||
        item.endPageNumber < item.startPageNumber ||
        item.endPageNumber > pageCount
      )
        throw new LabError(422, "Invalid CU page range.");
      return {
        category: item.category,
        start: item.startPageNumber,
        end: item.endPageNumber,
        segmentId: item.segmentId,
        confidence: item.confidence,
        span: item.span,
      };
    })
    .sort((a, b) => a.start - b.start);
  let next = 1;
  for (const row of rows) {
    if (row.start !== next)
      throw new LabError(422, "Page ranges overlap or leave a gap.");
    next = row.end + 1;
  }
  if (next !== pageCount + 1)
    throw new LabError(422, "Page ranges do not cover the input.");
  return rows;
}
