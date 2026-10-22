import { contents } from "./results.ts";
import { LabError, record } from "./config.ts";
import type { Packet, Run, summarize } from "./batch.ts";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export function fieldValue(value: unknown, name: string): JsonValue {
  const field = record(value);
  if (!field) throw new LabError(422, `Invalid field object: ${name}`);
  if (Array.isArray(field.valueArray))
    return field.valueArray.map((item, index) =>
      fieldValue(item, `${name}[${index}]`),
    );
  const object = record(field.valueObject);
  if (object)
    return Object.fromEntries(
      Object.entries(object).map(([key, child]) => [
        key,
        fieldValue(child, `${name}.${key}`),
      ]),
    );
  for (const key of [
    "valueString",
    "valueDate",
    "valueTime",
    "valueNumber",
    "valueInteger",
    "valueBoolean",
  ]) {
    const scalar = field[key];
    if (
      typeof scalar === "string" ||
      typeof scalar === "boolean" ||
      (typeof scalar === "number" && Number.isFinite(scalar))
    )
      return scalar;
  }
  // Unknown populated value types must not silently turn into missing facts.
  if (
    Object.entries(field).some(
      ([key, value]) => key.startsWith("value") && value != null,
    )
  )
    throw new LabError(422, `Unsupported CU value type for ${name}.`);
  return null;
}

/** A versioned evidence export, not an inferred claim or a policy decision. */
export function packetJson(
  response: unknown,
  packet: Packet,
  run: Run,
  review: ReturnType<typeof summarize>,
) {
  const allContents = contents(response);
  const result = record(record(response)?.result);
  return {
    schema_version: "1.0",
    kind: "content_understanding_packet",
    packet_id: packet.id,
    source: {
      file: packet.file,
      page_count: packet.pages,
      sha256: packet.sha256,
    },
    analysis: {
      run_id: run.id,
      analyzer_id: typeof result?.analyzerId === "string"
        ? result.analyzerId : run.analyzer.id,
      api_version: typeof result?.apiVersion === "string"
        ? result.apiVersion : run.apiVersion,
      created_at: typeof result?.createdAt === "string" ? result.createdAt : null,
      status: typeof record(response)?.status === "string"
        ? String(record(response)?.status) : null,
    },
    notes: [
      "Only CU-extracted facts and text are included; no authored expected labels or claim facts are substituted.",
      "Missing scalar values are null. Empty arrays remain empty arrays; false and zero are preserved.",
      "Policy, loss-state, repair and authorization facts may exist only in extracted text, not structured fields.",
      "Document categories are CU classifications, not proof of coverage or relevance. Different vehicle roles and unrelated documents must be reconciled.",
      "This export is evidence, not a coverage determination or payment approval.",
    ],
    extracted_text: (() => {
      const markdown = allContents.find((content) => content.path === "input1")?.markdown;
      return typeof markdown === "string" ? markdown : null;
    })(),
    documents: review.segments.map((segment) => ({
      category: segment.category,
      pages: { start: segment.start, end: segment.end },
      classification_confidence:
        typeof segment.confidence === "number" ? segment.confidence : null,
      extracted_text: segment.markdown,
      extractions: segment.documents.map((document) => {
        const content = allContents.find(
          (content) => content.path === document.path,
        );
        const fields = record(content?.fields);
        return {
          content_path: document.path ?? null,
          analyzer_id: document.analyzerId,
          fields: Object.fromEntries(
            Object.entries(fields ?? {}).map(([name, value]) => [
              name,
              fieldValue(value, name),
            ]),
          ),
          evidence: document.facts.map((fact) => ({
            field: fact.field,
            value: fact.value,
            status: fact.status,
            confidence: fact.confidence ?? null,
            source: fact.source ?? null,
            regions: fact.regions,
          })),
        };
      }),
    })),
  };
}
