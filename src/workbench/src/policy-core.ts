import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LabError, record, repositoryRoot } from "./config.ts";
import { normalize } from "./results.ts";
import { fieldValue, type packetJson } from "./packet-json.ts";

export const checkNames = [
  "Rental eligibility and need",
  "Daily rate",
  "Duration and repair alignment",
  "Charges and reimbursement calculation",
  "Authorization and payment readiness",
] as const;
export const modeSchema = z.enum(["ungrounded", "search"]);
export type PolicyMode = z.infer<typeof modeSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const citationSchema = z.object({
  File: z.string().trim().min(1),
  DocumentId: z.string().trim().min(1),
  Version: z.string().trim().min(1),
  RuleId: z.string().trim().min(1),
  Section: z.string().trim().min(1),
}).strict();
export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    const object = record(item);
    return object ? Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]])) : item;
  });
}

export async function question() {
  const text = await readFile(path.join(repositoryRoot, "docs", "rental-review-agent-question-v2.md"), "utf8");
  const section = text.split("## Recommended question")[1]?.split("\n## ")[0];
  if (!section) throw new LabError(422, "Recommended policy question is missing.");
  const prompt = section.split(/\r?\n/).filter((line) => line.startsWith(">"))
    .map((line) => line.replace(/^> ?/, "")).join("\n").trim();
  if (!prompt) throw new LabError(422, "Recommended policy question is empty.");
  return prompt;
}

export function withClaimSummary(packet: ReturnType<typeof packetJson>, response: unknown) {
  const documents = normalize(response);
  if (!documents.some((doc) => doc.facts.length))
    throw new LabError(422, "The claim summary analyzer returned no structured fields.");
  const wrapper = record(response);
  if (typeof wrapper?.status !== "string" || wrapper.status.toLowerCase() !== "succeeded")
    throw new LabError(422, "Claim summary extraction has not succeeded.");
  const result = record(wrapper.result);
  if (!result || !Array.isArray(result.contents))
    throw new LabError(422, "Claim summary contents are missing.");
  const extractions = documents.map((document) => {
    const content = result.contents.find((item) => record(item)?.path === document.path);
    return {
      content_path: document.path ?? null,
      analyzer_id: document.analyzerId,
      fields: Object.fromEntries(Object.entries(record(record(content)?.fields) ?? {})
        .map(([name, value]) => [name, fieldValue(value, name)])),
      evidence: document.facts.map((fact) => ({
        field: fact.field, value: fact.value, status: fact.status,
        confidence: fact.confidence ?? null, source: fact.source ?? null,
        regions: fact.regions,
      })),
    };
  });
  return {
    ...packet,
    documents: [...packet.documents, {
      category: "claim_summary",
      pages: { start: 1, end: packet.source.page_count },
      classification_confidence: null,
      extracted_text: "",
      extractions,
    }],
  };
}

const citationMapSchema = z.array(z.object({
  documentId: z.string(), version: z.string(), pdf: z.string().regex(/^[a-z0-9-]+\.pdf$/),
  sha256: hash, ruleIds: z.array(z.string()),
  sections: z.record(z.string(), z.number().int().positive()),
}));
export async function resolveCitations(output: { Checks: { Citation: z.infer<typeof citationSchema>[] }[] }) {
  const relative = "policies/rental/ocr-comparison-v2";
  const folder = path.join(repositoryRoot, "data", relative);
  const maps = citationMapSchema.parse(JSON.parse(
    await readFile(path.join(folder, "citations.json"), "utf8"),
  ));
  const valid = new Set<string>();
  for (const map of maps)
    if (digest(await readFile(path.join(folder, map.pdf))) === map.sha256) valid.add(map.documentId);
  return output.Checks.map((check) => check.Citation.map((citation) => {
    const map = maps.find((item) =>
      valid.has(item.documentId) && item.documentId === citation.DocumentId &&
      (item.version === citation.Version || `v${item.version}` === citation.Version) &&
      item.ruleIds.includes(citation.RuleId),
    );
    const file = citation.File;
    let filename = file;
    if (file.startsWith("https://")) {
      try {
        const url = new URL(file);
        filename = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      } catch { filename = ""; }
    }
    const page = map?.sections[citation.Section];
    return {
      ...citation,
      href: map && filename === map.pdf && page
        ? `/data/${relative}/${map.pdf}#page=${page}` : null,
    };
  }));
}
