import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LabError, record, repositoryRoot } from "./config.ts";
import { contents, normalize } from "./results.ts";
import { fieldValue, type packetJson } from "./packet-json.ts";

export const checkNames = [
  "Daily rate",
  "Rental start",
  "Effective terms",
] as const;
export const checkContractVersion = 3;
export const modeSchema = z.enum(["ungrounded", "search"]);
export type PolicyMode = z.infer<typeof modeSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const citationSchema = z
  .object({
    File: z.string().trim().min(1),
    DocumentId: z.string().trim().min(1),
    Version: z.string().trim().min(1),
    RuleId: z.string().trim().min(1),
    Section: z.string().trim().min(1),
  })
  .strict();
export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const parseSourceDigest = (value: Buffer | string) =>
  digest(value.toString().replace(/\r\n/g, "\n"));
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    const object = record(item);
    return object
      ? Object.fromEntries(
          Object.keys(object)
            .sort()
            .map((key) => [key, object[key]]),
        )
      : item;
  });
}

export async function question() {
  const text = await readFile(
    path.join(repositoryRoot, "docs", "rental-review-agent-question-v2.md"),
    "utf8",
  );
  const section = text.split("## Recommended question")[1]?.split("\n## ")[0];
  if (!section)
    throw new LabError(422, "Recommended policy question is missing.");
  const prompt = section
    .split(/\r?\n/)
    .filter((line) => line.startsWith(">"))
    .map((line) => line.replace(/^> ?/, ""))
    .join("\n")
    .trim();
  if (!prompt) throw new LabError(422, "Recommended policy question is empty.");
  return prompt;
}

export function withClaimSummary(
  packet: ReturnType<typeof packetJson>,
  response: unknown,
) {
  const documents = normalize(response);
  if (!documents.some((doc) => doc.facts.length))
    throw new LabError(
      422,
      "The claim summary analyzer returned no structured fields.",
    );
  const wrapper = record(response);
  if (
    typeof wrapper?.status !== "string" ||
    wrapper.status.toLowerCase() !== "succeeded"
  )
    throw new LabError(422, "Claim summary extraction has not succeeded.");
  const result = record(wrapper.result);
  if (!result || !Array.isArray(result.contents))
    throw new LabError(422, "Claim summary contents are missing.");
  const sourceContents = result.contents;
  const extractions = documents.map((document) => {
    const content = sourceContents.find(
      (item) => record(item)?.path === document.path,
    );
    return {
      content_path: document.path ?? null,
      analyzer_id: document.analyzerId,
      fields: Object.fromEntries(
        Object.entries(record(record(content)?.fields) ?? {}).map(
          ([name, value]) => [name, fieldValue(value, name)],
        ),
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
  });
  return {
    ...packet,
    documents: [
      ...packet.documents,
      {
        category: "claim_summary",
        pages: { start: 1, end: packet.source.page_count },
        classification_confidence: null,
        extracted_text: "",
        extractions,
      },
    ],
  };
}

/** Values from extraction only, once per document; no OCR or duplicated prose. */
export function policyClaimFacts(packet: ReturnType<typeof packetJson>): string {
  return JSON.stringify({
    packet_id: packet.packet_id,
    documents: packet.documents.flatMap((document) =>
      document.extractions.map((extraction) => ({
        category: document.category,
        fields: extraction.fields,
      })),
    ),
  });
}

/** Preserve typed CU values alongside selected native page evidence. */
export function policyClaimAnalysis(
  packet: ReturnType<typeof packetJson>, response: unknown, summary?: unknown,
) {
  function typedField(value: unknown, name: string): Record<string, unknown> {
    fieldValue(value, name);
    const field = record(value);
    if (!field || typeof field.type !== "string")
      throw new LabError(422, `Missing CU field type: ${name}`);
    const result: Record<string, unknown> = { type: field.type };
    const object = record(field.valueObject);
    if (Array.isArray(field.valueArray))
      result.valueArray = field.valueArray.map((item, index) => typedField(item, `${name}[${index}]`));
    else if (object) {
      result.valueObject = Object.fromEntries(Object.entries(object)
        .map(([key, child]) => [key, typedField(child, `${name}.${key}`)]));
    } else
      for (const key of ["valueString", "valueDate", "valueTime", "valueNumber", "valueInteger", "valueBoolean"])
        if (field[key] !== undefined) result[key] = field[key];
    return result;
  }
  const parsedContents = contents(response), summaryContents = summary === undefined ? [] : contents(summary);
  return {
    contents: packet.documents.filter((document) =>
      !["id_document", "tax_1099a"].includes(document.category)).flatMap((document) =>
      document.extractions.map((extraction) => {
        const source = (document.category === "claim_summary" ? summaryContents : parsedContents)
          .find((item) => item.path === extraction.content_path);
        const fields = record(source?.fields);
        if (!fields) throw new LabError(422, "CU fields are missing for a policy input document.");
        return {
          kind: "document", category: document.category,
          contentPath: extraction.content_path,
          pages: document.pages,
          fields: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, typedField(value, name)])),
        };
      }),
    ),
    textEvidence: parsedTextEvidence(packet),
  };
}

export function parsedTextEvidence(packet: ReturnType<typeof packetJson>) {
  return packet.documents.flatMap((document) => {
    const text = document.extracted_text;
    if (!text.trim() || ["id_document", "tax_1099a", "claim_summary"].includes(document.category))
      return [];
    if (document.category === "other" &&
        !/\b(?:policy|insured|loss|claim|rental|drivab|drivable|repair|collision|coverage|vehicle condition)\b/i.test(text))
      return [];
    const contentPath = document.extractions[0]?.content_path ??
      `input1/pages-${document.pages.start}-${document.pages.end}`;
    return [{
      id: `parse.${contentPath}`,
      category: document.category, contentPath, pages: document.pages, text,
    }];
  });
}

/** Resolve only explicit identities; page-text values remain derived context, not CU fields. */
export function parsedPolicyScope(packet: ReturnType<typeof packetJson>) {
  const states = new Set<string>(), policyIds = new Set<string>(), typedVins = new Set<string>();
  const explicitVins = new Set<string>();
  const evidence = parsedTextEvidence(packet);
  function add(set: Set<string>, value: unknown, valid: RegExp) {
    if (typeof value === "string" && valid.test(value.trim()))
      set.add(value.trim().toUpperCase());
  }
  for (const document of packet.documents) {
    if (["id_document", "tax_1099a", "rental_invoice", "towing_invoice"].includes(document.category)) continue;
    for (const extraction of document.extractions) {
      const fields = extraction.fields;
      const routing = record(fields.Routing), policy = record(fields.Policy);
      const insured = record(fields.InsuredVehicle);
      add(states, routing?.LossState ?? fields.LossState, /^[A-Z]{2}$/i);
      if (document.category === "statement" && typeof fields.incident_location === "string") {
        const state = fields.incident_location.match(/\b([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/)?.[1];
        add(states, state, /^[A-Z]{2}$/i);
      }
      add(policyIds, policy?.PolicyId ?? fields.PolicyId, /^(?=.*\d)[A-Z0-9-]{4,64}$/i);
      add(typedVins, insured?.VIN ?? fields.InsuredVIN ?? fields.vin, /^[A-HJ-NPR-Z0-9]{17}$/i);
    }
  }
  for (const source of evidence) {
    if (["rental_invoice", "towing_invoice"].includes(source.category)) continue;
    const labels = source.text
      .replace(/<!--\s*Page(?:Header|Footer)\s*[:=]\s*([\s\S]*?)-->/g, "$1")
      .replace(/<[^>]*>/g, " ");
    for (const match of labels.matchAll(/\b(?:Loss\s+State|Incident\s+State)\s*[:|]\s*([A-Z]{2})\b/gi))
      add(states, match[1], /^[A-Z]{2}$/i);
    if (source.category === "statement" || source.category === "other") {
      for (const match of labels.matchAll(/(?:^|\n)\s*(?:Location of (?:Loss|Discovery)|Incident Location|Location)\s*:?\s*\n?([^\n]*(?:\n[^\n]*){0,3})/gi)) {
        const state = match[1].match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/)?.[1];
        add(states, state, /^[A-Z]{2}$/i);
      }
    }
    for (const match of labels.matchAll(/\bPolicy\s*(?:ID|Number|No\.?)[\s:#|]+([A-Z0-9-]+)/gi))
      add(policyIds, match[1], /^(?=.*\d)[A-Z0-9-]{4,64}$/i);
    if (source.category === "rental_invoice" || source.category === "towing_invoice") continue;
    for (const match of labels.matchAll(/\b(?:Insured\s+(?:Vehicle\s+)?VIN|VIN\s*\(insured(?:\s+vehicle)?\))\s*[:|]\s*([A-HJ-NPR-Z0-9]{17})\b/gi))
      add(explicitVins, match[1], /^[A-HJ-NPR-Z0-9]{17}$/i);
  }
  const vins = new Set([...typedVins, ...explicitVins]);
  return {
    lossState: states.size === 1 ? [...states][0] : null,
    policyScope: {
      policyId: policyIds.size === 1 ? [...policyIds][0] : null,
      vin: vins.size === 1 ? [...vins][0] : null,
    },
    scopeConflicts: {
      lossStates: [...states], policyIds: [...policyIds], insuredVins: [...vins],
    },
  };
}

const citationMapSchema = z.array(
  z.object({
    documentId: z.string(),
    version: z.string(),
    pdf: z.string().regex(/^[a-z0-9-]+\.pdf$/),
    sha256: hash,
    ruleIds: z.array(z.string()),
    sections: z.record(z.string(), z.number().int().positive()),
  }),
);
export async function resolveCitations(output: {
  Checks: { Citation: z.infer<typeof citationSchema>[] }[];
}) {
  const relative = "policies/rental/ocr-comparison-v2";
  const folder = path.join(repositoryRoot, "data", relative);
  const maps = citationMapSchema.parse(
    JSON.parse(await readFile(path.join(folder, "citations.json"), "utf8")),
  );
  const valid = new Set<string>();
  for (const map of maps)
    if (digest(await readFile(path.join(folder, map.pdf))) === map.sha256)
      valid.add(map.documentId);
  return output.Checks.map((check) =>
    check.Citation.map((citation) => {
      const map = maps.find(
        (item) =>
          valid.has(item.documentId) &&
          item.documentId === citation.DocumentId &&
          (item.version === citation.Version ||
            `v${item.version}` === citation.Version) &&
          item.ruleIds.includes(citation.RuleId),
      );
      const file = citation.File;
      let filename = file;
      if (file.startsWith("https://")) {
        try {
          const url = new URL(file);
          filename = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        } catch {
          filename = "";
        }
      }
      const page = map?.sections[citation.Section];
      return {
        ...citation,
        href:
          map && filename === map.pdf && page
            ? `/data/${relative}/${map.pdf}#page=${page}`
            : null,
      };
    }),
  );
}
