import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { repositoryRoot } from "./config.ts";

export const policySourcePrefix = "/data/policies/rental/ocr-comparison-v2/";
const corpus = "data/policies/rental/ocr-comparison-v2";
const archive = "data/policies/archive/legacy-rental-review-v2";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const pdf = z.string().regex(/^[a-z0-9-]+\.pdf$/);
const stateRules = z.record(z.string(), z.object({
  page: z.number().int().positive(), ruleId: z.string(),
}));
const identity = z.object({
  documentId: z.string().min(1), version: z.string().min(1), pdf,
  sha256: hash, ruleIds: z.array(z.string().min(1)).min(1),
  stateRules: stateRules.optional(),
});
const sourceSchema = identity.extend({
  documentType: z.string().min(1),
  role: z.string().optional(), states: z.array(z.string()).min(1),
  policyScope: z.object({ policyId: z.string(), vin: z.string() }).optional(),
}).passthrough();
const citationSchema = identity.extend({
  sections: z.record(z.string().min(1), z.number().int().positive()),
});
const archivedSchema = z.object({
  schemaVersion: z.literal(1),
  archiveId: z.literal("legacy-rental-review-v2"),
  includeInKnowledgeIndex: z.literal(false),
  sourceGeneration: z.object({
    manifestSha256: hash, citationsSha256: hash,
    originalManifest: z.literal("original-manifest.json"),
    originalCitations: z.literal("original-citations.json"),
  }),
  documents: z.array(identity.omit({ ruleIds: true, stateRules: true }).extend({
    originalLogicalPath: z.string(), archivePath: z.string(), rationale: z.string().min(1),
    source: sourceSchema, citation: citationSchema,
  })),
});

export type PolicySource = z.infer<typeof sourceSchema> & z.infer<typeof citationSchema> & {
  path: string; href: string; archived: boolean;
};
export type PolicySourceOptions = {
  repositoryRoot?: string;
  includeArchived?: boolean;
  origin?: string;
};
function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function sameIdentity(source: z.infer<typeof identity>, citation: z.infer<typeof identity>) {
  return ["documentId", "version", "pdf", "sha256"].every(
    (key) => source[key as keyof typeof source] === citation[key as keyof typeof citation],
  ) && JSON.stringify(source.ruleIds) === JSON.stringify(citation.ruleIds) &&
    JSON.stringify(source.stateRules) === JSON.stringify(citation.stateRules);
}
async function containedFile(root: string, relative: string) {
  const [base, resolved] = await Promise.all([
    realpath(root), realpath(path.join(root, relative)),
  ]);
  const local = path.relative(base, resolved);
  if (!local || local.startsWith(`..${path.sep}`) || local === ".." || path.isAbsolute(local))
    throw new Error("Policy source escapes the repository.");
  return resolved;
}

/** Active sources only by default: callers must explicitly opt in to historical aliases. */
export async function loadPolicySources(options: PolicySourceOptions = {}): Promise<PolicySource[]> {
  const root = options.repositoryRoot ?? repositoryRoot;
  const manifest = z.object({
    documents: z.array(sourceSchema).min(1), activeChecks: z.array(z.string()).optional(),
  }).parse(
    JSON.parse(await readFile(await containedFile(root, `${corpus}/manifest.json`), "utf8")),
  );
  const citations = z.array(citationSchema).parse(
    JSON.parse(await readFile(await containedFile(root, `${corpus}/citations.json`), "utf8")),
  );
  if (manifest.activeChecks) {
    const states = ["AZ", "CA", "CO", "FL", "IL", "LA", "NY", "OH", "TX", "WA"];
    const declarations = manifest.documents.filter((d) => d.role === "revised_declarations");
    const effective = manifest.documents.filter((d) =>
      d.role === "policy_effective_date" || d.role === "issued_amendment");
    const repairs = manifest.documents.filter((d) => d.role === "repair_review");
    const sameStates = (items: z.infer<typeof sourceSchema>[]) =>
      JSON.stringify(items.map((d) => d.states[0]).sort()) === JSON.stringify(states);
    if (JSON.stringify(manifest.activeChecks) !==
        JSON.stringify(["Daily rate", "Effective terms", "Repair estimate"]) ||
        manifest.documents.length !== 21 || declarations.length !== 10 || effective.length !== 10 ||
        repairs.length !== 1 || !sameStates(declarations) || !sameStates(effective) ||
        [...declarations, ...effective].some((d) =>
          d.documentType !== "policy_contract" || d.states.length !== 1) ||
        effective.filter((d) => d.role === "issued_amendment").some((d) => d.states[0] !== "TX") ||
        effective.filter((d) => d.role === "issued_amendment").length !== 1 ||
        repairs[0]?.documentType !== "repair_review_sop" ||
        JSON.stringify([...repairs[0].states].sort()) !== JSON.stringify(states))
      throw new Error("The three-check source inventory is incomplete or contains legacy sources.");
  }
  if (citations.length !== manifest.documents.length ||
      new Set(citations.map((c) => c.documentId)).size !== citations.length)
    throw new Error("Policy citation registrations differ from the active manifest.");
  const registrations = manifest.documents.map((source) => ({
    source, citation: citations.find((c) => c.documentId === source.documentId),
    relative: `${corpus}/${source.pdf}`, archived: false,
  }));
  if (options.includeArchived) {
    const registry = archivedSchema.parse(JSON.parse(
      await readFile(await containedFile(root, `${archive}/registry.json`), "utf8"),
    ));
    const [originalManifest, originalCitations] = await Promise.all([
      readFile(await containedFile(root, `${archive}/original-manifest.json`)),
      readFile(await containedFile(root, `${archive}/original-citations.json`)),
    ]);
    if (digest(originalManifest) !== registry.sourceGeneration.manifestSha256 ||
        digest(originalCitations) !== registry.sourceGeneration.citationsSha256)
      throw new Error("Historical source-generation metadata hash mismatch.");
    const originals = z.object({ documents: z.array(sourceSchema) }).parse(
      JSON.parse(originalManifest.toString("utf8")),
    ).documents;
    const originalMaps = z.array(citationSchema).parse(JSON.parse(originalCitations.toString("utf8")));
    for (const entry of registry.documents) {
      const original = originals.find((d) => d.documentId === entry.documentId);
      const originalMap = originalMaps.find((d) => d.documentId === entry.documentId);
      if (entry.originalLogicalPath !== `${corpus}/${entry.pdf}` ||
          entry.archivePath !== `${archive}/${entry.pdf}` ||
          !["documentId", "version", "pdf", "sha256"].every(
            (key) => entry[key as "documentId"] === entry.source[key as "documentId"],
          ) || !sameIdentity(entry.source, entry.citation) ||
          !original || !originalMap || !sameIdentity(entry.source, original) ||
          !sameIdentity(entry.citation, originalMap) ||
          JSON.stringify(entry.citation.sections) !== JSON.stringify(originalMap.sections))
        throw new Error("Historical policy alias disagrees with its source registration.");
      registrations.push({
        source: entry.source, citation: entry.citation,
        relative: entry.archivePath, archived: true,
      });
    }
  }
  const seenIds = new Set<string>(), seenFiles = new Set<string>();
  const result: PolicySource[] = [];
  for (const { source, citation, relative, archived } of registrations) {
    if (!citation || !sameIdentity(source, citation) || !Object.keys(citation.sections).length ||
        seenIds.has(source.documentId) || seenFiles.has(source.pdf))
      throw new Error("Policy source/citation identity is missing, duplicated or inconsistent.");
    seenIds.add(source.documentId);
    seenFiles.add(source.pdf);
    if (source.stateRules && Object.values(source.stateRules).some(
      (rule) => !source.ruleIds.includes(rule.ruleId) ||
        !Object.values(citation.sections).includes(rule.page),
    )) throw new Error("Policy state rule does not match registered sections/pages.");
    const filename = await containedFile(root, relative);
    if (digest(await readFile(filename)) !== source.sha256)
      throw new Error(`Policy PDF hash mismatch: ${source.documentId}`);
    result.push({ ...source, ...citation, path: filename,
      href: `${policySourcePrefix}${source.pdf}`, archived });
  }
  return result;
}

/** Accept a registered filename or exact same-origin historical logical URL, never a disk path. */
export function policySourceFilename(file: string, options: PolicySourceOptions = {}): string | null {
  let value = file;
  if (/^https?:\/\//.test(value)) {
    try {
      const url = new URL(value);
      if (!options.origin || url.origin !== new URL(options.origin).origin ||
          url.username || url.password || url.search || url.hash) return null;
      value = url.pathname;
    } catch { return null; }
  }
  if (value.startsWith(policySourcePrefix)) value = value.slice(policySourcePrefix.length);
  return pdf.safeParse(value).success ? value : null;
}

export async function verifiedPolicySource(
  file: string, options: PolicySourceOptions = {},
): Promise<PolicySource | null> {
  const filename = policySourceFilename(file, options);
  if (!filename) return null;
  return (await loadPolicySources(options)).find((source) => source.pdf === filename) ?? null;
}
