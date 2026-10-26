import { AzureCliCredential, getBearerTokenProvider } from "@azure/identity";
import { setTimeout } from "node:timers/promises";
import { configuration, LabError, record } from "./config.ts";

export class CuOperationError extends LabError {
  constructor(
    message: string,
    public response: unknown,
  ) {
    super(502, message);
  }
}
export function azureBearerToken() {
  return getBearerTokenProvider(
    new AzureCliCredential(),
    "https://cognitiveservices.azure.com/.default",
  );
}
export class CuClient {
  private bearerToken = azureBearerToken();
  constructor(
    private settings = configuration(),
    private operationTimeoutMs = 300_000,
  ) {}
  private async request(
    target: string,
    init: RequestInit = {},
    missingAllowed = false,
  ) {
    if (!this.settings.endpoint)
      throw new LabError(
        503,
        "Set CU_ENDPOINT and sign in with Azure CLI for cloud operations.",
      );
    const url = new URL(target, `${this.settings.endpoint}/`);
    if (url.origin !== new URL(this.settings.endpoint).origin)
      throw new LabError(
        502,
        "CU operation URL is outside the configured resource; no credentials were sent.",
      );
    url.searchParams.set("api-version", this.settings.apiVersion);
    const access = await this.bearerToken();
    if (!access)
      throw new LabError(401, "Azure CLI did not supply a CU access token.");
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { ...init.headers, Authorization: `Bearer ${access}` },
    });
    if (missingAllowed && response.status === 404) return response;
    if (!response.ok) {
      const text = (await response.text()).slice(0, 2000);
      throw new LabError(502, `CU HTTP ${response.status}: ${text}`);
    }
    return response;
  }
  private async poll(response: Response): Promise<unknown> {
    const location = response.headers.get("operation-location");
    if (!location) return response.json();
    const deadline = Date.now() + this.operationTimeoutMs;
    while (Date.now() < deadline) {
      await setTimeout(1500);
      const value: unknown = await (await this.request(location)).json();
      const status = record(value)?.status;
      if (typeof status !== "string")
        throw new LabError(502, "CU returned no operation status.");
      if (status.toLowerCase() === "succeeded") return value;
      if (["failed", "canceled"].includes(status.toLowerCase()))
        throw new CuOperationError(
          `CU operation ${status}: ${JSON.stringify(record(value)?.error ?? {})}`,
          value,
        );
      if (!["running", "notstarted"].includes(status.toLowerCase()))
        throw new LabError(502, `Unexpected CU status: ${status}`);
    }
    throw new LabError(
      504,
      `CU exceeded ${this.operationTimeoutMs / 60_000} minutes; no successful result was assumed.`,
    );
  }
  async detail(id: string): Promise<unknown | null> {
    const response = await this.request(
      `contentunderstanding/analyzers/${encodeURIComponent(id)}`,
      {},
      true,
    );
    return response.status === 404 ? null : response.json();
  }
  async list() {
    const analyzers: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let next: string | undefined = "contentunderstanding/analyzers";
    while (next) {
      if (seen.has(next))
        throw new LabError(502, "CU returned a repeated analyzer-list page.");
      seen.add(next);
      const page = record(await (await this.request(next)).json());
      if (!page || !Array.isArray(page.value))
        throw new LabError(502, "CU returned an invalid analyzer list.");
      for (const value of page.value) {
        const analyzer = record(value);
        if (!analyzer || typeof analyzer.analyzerId !== "string")
          throw new LabError(502, "CU returned an analyzer without an ID.");
        analyzers.push(analyzer);
      }
      if (page.nextLink != null && typeof page.nextLink !== "string")
        throw new LabError(
          502,
          "CU returned an invalid analyzer-list continuation.",
        );
      next = typeof page.nextLink === "string" ? page.nextLink : undefined;
    }
    return analyzers;
  }
  async analyze(id: string, bytes: Buffer) {
    return this.poll(
      await this.request(
        `contentunderstanding/analyzers/${encodeURIComponent(id)}:analyzeBinary`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: Uint8Array.from(bytes),
        },
      ),
    );
  }
}
