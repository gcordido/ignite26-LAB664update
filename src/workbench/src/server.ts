import express, { type Request } from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  configuration,
  dataRoot,
  LabError,
  record,
  repositoryRoot,
  root,
} from "./config.ts";
import { CuClient, CuOperationError } from "./cu.ts";
import { verifyAnalyzer } from "./definitions.ts";
import {
  Cache,
  dataset,
  newRun,
  packetBytes,
  summarize,
  type Analyzer,
  type Run,
} from "./batch.ts";

export function createApp(
  client: Pick<CuClient, "detail" | "analyze"> &
    Partial<Pick<CuClient, "list">> = new CuClient(),
  options: { cache?: Cache } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "20kb" }));
  app.get(["/", "/index.html"], (_req, res) =>
    res.sendFile(path.join(root, "web", "workbench.html")),
  );
  app.get("/lab.html", (_req, res) =>
    res.sendFile(path.join(repositoryRoot, "instructions", "lab.html")),
  );
  app.use(
    "/data",
    express.static(dataRoot, { dotfiles: "deny", index: false }),
  );
  app.use(
    "/web",
    express.static(path.join(root, "web"), {
      dotfiles: "deny",
      index: false,
    }),
  );
  app.use(
    "/vendor/pdfjs",
    express.static(path.join(root, "node_modules", "pdfjs-dist", "build"), {
      dotfiles: "deny",
      index: false,
    }),
  );
  app.use(
    "/vendor/pdfjs-fonts",
    express.static(
      path.join(root, "node_modules", "pdfjs-dist", "standard_fonts"),
      {
        dotfiles: "deny",
        index: false,
      },
    ),
  );
  type Session = {
    touched: number;
    analyzer?: Analyzer;
    run?: Run;
    busy: boolean;
    error?: string;
  };
  const sessions = new Map<string, Session>();
  const cache = options.cache ?? new Cache();
  let batchActive = false;
  function session(req: Request) {
    const id = req.header("x-labmachine-session");
    const value = id ? sessions.get(id) : undefined;
    if (!value)
      throw new LabError(
        401,
        "Reload the workbench to start a private lab session.",
      );
    value.touched = Date.now();
    return value;
  }
  app.get("/api/status", (_req, res) =>
    res.json({
      apiVersion: configuration().apiVersion,
      endpointConfigured: Boolean(configuration().endpoint),
      noClaimDecisions: true,
      endpoint: configuration().endpoint,
    }),
  );
  app.post("/api/session", (_req, res) => {
    for (const [id, value] of sessions)
      if (!value.busy && Date.now() - value.touched > 60 * 60_000)
        sessions.delete(id);
    if (sessions.size >= 20)
      throw new LabError(
        503,
        "Session limit reached; allow idle sessions to expire.",
      );
    const id = randomUUID();
    sessions.set(id, { touched: Date.now(), busy: false });
    res.status(201).json({ sessionId: id });
  });
  app.get("/api/analyzers", async (req, res) => {
    session(req);
    if (!client.list)
      throw new LabError(503, "Analyzer listing is unavailable.");
    const analyzers = await client.list();
    res.json(
      analyzers.map((analyzer) => {
        const config = record(analyzer.config);
        return {
          id: String(analyzer.analyzerId),
          name:
            typeof analyzer.name === "string"
              ? analyzer.name
              : String(analyzer.analyzerId),
          status: analyzer.status,
          compatible:
            analyzer.status === "ready" &&
            config?.enableSegment === true &&
            config.segmentPerPage !== true &&
            config.allowInPageSegments !== true &&
            config.omitContent !== true &&
            Boolean(record(config.contentCategories)),
        };
      }),
    );
  });
  app.post("/api/connect", async (req, res) => {
    const s = session(req);
    if (s.busy) throw new LabError(409, "Wait for current analysis.");
    const { analyzerId } = z
      .object({
        analyzerId: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/),
      })
      .parse(req.body);
    const verified = await verifyAnalyzer(client, analyzerId);
    s.analyzer = verified;
    s.error = undefined;
    res.json(verified);
  });
  app.get("/api/packets", async (req, res) => {
    session(req);
    res.json(await dataset());
  });
  app.get("/api/cache", async (req, res) => {
    session(req);
    res.json(await cache.list());
  });
  app.post("/api/cache/load", async (req, res) => {
    const s = session(req);
    if (s.busy) throw new LabError(409, "Wait for the current analysis.");
    const { runId } = z.object({ runId: z.string().uuid() }).parse(req.body);
    const run = await cache.load(runId);
    const data = await dataset();
    s.run = run;
    res.json({
      ...run,
      origin: "Cached CU JSON",
      sourceEndpoint: run.endpoint,
      currentDatasetMatches: data.datasetHash === run.datasetHash,
      currentAnalyzerMatches: s.analyzer
        ? s.analyzer.fingerprint === run.analyzer.fingerprint
        : null,
      warning:
        "Saved historical responses, not a fresh analysis. No Azure call was made.",
    });
  });
  app.get("/api/packet/:packetId", async (req, res) => {
    const s = session(req);
    if (!s.run)
      throw new LabError(
        409,
        "Start a live batch or explicitly load a cache first.",
      );
    const packetId = String(req.params.packetId);
    const item = s.run.items.find((item) => item.id === packetId);
    const packet = s.run.source.find((packet) => packet.id === packetId);
    if (!packet || !item?.rawSaved)
      throw new LabError(
        404,
        "No saved CU JSON exists for that packet in this run.",
      );
    const response = await cache.raw(s.run.id, packetId);
    try {
      res.json({
        packet,
        response,
        review: summarize(response, packet, s.run.analyzer.mode),
      });
    } catch (error) {
      if (!(error instanceof LabError) || error.status !== 422) throw error;
      console.error(
        JSON.stringify({
          event: "lab_cached_review_failed",
          packetId,
          message: error.message,
        }),
      );
      res.json({ packet, response, review: null, reviewError: error.message });
    }
  });
  app.get("/api/raw/:packetId", async (req, res) => {
    const s = session(req);
    if (
      !s.run ||
      !s.run.items.some(
        (item) => item.id === req.params.packetId && item.rawSaved,
      )
    )
      throw new LabError(
        404,
        "No raw JSON exists for that packet in the selected run.",
      );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${req.params.packetId}.cu.json"`,
    );
    res.json(await cache.raw(s.run.id, String(req.params.packetId)));
  });
  app.post("/api/batch", async (req, res) => {
    const s = session(req);
    z.object({ live: z.literal(true) }).parse(req.body);
    if (!s.analyzer)
      throw new LabError(409, "Connect an existing Studio analyzer first.");
    if (batchActive || s.busy)
      throw new LabError(
        409,
        "A live analysis is already running. Parallel batches are disabled to prevent double charges.",
      );
    // Reserve the resource before awaiting readiness or filesystem work.
    batchActive = true;
    s.busy = true;
    try {
      const current = await verifyAnalyzer(client, s.analyzer.id);
      if (current.fingerprint !== s.analyzer.fingerprint)
        throw new LabError(
          409,
          "Analyzer definition changed; reconnect before starting another billable batch.",
        );
      s.run = await newRun(current);
      await cache.save(s.run);
    } catch (error) {
      batchActive = false;
      s.busy = false;
      throw error;
    }
    const run = s.run;
    s.error = undefined;
    void (async () => {
      let next = 0;
      let failed = false;
      let firstError: unknown;
      let writes = Promise.resolve();
      const save = () => {
        const pending = writes.then(() => cache.save(run));
        writes = pending;
        return pending;
      };
      const workers = await Promise.allSettled(
        Array.from({ length: Math.min(5, run.items.length) }, async () => {
          while (!failed && next < run.items.length) {
            const item = run.items[next++];
            item.status = "running";
            item.startedAt = new Date().toISOString();
            try {
              await save();
              const packet = run.source.find(
                (packet) => packet.id === item.id,
              )!;
              const response = await client.analyze(
                run.analyzer.id,
                await packetBytes(packet),
              );
              await cache.raw(run.id, item.id, response);
              item.rawSaved = true;
              // Cache native evidence before deriving or displaying any result.
              summarize(response, packet, run.analyzer.mode);
              item.status = "completed";
              item.completedAt = new Date().toISOString();
              await save();
            } catch (error) {
              if (!failed) firstError = error;
              failed = true;
              item.status = "failed";
              item.error =
                error instanceof Error ? error.message : String(error);
              item.completedAt = new Date().toISOString();
              if (error instanceof CuOperationError && !item.rawSaved) {
                await cache.raw(run.id, item.id, error.response);
                item.rawSaved = true;
              }
              await save();
            }
          }
        }),
      );
      const rejected = workers.find((worker) => worker.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      if (failed) throw firstError;
      run.status = "completed";
    })()
      .catch((error: unknown) => {
        run.status = "failed";
        for (const item of run.items)
          if (item.status === "running") {
            item.status = "failed";
            item.completedAt = new Date().toISOString();
            item.error = error instanceof Error ? error.message : String(error);
          }
        for (const item of run.items)
          if (item.status === "pending") item.status = "not processed";
        s.error = error instanceof Error ? error.message : String(error);
        console.error(
          JSON.stringify({
            event: "lab_batch_failed",
            runId: run.id,
            message: s.error,
          }),
        );
      })
      .finally(async () => {
        run.completedAt = new Date().toISOString();
        try {
          await cache.save(run);
        } catch (error) {
          run.status = "failed";
          s.error = `Cache manifest persistence failed: ${error instanceof Error ? error.message : String(error)}`;
          console.error(
            JSON.stringify({ event: "lab_cache_failed", message: s.error }),
          );
        } finally {
          s.busy = false;
          batchActive = false;
        }
      });
    res.status(202).json(run);
  });
  app.get("/api/batch", (req, res) => {
    const s = session(req);
    res.json({ run: s.run ?? null, busy: s.busy, error: s.error ?? null });
  });
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        error instanceof LabError
          ? error.status
          : error instanceof z.ZodError
            ? 400
            : 500;
      const message =
        error instanceof z.ZodError
          ? "Invalid lab request."
          : error instanceof Error
            ? error.message
            : String(error);
      console.error(
        JSON.stringify({ event: "lab_request_failed", status, message }),
      );
      res.status(status).json({ error: message });
    },
  );
  return app;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  const settings = configuration();
  const server = createApp().listen(settings.port, "127.0.0.1", () =>
    console.log(`Insurance Workbench App: http://127.0.0.1:${settings.port}`),
  );
  server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => server.close(() => process.exit(0)));
}
