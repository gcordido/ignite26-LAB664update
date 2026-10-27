import { AzureCliCredential, getBearerTokenProvider } from "@azure/identity";
import { setTimeout } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs";
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
    private context: { packetId?: string; jobId?: string; purpose?: string } = {},
  ) {}
  private diagnostic(event: string, details: Record<string, unknown>) {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(), event, ...this.context, ...details,
    });
    console.error(line);
    if (process.env.CU_DIAGNOSTICS_LOG)
      appendFile(process.env.CU_DIAGNOSTICS_LOG, `${line}\n`, (error) => {
        if (error) console.error(JSON.stringify({
          timestamp: new Date().toISOString(), event: "cu_diagnostics_write_failed",
          code: error.code, message: error.message,
        }));
      });
  }
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
    const started = Date.now();
    const clientRequestId = randomUUID();
    const details = {
      method: init.method ?? "GET", endpoint: url.origin, path: url.pathname,
      apiVersion: this.settings.apiVersion, clientRequestId,
    };
    let stage = "authentication";
    let reported = false;
    let responseDetails: Record<string, unknown> = {};
    this.diagnostic("cu_request_started", details);
    try {
      const access = await this.bearerToken();
      if (!access)
        throw new LabError(401, "Azure CLI did not supply a CU access token.");
      stage = "request";
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${access}`);
      headers.set("x-ms-client-request-id", clientRequestId);
      const response = await fetch(url, {
        ...init, redirect: "error", signal: AbortSignal.timeout(30_000), headers,
      });
      responseDetails = {
        httpStatus: response.status,
        serviceRequestId: response.headers.get("x-ms-request-id"),
        apimRequestId: response.headers.get("apim-request-id"),
        correlationRequestId: response.headers.get("x-ms-correlation-request-id"),
        region: response.headers.get("x-ms-region"),
        responseDate: response.headers.get("date"),
        retryAfter: response.headers.get("retry-after"),
      };
      if (!response.ok && !(missingAllowed && response.status === 404)) {
        stage = "response-body";
        const text = (await response.text()).slice(0, 2000);
        let body: Record<string, unknown> | undefined;
        try { body = record(JSON.parse(text)); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        this.diagnostic("cu_request_failed", {
          ...details, ...responseDetails, elapsedMs: Date.now() - started,
          stage: "http-response", activityId: body?.activityId,
          serviceErrorCode: record(body?.error)?.code ?? body?.statusCode,
        });
        reported = true;
        throw new LabError(502, `CU HTTP ${response.status}: ${text} (client request ID: ${clientRequestId})`);
      }
      this.diagnostic("cu_request_completed", {
        ...details, ...responseDetails, elapsedMs: Date.now() - started,
      });
      return response;
    } catch (error) {
      const cause = record(record(error)?.cause);
      if (!reported) this.diagnostic("cu_request_failed", {
        ...details, ...responseDetails, stage, elapsedMs: Date.now() - started,
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: record(error)?.code, causeName: cause?.name, causeCode: cause?.code,
        causeAddress: cause?.address, causePort: cause?.port, causeSyscall: cause?.syscall,
        transportErrors: Array.isArray(cause?.errors) ? cause.errors.map((value) => {
          const nested = record(value);
          return { code: nested?.code, address: nested?.address, port: nested?.port, syscall: nested?.syscall };
        }) : undefined,
      });
      if (error instanceof LabError) throw error;
      const code = cause?.code ?? record(error)?.code;
      throw new LabError(502,
        `CU ${details.method} ${details.path} failed during ${stage}: ${error instanceof Error ? error.message : String(error)}` +
        `${code ? ` (${String(code)})` : ""}. Client request ID: ${clientRequestId}`);
    }
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
      if (["failed", "canceled"].includes(status.toLowerCase())) {
        this.diagnostic("cu_operation_failed", {
          operationPath: new URL(location, `${this.settings.endpoint}/`).pathname,
          operationStatus: status, serviceErrorCode: record(record(value)?.error)?.code,
        });
        throw new CuOperationError(
          `CU operation ${status}: ${JSON.stringify(record(value)?.error ?? {})}`,
          value,
        );
      }
      if (!["running", "notstarted"].includes(status.toLowerCase()))
        throw new LabError(502, `Unexpected CU status: ${status}`);
    }
    this.diagnostic("cu_operation_timeout", {
      operationPath: new URL(location, `${this.settings.endpoint}/`).pathname,
      timeoutMs: this.operationTimeoutMs,
    });
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
