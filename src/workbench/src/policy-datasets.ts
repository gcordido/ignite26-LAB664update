import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { dataRoot, LabError } from "./config.ts";
import { nativePreviewFolder } from "./policy-documents.ts";

export const policyDatasetId = z.enum(["original", "search", "digital"]);
const definitions = [
  { id: "original", label: "Original policy PDFs", folder: path.join(dataRoot, "policies", "rental", "ocr-comparison-v2") },
  { id: "search", label: "Saved prebuilt-documentSearch outputs", folder: path.join(nativePreviewFolder, "search") },
  { id: "digital", label: "Saved prebuilt-digitalParse outputs", folder: path.join(nativePreviewFolder, "digital") },
] as const;

export async function policyDatasets() {
  return Promise.all(definitions.map(async ({ id, label, folder }) => {
    const directory = await realpath(folder);
    if (!(await stat(directory)).isDirectory())
      throw new LabError(500, `Policy dataset directory is unavailable: ${label}.`);
    return { id, label, path: directory, href: pathToFileURL(directory + path.sep).href };
  }));
}

export async function launchPolicyFolder(directory: string) {
  if (process.platform !== "win32")
    throw new LabError(501, "Opening local folders is supported on the Windows workbench host. Copy the path instead.");
  await new Promise<void>((resolve, reject) => {
    // Arguments are fixed server-resolved directories, never command strings or request paths.
    const child = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe"),
      [directory], { shell: false, stdio: "ignore" });
    child.once("error", (error) =>
      reject(new LabError(503, `Windows Explorer could not be started: ${error.message}. Copy the path instead.`)));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
