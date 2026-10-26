import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { configuration, dataRoot, LabError, record } from "./config.ts";
import type { CuClient } from "./cu.ts";
import {
  Cache,
  dataset,
  packetBytes,
  summarize,
  type Packet,
  type Run,
} from "./batch.ts";
import { contents, normalize } from "./results.ts";
import { evaluatePolicies, type PolicyDocument } from "./policies.ts";
import { statementSchemaIssue } from "./definitions.ts";

type Client = Pick<CuClient, "detail" | "analyze">;
export type ReviewDocument = PolicyDocument & { url: string };
const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

export class DocumentService {
  constructor(
    private client: Client,
    private cache: Cache,
    public folder = path.join(cache.folder, "documents"),
  ) {}

  private source(packet: Packet, sourceId: string) {
    if (sourceId === "email-statement" && packet.id === "packet-01")
      return {
        start: 1,
        end: 1,
        file: path.join(dataRoot, "samples", "email-statement.pdf"),
        url: "/data/samples/email-statement.pdf",
      };
    const group = packet.expectedDocuments.find(
      (doc) => doc.sourceId === sourceId,
    );
    if (!group || !/^\d{2}-[a-z0-9_-]+$/.test(sourceId))
      throw new LabError(
        400,
        "Choose an individual document from this packet.",
      );
    return {
      ...group,
      file: path.join(dataRoot, "documents", packet.id, `${sourceId}.pdf`),
      url: `/data/packets/${packet.id}.pdf`,
    };
  }

  private async verify(id: string, statement: boolean) {
    if (!/^[A-Za-z0-9_.-]{3,128}$/.test(id))
      throw new LabError(400, "Invalid document analyzer ID.");
    const detail = record(await this.client.detail(id));
    const fields = record(record(detail?.fieldSchema)?.fields);
    if (
      !detail ||
      detail.status !== "ready" ||
      record(detail.config)?.enableSegment === true ||
      !fields
    )
      throw new LabError(
        422,
        "Choose a ready single-document extractor, not a packet classifier.",
      );
    if (statement && statementSchemaIssue(fields))
      throw new LabError(
        422,
        "The statement extractor needs the seven fields in the supplied statement schema.",
      );
    const definition = {
      config: detail.config,
      models: detail.models,
      fieldSchema: detail.fieldSchema,
    };
    return { definition, fingerprint: sha(JSON.stringify(definition)) };
  }

  async analyze(
    parent: Run,
    packet: Packet,
    sourceId: string,
    category: string,
    analyzerId: string,
  ) {
    const baseline = await this.review(parent, packet);
    await packetBytes(packet);
    const source = this.source(packet, sourceId);
    const bytes = await readFile(source.file);
    if (!analyzerId)
      throw new LabError(400, "An existing document analyzer ID is required.");
    const verified = await this.verify(analyzerId, category === "statement");
    const startedAt = new Date().toISOString();
    const response = await this.client.analyze(analyzerId, bytes);
    const extracted = normalize(response);
    if (!extracted.length)
      throw new LabError(
        422,
        "The rerun returned no extraction fields; no preview was accepted or saved.",
      );
    const id = randomUUID();
    const markdown = contents(response)
      .map((item) => (typeof item.markdown === "string" ? item.markdown : ""))
      .join("\n");
    const offset = source.start - 1;
    const mapFact = <
      T extends { regions: { page: number; polygon: number[] }[] },
    >(
      fact: T,
    ): T => ({
      ...fact,
      regions: fact.regions.map((region) => ({
        ...region,
        page: region.page + offset,
      })),
    });
    const documents: ReviewDocument[] = extracted.map((document, index) => ({
      id: `${id}:${index}`,
      category,
      analyzerId,
      start: source.start,
      end: source.end,
      sourceId,
      url: source.url,
      markdown,
      document: {
        ...document,
        facts: document.facts.map(mapFact),
        fields: document.fields.map((field) =>
          field.kind === "array"
            ? { ...field, items: field.items.map((item) => item.map(mapFact)) }
            : mapFact(field),
        ),
      },
    }));
    return {
      id,
      sourceId,
      category,
      analyzerId,
      analyzerFingerprint: verified.fingerprint,
      definition: verified.definition,
      inputSha256: sha(bytes),
      endpoint: configuration().endpoint,
      apiVersion: configuration().apiVersion,
      startedAt,
      completedAt: new Date().toISOString(),
      cached: false,
      persisted: false,
      response,
      documents,
      policies: evaluatePolicies([
        ...baseline.documents.filter((doc) => doc.sourceId !== sourceId),
        ...documents,
      ]),
    };
  }

  async review(parent: Run, packet: Packet, savedResponse?: unknown) {
    const current = await dataset();
    if (
      parent.datasetHash !== current.datasetHash ||
      !current.packets.some(
        (item) => item.id === packet.id && item.sha256 === packet.sha256,
      )
    )
      throw new LabError(
        409,
        "Policy checks require results for the current packet dataset.",
      );
    const response =
      savedResponse ?? (await this.cache.raw(parent.id, packet.id));
    const review = summarize(response, packet, parent.analyzer.mode);
    const documents: ReviewDocument[] = review.segments.flatMap((segment) =>
      segment.documents.map((document, index) => ({
        id: `${segment.start}-${segment.end}:${index}`,
        category: segment.category,
        analyzerId: document.analyzerId,
        start: segment.start,
        end: segment.end,
        document,
        markdown: segment.markdown,
        sourceId: packet.expectedDocuments.find(
          (source) =>
            source.start === segment.start && source.end === segment.end,
        )?.sourceId,
        url: `/data/packets/${packet.id}.pdf`,
      })),
    );
    return {
      documents,
      policies: evaluatePolicies(documents),
      source: {
        endpoint: parent.endpoint,
        runId: parent.id,
        packetSha256: packet.sha256,
        analyzerFingerprint: parent.analyzer.fingerprint,
      },
    };
  }
}
