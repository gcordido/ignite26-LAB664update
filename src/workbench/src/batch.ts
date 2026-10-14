import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  categories,
  configuration,
  dataRoot,
  LabError,
  record,
} from "./config.ts";
import { normalize, ranges, contents } from "./results.ts";
import type { verifyAnalyzer } from "./definitions.ts";

const packetSchema = z.object({
  id: z.string().regex(/^packet-\d{2}$/),
  sourceBatch: z.string(),
  claimId: z.string(),
  file: z.string().regex(/^packets\/packet-\d{2}\.pdf$/),
  pages: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedDocuments: z.array(
    z.object({
      sourceId: z.string(),
      title: z.string(),
      category: z.enum(categories),
      start: z.number().int().positive(),
      end: z.number().int().positive(),
    }),
  ),
  expectedRepair: z.object({
    vehicle: z.string(),
    vin: z.string(),
    odometer: z.number(),
  }),
});
export async function dataset() {
  return z
    .object({
      source: z.string(),
      datasetHash: z.string(),
      synthetic: z.literal(true),
      labelOrigin: z.string(),
      packets: z.array(packetSchema),
    })
    .parse(
      JSON.parse(await readFile(path.join(dataRoot, "packets.json"), "utf8")),
    );
}
export type Packet = z.infer<typeof packetSchema>;
export type Analyzer = Awaited<ReturnType<typeof verifyAnalyzer>>;
export type Item = {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "not processed";
  startedAt?: string;
  completedAt?: string;
  rawSaved?: boolean;
  error?: string;
};
export type Run = {
  id: string;
  origin: "Live CU";
  status: "running" | "completed" | "failed";
  endpoint: string;
  apiVersion: string;
  analyzer: Analyzer;
  datasetHash: string;
  startedAt: string;
  completedAt?: string;
  maxInFlight?: number;
  items: Item[];
  source: Packet[];
};
const runIdSchema = z.string().uuid();
export class Cache {
  constructor(public folder = path.join(dataRoot, "results")) {}
  private directory(id: string) {
    return path.join(this.folder, runIdSchema.parse(id));
  }
  async save(run: Run) {
    const directory = this.directory(run.id);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "manifest.json");
    await writeFile(`${file}.tmp`, JSON.stringify(run, null, 2));
    await rename(`${file}.tmp`, file);
  }
  async raw(runId: string, packetId: string, value?: unknown) {
    if (!/^packet-\d{2}$/.test(packetId))
      throw new LabError(400, "Invalid packet ID.");
    const file = path.join(this.directory(runId), `${packetId}.cu.json`);
    if (value !== undefined) {
      await mkdir(this.directory(runId), { recursive: true });
      await writeFile(file, JSON.stringify(value, null, 2), { flag: "wx" });
    }
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  }
  async load(id: string) {
    const value: unknown = JSON.parse(
      await readFile(path.join(this.directory(id), "manifest.json"), "utf8"),
    );
    const manifest = record(value);
    if (
      !manifest ||
      manifest.id !== id ||
      !Array.isArray(manifest.items) ||
      !Array.isArray(manifest.source)
    )
      throw new LabError(422, "Invalid cache manifest.");
    // Only manifests created by this local service are stored here.
    return value as Run;
  }
  async list() {
    let entries;
    try {
      entries = await readdir(this.folder, { withFileTypes: true });
    } catch (error) {
      if (record(error)?.code === "ENOENT") return [];
      throw error;
    }
    const runs: Run[] = [];
    for (const entry of entries)
      if (entry.isDirectory() && runIdSchema.safeParse(entry.name).success)
        runs.push(await this.load(entry.name));
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
export async function newRun(analyzer: Analyzer): Promise<Run> {
  const data = await dataset();
  return {
    id: randomUUID(),
    origin: "Live CU",
    status: "running",
    endpoint: configuration().endpoint,
    apiVersion: configuration().apiVersion,
    analyzer,
    datasetHash: data.datasetHash,
    startedAt: new Date().toISOString(),
    maxInFlight: 5,
    items: data.packets.map(({ id }) => ({ id, status: "pending" })),
    source: data.packets,
  };
}
export async function packetBytes(packet: Packet) {
  const bytes = await readFile(
    path.join(dataRoot, "packets", `${packet.id}.pdf`),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== packet.sha256)
    throw new LabError(
      409,
      `${packet.id} source PDF hash changed; no CU call was made.`,
    );
  return bytes;
}
export function summarize(
  response: unknown,
  packet: Packet,
  mode: Analyzer["mode"],
) {
  const rows = ranges(response, packet.pages);
  const documents = normalize(response);
  const allContents = contents(response);
  const parentMarkdown = allContents.find(
    (content) => content.path === "input1",
  )?.markdown;
  let markdownUnits: string | string[] | undefined;
  function segmentText(value: unknown) {
    if (value === undefined || typeof parentMarkdown !== "string") return "";
    const span = record(value);
    const offset = span?.offset;
    const length = span?.length;
    if (
      typeof offset !== "number" ||
      typeof length !== "number" ||
      !Number.isInteger(offset) ||
      !Number.isInteger(length) ||
      offset < 0 ||
      length < 0
    )
      throw new LabError(422, "Invalid native CU segment text span.");
    if (markdownUnits === undefined) {
      const encoding = record(record(response)?.result)?.stringEncoding;
      if (encoding === "codePoint") markdownUnits = Array.from(parentMarkdown);
      else if (encoding === "utf16") markdownUnits = parentMarkdown;
      else if (encoding === "textElements")
        markdownUnits = Array.from(
          new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
            parentMarkdown,
          ),
          (item) => item.segment,
        );
      else
        throw new LabError(
          422,
          `Unsupported CU span string encoding: ${String(encoding)}`,
        );
    }
    if (offset + length > markdownUnits.length)
      throw new LabError(
        422,
        "Native CU segment text span exceeds parent markdown.",
      );
    const text = markdownUnits.slice(offset, offset + length);
    return typeof text === "string" ? text : text.join("");
  }
  const findings: { kind: string; pages: string; message: string }[] = [];
  const segments = rows.map((row, index) => {
    const expected = packet.expectedDocuments.filter(
      (doc) => doc.start <= row.end && doc.end >= row.start,
    );
    const exact =
      expected.length === 1 &&
      expected[0].start === row.start &&
      expected[0].end === row.end;
    if (expected.length > 1)
      findings.push({
        kind: "merged source groups",
        pages: `${row.start}-${row.end}`,
        message: `One CU segment overlaps ${expected.map((doc) => doc.title).join("; ")}. Compare source documents before accepting the boundary.`,
      });
    else if (!exact)
      findings.push({
        kind: "split source group",
        pages: `${row.start}-${row.end}`,
        message: `CU split within ${expected[0]?.title ?? "an unlabeled range"}. Source grouping is an authored reference, not automatic proof of error.`,
      });
    const newInvoiceClass = ["towing_invoice", "rental_invoice"].includes(
      row.category,
    );
    if (newInvoiceClass && expected.some((doc) => doc.category === "other"))
      findings.push({
        kind: "invoice taxonomy reference",
        pages: `${row.start}-${row.end}`,
        message:
          "The authored four-class reference labeled invoices Other. This routed run has separate towing/rental classes; inspect the source rather than treating the old label as a model error.",
      });
    if (
      expected.some(
        (doc) =>
          doc.category !== row.category &&
          !(newInvoiceClass && doc.category === "other"),
      )
    )
      findings.push({
        kind: "category differs",
        pages: `${row.start}-${row.end}`,
        message: `CU returned ${row.category}; authored label(s): ${[...new Set(expected.map((doc) => doc.category))].join(", ")}.`,
      });
    if (typeof row.confidence === "number" && row.confidence < 0.6)
      findings.push({
        kind: "low classification confidence",
        pages: `${row.start}-${row.end}`,
        message: `${Math.round(row.confidence * 100)}%; illustrative review threshold, not a calibrated probability.`,
      });
    const contentPath = `input1/segment${String(row.segmentId ?? index + 1).replace(/^segment/, "")}`;
    const content = allContents.find((content) => content.path === contentPath);
    return {
      ...row,
      expected,
      boundaryMatches: exact,
      documents: documents.filter(
        (doc) =>
          doc.path === contentPath || doc.path?.startsWith(`${contentPath}/`),
      ),
      markdown:
        typeof content?.markdown === "string"
          ? content.markdown
          : segmentText(row.span),
    };
  });
  if (mode === "routed") {
    const repair = segments.find((row) => row.category === "repair_estimate");
    const facts = repair?.documents.flatMap((doc) => doc.facts) ?? [];
    for (const [name, expected] of Object.entries(packet.expectedRepair)) {
      const fact = facts.find((fact) => fact.field === name);
      if (
        !fact ||
        fact.status === "missing" ||
        String(fact.value) !== String(expected)
      )
        findings.push({
          kind: "repair field needs review",
          pages: repair ? `${repair.start}-${repair.end}` : "not found",
          message: `${name}: CU ${fact?.value ?? "missing"}; authored repair source ${expected}.`,
        });
    }
  }
  return {
    segments,
    findings,
    documentCount: rows.length,
    expectedDocumentCount: packet.expectedDocuments.length,
    pageCoverageVerified: true,
    extractionAvailable: mode === "routed",
    humanSourceReviewRequired: true,
    usage:
      record(record(response)?.result)?.usage ??
      record(response)?.usage ??
      null,
  };
}
