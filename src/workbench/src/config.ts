import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");
export const repositoryRoot = path.resolve(root, "..", "..");
export const dataRoot = path.join(repositoryRoot, "data");
export const apiVersion = "2026-06-01-preview";
export const categories = [
  "id_document",
  "tax_1099a",
  "repair_estimate",
  "towing_invoice",
  "rental_invoice",
  "other",
] as const;

export class LabError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function configuration() {
  const endpoint = (process.env.CU_ENDPOINT ?? "").replace(/\/+$/, "");
  if (endpoint) {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      !/\.(services\.ai|cognitiveservices)\.azure\.com$/i.test(url.hostname) ||
      url.pathname !== "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new LabError(
        400,
        "CU_ENDPOINT must be an approved HTTPS Azure CU resource root, not a portal/project URL.",
      );
  }
  const port = Number(process.env.PORT ?? 8791);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new LabError(400, "PORT must be a TCP port number.");
  const selectedApiVersion = process.env.CU_API_VERSION ?? apiVersion;
  if (!["2025-11-01", apiVersion].includes(selectedApiVersion))
    throw new LabError(
      400,
      "CU_API_VERSION must be 2025-11-01 or 2026-06-01-preview.",
    );
  return { endpoint, port, apiVersion: selectedApiVersion };
}
