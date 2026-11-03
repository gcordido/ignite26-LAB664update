import express, { type Request } from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  cacheFolders,
  configuration,
  dataRoot,
  LabError,
  record,
  repositoryRoot,
  root,
} from "./config.ts";
import { CuClient, CuOperationError } from "./cu.ts";
import { verifyAnalyzer } from "./definitions.ts";
import { DocumentService } from "./documents.ts";
import { packetJson } from "./packet-json.ts";
import { PolicyService, type PolicyJob } from "./policy-service.ts";
import { policyDemo } from "./policy-demo.ts";
import { checkNames, modeSchema } from "./policy-core.ts";
import { type PolicyChatState } from "./policy-chat.ts";
import { PolicyDocuments, representationSchema } from "./policy-documents.ts";
import {
  Cache,
  dataset,
  newRun,
  packetBytes,
  summarize,
  type Analyzer,
  type Packet,
  type Run,
} from "./batch.ts";

export function createApp(
  client: Pick<CuClient, "detail" | "analyze"> &
    Partial<Pick<CuClient, "list">> = new CuClient(),
  options: {
    cache?: Cache;
    policy?: PolicyService;
    documents?: PolicyDocuments;
  } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "20kb" }));
  app.get(["/", "/index.html"], (_req, res) =>
    res.sendFile("workbench.html", { root: path.join(root, "web") }),
  );
  app.get("/lab.html", (_req, res) =>
    res.sendFile("lab.html", {
      root: path.join(repositoryRoot, "instructions"),
    }),
  );
  for (const [folder, filename] of [
    ["docs", "policy-checks.md"],
    ["docs", "policy-setup.md"],
    ["infra", "README.md"],
    ["infra", "policy-framework-agent.py"],
    ["infra", "policy-agent-framework-setup.ipynb"],
  ]) {
    app.get(`/${folder}/${filename}`, (_req, res) =>
      res.sendFile(filename, { root: path.join(repositoryRoot, folder) }),
    );
  }
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
    "/vendor/deep-chat",
    express.static(path.join(root, "node_modules", "deep-chat", "dist"), {
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
  app.get("/vendor/marked.js", (_req, res) =>
    res.sendFile("marked.esm.js", {
      root: path.join(root, "node_modules", "marked", "lib"),
    }),
  );
  app.get("/vendor/purify.js", (_req, res) =>
    res.sendFile("purify.es.mjs", {
      root: path.join(root, "node_modules", "dompurify", "dist"),
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
    policyJob?: PolicyJob;
    bundledPolicy?: boolean;
    policyChats?: Map<string, PolicyChatState>;
    chatBusy?: boolean;
  };
  const sessions = new Map<string, Session>();
  const cache = options.cache ?? new Cache();
  const documents = new DocumentService(client, cache);
  const policy = options.policy ?? new PolicyService();
  const policyDocuments = options.documents ?? new PolicyDocuments();
  let batchActive = false;
  async function packetResult(run: Run, packet: Packet, selectedPolicy = policy) {
    const response = await cache.raw(run.id, packet.id);
    try {
      const review = summarize(response, packet, run.analyzer.mode);
      const report = await documents.review(run, packet, response);
      let exportValue: ReturnType<typeof packetJson> | null = null;
      let packetJsonError: string | undefined;
      let markdown: string | null = null;
      let claimSummaryPrepared = false;
      try {
        exportValue = packetJson(response, packet, run, review);
        markdown = await selectedPolicy.markdown(run, packet, response);
        claimSummaryPrepared = await selectedPolicy.summaryPrepared(packet);
      } catch (error) {
        packetJsonError =
          error instanceof Error ? error.message : String(error);
        console.error(
          JSON.stringify({
            event: "lab_packet_export_failed",
            packetId: packet.id,
            message: packetJsonError,
          }),
        );
      }
      return {
        packet,
        response,
        review,
        policies: report.policies,
        policyReview: report,
        packetJson: exportValue,
        packetMarkdown: markdown,
        claimSummaryPrepared,
        packetJsonError,
      };
    } catch (error) {
      if (!(error instanceof LabError) || error.status !== 422) throw error;
      console.error(
        JSON.stringify({
          event: "lab_cached_review_failed",
          packetId: packet.id,
          message: error.message,
        }),
      );
      return { packet, response, review: null, reviewError: error.message };
    }
  }
  function loadedPacket(s: Session, id: string) {
    const run = s.run;
    if (!run)
      throw new LabError(409, "Load cached results or run a live batch first.");
    const packet = run.source.find((packet) => packet.id === id);
    if (!packet || !run.items.some((item) => item.id === id && item.rawSaved))
      throw new LabError(404, "No saved CU result exists for this packet.");
    return { run, packet };
  }
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
      cache: { ...cacheFolders(), extraction: cache.folder },
    }),
  );
  app.post("/api/session", (req, res) => {
    const existingId = req.header("x-labmachine-session");
    const existing = existingId ? sessions.get(existingId) : undefined;
    if (existing) {
      existing.touched = Date.now();
      res.json({
        sessionId: existingId,
        runId: existing.run?.id,
        policyMode: existing.policyJob?.mode,
      });
      return;
    }
    for (const [id, value] of sessions)
      if (
        !value.busy &&
        !value.chatBusy &&
        Date.now() - value.touched > 60 * 60_000
      )
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
    if (s.busy || s.chatBusy)
      throw new LabError(409, "Wait for the current analysis or chat.");
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
  app.get("/api/policy/status", async (req, res) => {
    session(req);
    const [status, data, demo] = await Promise.all([
      policy.status(),
      dataset(),
      policyDemo(),
    ]);
    res.json({
      ...status,
      bundledDemo: {
        ...demo.info,
        staleDataset: demo.info.datasetHash !== data.datasetHash,
      },
    });
  });
  const documentSelection = z
    .object({
      file: z.string().max(180),
      mode: representationSchema,
    })
    .strict();
  app.get("/api/policy/document", async (req, res) => {
    session(req);
    const { file, mode } = documentSelection.parse(req.query);
    res.json(await policyDocuments.get(file, mode));
  });
  app.post("/api/policy/document", async (req, res) => {
    session(req);
    const { file, mode } = documentSelection
      .extend({ live: z.literal(true) })
      .parse(req.body);
    res.json(await policyDocuments.get(file, mode, true));
  });
  const chatSelection = z.object({
    mode: modeSchema,
    packetId: z.string().regex(/^packet-\d{2}$/),
    runId: z.string().uuid(),
    check: z.enum(checkNames),
  });
  app.get("/api/policy/claim-evidence", async (req, res) => {
    const s = session(req);
    const { runId, packetId } = chatSelection.pick({ runId: true, packetId: true }).parse(req.query);
    const { run, packet } = loadedPacket(s, packetId);
    if (run.id !== runId)
      throw new LabError(409, "The selected extraction run changed. Reload this case.");
    const selectedPolicy = s.bundledPolicy ? (await policyDemo()).service : policy;
    res.json(await selectedPolicy.claimEvidence(run, packet, await cache.raw(run.id, packet.id)));
  });
  async function chatContext(
    s: Session,
    mode: z.infer<typeof modeSchema>,
    packetId: string,
    check: typeof checkNames[number],
  ) {
    if (!s.run)
      throw new LabError(409, "Load Content Understanding results first.");
    const run = s.run;
    let selectedPolicy = policy;
    if (s.bundledPolicy && mode === "search") {
      const demo = await policyDemo();
      if (demo.results(run).staleDataset)
        throw new LabError(409, "The saved policy reviews do not match this extraction run. Load the matching saved results before chatting.");
      selectedPolicy = demo.service;
    }
    const context = await selectedPolicy.chatContext(run, mode, packetId, (id) =>
      cache.raw(run.id, id), check, policy,
    );
    s.policyChats ??= new Map();
    let state = s.policyChats.get(context.contextId);
    if (!state) {
      if (s.policyChats.size >= 100)
        throw new LabError(
          409,
          "Chat limit reached for this private session. Reload to start a new session.",
        );
      state = {
        contextId: context.contextId,
        busy: false,
        replies: [],
        messages: [
          { role: "user", content: context.prompt },
          { role: "assistant", content: JSON.stringify(context.result) },
        ],
      };
      s.policyChats.set(context.contextId, state);
    }
    return { context, state };
  }
  app.get("/api/policy/chat", async (req, res) => {
    const s = session(req);
    const { mode, packetId, runId, check } = chatSelection.parse(req.query);
    if (s.run?.id !== runId)
      throw new LabError(409, "The selected CU run changed. Reload this chat.");
    const { context, state } = await chatContext(s, mode, packetId, check);
    res.json({
      ...context,
      messages: state.messages,
      replies: state.replies,
      busy: state.busy,
    });
  });
  app.post("/api/policy/chat", async (req, res) => {
    const s = session(req);
    const { mode, packetId, runId, check, contextId, message } = chatSelection
      .extend({
        contextId: z.string().regex(/^[a-f0-9]{64}$/),
        message: z.string().trim().min(1).max(6000),
        live: z.literal(true),
      })
      .strict()
      .parse(req.body);
    if (s.busy || s.chatBusy)
      throw new LabError(409, "Wait for the current policy request.");
    if (s.run?.id !== runId)
      throw new LabError(409, "The selected CU run changed. Reload this chat.");
    s.chatBusy = true;
    try {
      const { context, state } = await chatContext(s, mode, packetId, check);
      if (context.contextId !== contextId)
        throw new LabError(
          409,
          "Claim, result or agent changed. Reload this chat.",
        );
      if (state.messages.length >= 42)
        throw new LabError(
          409,
          "This chat reached 20 follow-ups. Start a new private session to continue.",
        );
      state.busy = true;
      try {
        const reply = await policy.followup(
          mode,
          message,
          state.messages,
          context.agent,
        );
        state.messages.push(
          { role: "user", content: message },
          { role: "assistant", content: reply.text },
        );
        state.replies.push(reply);
        res.json(reply);
      } finally {
        state.busy = false;
      }
    } catch (error) {
      console.error(
        JSON.stringify({ event: "policy_chat_failed", message: String(error) }),
      );
      throw error;
    } finally {
      s.chatBusy = false;
    }
  });
  app.get("/api/policy/results", async (req, res) => {
    const s = session(req);
    if (!s.run)
      throw new LabError(409, "Load Content Understanding results first.");
    const mode = modeSchema.parse(req.query.mode);
    if (s.bundledPolicy && mode === "search") {
      res.json((await policyDemo()).results(s.run));
      return;
    }
    const readiness = await policy.status();
    if (!readiness.configured) {
      res.json({
        runId: s.run.id,
        mode,
        status: "completed",
        configurationMessage: readiness.message,
        items: s.run.items.map(({ id }) => ({ id, status: "not run" })),
      });
      return;
    }
    if (
      s.policyJob?.runId === s.run.id &&
      s.policyJob.mode === mode &&
      s.policyJob.status === "running"
    ) {
      res.json(s.policyJob);
      return;
    }
    const run = s.run;
    const items = await policy.snapshot(run, mode, (id) =>
      cache.raw(run.id, id),
    );
    if (s.policyJob?.runId === run.id && s.policyJob.mode === mode)
      for (const item of s.policyJob.items) {
        const index = items.findIndex((value) => value.id === item.id);
        if (index < 0) continue;
        if (item.status === "failed")
          items[index] = item;
        else if (
          item.inputHash === items[index].inputHash &&
          item.provider === items[index].provider &&
          item.indexName === items[index].indexName
        )
          items[index].cached = item.cached;
      }
    res.json({ runId: run.id, mode, status: "completed", items });
  });
  app.get("/api/policy/cache", async (req, res) => {
    const s = session(req);
    if (!s.run)
      throw new LabError(409, "Load Content Understanding results first.");
    const run = s.run;
    const readiness = await policy.status();
    const entries = readiness.configured ? await Promise.all(modeSchema.options.map(async (mode) => {
      const items = await policy.snapshot(run, mode, (id) => cache.raw(run.id, id));
      const completed = items.filter((item) => item.status === "completed");
      return {
        mode, count: completed.length, total: items.length,
        completedAt: completed.map((item) => item.completedAt ?? "").sort().at(-1),
        indexName: completed[0]?.indexName ?? null,
      };
    })) : [];
    const available: Array<(typeof entries)[number] & { source?: "bundled" }> =
      entries.filter((entry) => entry.count > 0);
    if (!available.some((entry) => entry.mode === "search")) {
      const demo = await policyDemo();
      const saved = demo.results(run);
      available.push({
        mode: "search", count: saved.items.length, total: saved.items.length,
        completedAt: saved.items.map((item) => item.completedAt ?? "").sort().at(-1),
        indexName: demo.info.indexName, source: "bundled",
      });
    }
    res.json({ runId: run.id, entries: available,
      ...(!readiness.configured && !available.length ? { message: readiness.message } : {}) });
  });
  app.post("/api/policy/cache/load", async (req, res) => {
    const s = session(req);
    const { runId, mode, source } = z.object({
      runId: z.string().uuid(), mode: modeSchema,
      source: z.literal("bundled").optional(),
    }).strict().parse(req.body);
    if (!s.run || s.run.id !== runId)
      throw new LabError(409, "The selected CU run changed. Refresh saved policy results.");
    if (s.busy || s.chatBusy || s.policyJob?.status === "running")
      throw new LabError(409, "Wait for the current analysis, policy review or chat.");
    const run = s.run;
    if (source === "bundled") {
      if (mode !== "search")
        throw new LabError(404, "The bundled demo includes Search-backed checks only.");
      const saved = (await policyDemo()).results(run);
      s.bundledPolicy = true;
      s.policyChats = undefined;
      res.json(saved);
      return;
    }
    const items = await policy.snapshot(run, mode, (id) => cache.raw(run.id, id));
    if (!items.some((item) => item.status === "completed"))
      throw new LabError(404, "No compatible saved policy results. Run policy checks first.");
    s.bundledPolicy = false;
    res.json({ runId: run.id, mode, status: "completed", items, cached: true,
      cacheFolder: policy.cacheFolder });
  });
  app.post("/api/policy/batch", async (req, res) => {
    const s = session(req);
    const { mode, packetIds } = z
      .object({ mode: modeSchema, live: z.literal(true),
        packetIds: z.array(z.string().regex(/^packet-\d{2}$/)).min(1).max(10).optional() })
      .parse(req.body);
    if (!s.run)
      throw new LabError(409, "Load Content Understanding results first.");
    if (
      s.policyJob?.status === "running" &&
      s.policyJob.runId === s.run.id &&
      s.policyJob.mode === mode
    ) {
      const requested = (packetIds ?? s.run.items.map(({ id }) => id)).toSorted();
      const running = s.policyJob.items.map(({ id }) => id).toSorted();
      if (requested.length !== running.length ||
          requested.some((id, index) => id !== running[index]))
        throw new LabError(409, "A policy review with a different packet selection is already running.");
      res.status(202).json(s.policyJob);
      return;
    }
    if (s.busy || s.chatBusy)
      throw new LabError(409, "Wait for the current batch or chat.");
    s.busy = true;
    const run = s.run;
    try {
      const { job, task } = await policy.start(run, mode, (id) =>
        cache.raw(run.id, id), packetIds);
      s.bundledPolicy = false;
      s.policyJob = job;
      void task
        .catch((error) => {
          console.error(
            JSON.stringify({
              event: "policy_batch_failed",
              message: String(error),
            }),
          );
          job.status = "completed";
          for (const item of job.items)
            if (!["completed", "failed"].includes(item.status)) {
              item.status = "failed";
              item.error = "Policy batch stopped. Check the server error log.";
            }
        })
        .finally(() => {
          s.busy = false;
        });
      res.status(202).json(job);
    } catch (error) {
      s.busy = false;
      throw error;
    }
  });
  async function hydratedRun(s: Session, run: Run) {
    const data = await dataset();
    const packetResults = await Promise.all(
      run.items
        .filter((item) => item.rawSaved)
        .map(async (item) => {
          const packet = run.source.find((packet) => packet.id === item.id);
          if (!packet)
            throw new LabError(
              422,
              "A cached packet is missing its source metadata.",
            );
          return packetResult(run, packet,
            s.bundledPolicy ? (await policyDemo()).service : policy);
        }),
    );
    const readiness = await policy.status();
    const agentReviews = Object.fromEntries(
      await Promise.all(
        modeSchema.options.map(async (mode) => [
          mode,
          s.bundledPolicy && mode === "search"
            ? (await policyDemo()).results(run)
            : s.policyJob?.runId === run.id &&
          s.policyJob.mode === mode &&
          s.policyJob.status === "running"
            ? s.policyJob
            : {
                runId: run.id,
                mode,
                status: "completed",
                items: readiness.configured
                  ? await policy.snapshot(run, mode, (id) =>
                      cache.raw(run.id, id),
                    )
                  : run.items.map(({ id }) => ({ id, status: "not run" })),
                ...(!readiness.configured
                  ? { configurationMessage: readiness.message }
                  : {}),
              },
        ]),
      ),
    );
    return {
      ...run,
      packetResults,
      agentReviews,
      origin: "Cached CU JSON",
      sourceEndpoint: run.endpoint,
      currentDatasetMatches: data.datasetHash === run.datasetHash,
      currentAnalyzerMatches: s.analyzer
        ? s.analyzer.fingerprint === run.analyzer.fingerprint
        : null,
      warning:
        "Saved historical responses, not a fresh analysis. No Azure call was made.",
    };
  }
  app.get("/api/cache/current", async (req, res) => {
    const s = session(req);
    if (!s.run)
      throw new LabError(409, "Load Content Understanding results first.");
    res.json(await hydratedRun(s, s.run));
  });
  app.post("/api/cache/load", async (req, res) => {
    const s = session(req);
    if (s.busy || s.chatBusy)
      throw new LabError(409, "Wait for the current analysis or chat.");
    const { runId } = z.object({ runId: z.string().uuid() }).parse(req.body);
    const run = await cache.load(runId);
    if (s.run?.id !== run.id) s.bundledPolicy = false;
    const hydrated = await hydratedRun(s, run);
    s.run = run;
    res.json(hydrated);
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
    res.json(await packetResult(s.run, packet,
      s.bundledPolicy ? (await policyDemo()).service : policy));
  });
  app.get("/api/review/:packetId", async (req, res) => {
    const { run, packet } = loadedPacket(
      session(req),
      String(req.params.packetId),
    );
    const report = await documents.review(run, packet);
    res.json(report);
  });
  app.post("/api/document/:packetId", async (req, res) => {
    const s = session(req);
    const { run, packet } = loadedPacket(s, String(req.params.packetId));
    const body = z
      .object({
        live: z.literal(true),
        sourceId: z.string().max(40),
        analyzerId: z
          .string()
          .regex(/^[A-Za-z0-9_.-]{3,128}$/)
          .optional(),
      })
      .strict()
      .parse(req.body);
    if (batchActive || s.busy || s.chatBusy)
      throw new LabError(
        409,
        "Wait for the current analysis before submitting another document.",
      );
    batchActive = true;
    s.busy = true;
    try {
      const review = await documents.review(run, packet);
      const original = review.documents.find(
        (doc) => doc.sourceId === body.sourceId,
      );
      const category = original?.category;
      const analyzerId = body.analyzerId ?? original?.analyzerId;
      if (!category || !analyzerId)
        throw new LabError(
          422,
          "Select an existing extracted document and its analyzer.",
        );
      const preview = await documents.analyze(
        run,
        packet,
        body.sourceId,
        category,
        analyzerId,
      );
      res.json({ preview });
    } finally {
      s.busy = false;
      batchActive = false;
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
    z.object({ live: z.literal(true) })
      .strict()
      .parse(req.body);
    if (!s.analyzer)
      throw new LabError(409, "Connect an existing Studio analyzer first.");
    if (batchActive || s.busy || s.chatBusy)
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
      s.bundledPolicy = false;
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
              await documents.review(run, packet, response);
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
