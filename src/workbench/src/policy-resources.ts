import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { cacheFolders, record } from "./config.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const resourcePrefix = "/subscriptions/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/resourceGroups/[A-Za-z0-9_().-]+/providers/";
const searchId = new RegExp(`^${resourcePrefix}Microsoft\\.Search/searchServices/([a-z0-9-]{2,60})$`, "i");
const storageId = new RegExp(`^${resourcePrefix}Microsoft\\.Storage/storageAccounts/([a-z0-9]{3,24})$`, "i");
export const resourceProvenanceSchema = z.object({
  schemaVersion: z.literal(1),
  indexName: z.string().regex(/^[a-z0-9][a-z0-9-]{1,126}$/),
  corpusHash: hash,
  indexFingerprint: hash,
  search: z.object({
    resourceId: z.string().regex(searchId),
    location: z.string().regex(/^[A-Za-z0-9 ]{2,60}$/),
    sku: z.enum(["free", "basic", "standard", "standard2", "standard3", "storage_optimized_l1", "storage_optimized_l2"]),
  }).strict(),
  storage: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("local") }).strict(),
    z.object({
      kind: z.literal("blob"),
      resourceId: z.string().regex(storageId),
      containerName: z.string().regex(/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/),
    }).strict(),
  ]),
}).strict();

type Generation = {
  indexName: string; corpusHash: string; indexFingerprint: string; searchEndpoint: string;
};
export type PolicyResources = {
  index: { name: string; href?: string; message?: string };
  storage: { containerName?: string; href?: string; message: string };
};
export function policyResourceLinks(config: Generation, metadata: unknown): PolicyResources {
  const unavailable = (message: string): PolicyResources => ({
    index: { name: config.indexName, message },
    storage: { message },
  });
  if (metadata === undefined)
    return unavailable("Verified resource metadata is unavailable for this policy generation.");
  const parsed = resourceProvenanceSchema.safeParse(metadata);
  if (!parsed.success)
    return unavailable("Policy resource metadata is invalid; no portal links are available.");
  const value = parsed.data;
  if (value.indexName !== config.indexName || value.corpusHash !== config.corpusHash ||
      value.indexFingerprint !== config.indexFingerprint)
    return unavailable("Resource metadata belongs to a different policy generation.");
  const serviceName = searchId.exec(value.search.resourceId)![1];
  if (config.searchEndpoint.replace(/\/$/, "").toLowerCase() !== `https://${serviceName.toLowerCase()}.search.windows.net`)
    return unavailable("Search resource metadata does not match the configured endpoint.");
  const index = {
    name: config.indexName,
    href: `https://portal.azure.com/#view/Microsoft_Azure_Search/Index.ReactView/id/${
      encodeURIComponent(`${value.search.resourceId}#${config.indexName}`)
    }/location/${encodeURIComponent(value.search.location)}/sku/${encodeURIComponent(value.search.sku)}`,
  };
  return {
    index,
    storage: value.storage.kind === "local"
      ? { message: "No verified Azure container; policy documents are stored in the local corpus." }
      : {
        containerName: value.storage.containerName,
        href: `https://portal.azure.com/#view/Microsoft_Azure_Storage/ContainerMenuBlade/~/overview/storageAccountId/${
          encodeURIComponent(value.storage.resourceId)
        }/path/${encodeURIComponent(value.storage.containerName)}`,
        message: "Verified policy-generation source container.",
      },
  };
}
export async function policyResources(config: Generation, folder = cacheFolders().policy) {
  let metadata: unknown;
  try { metadata = JSON.parse(await readFile(path.join(folder, "resources.json"), "utf8")); }
  catch (error) {
    if (record(error)?.code !== "ENOENT") {
      console.error(JSON.stringify({ event: "policy_resource_metadata_failed", message: String(error) }));
      return policyResourceLinks(config, null);
    }
  }
  const resources = policyResourceLinks(config, metadata);
  if (resources.index.message)
    console.error(JSON.stringify({ event: "policy_resource_metadata_unavailable", message: resources.index.message }));
  return resources;
}
