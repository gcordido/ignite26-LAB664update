import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import {
  PolicyService,
  frameworkReview,
  parseFrameworkResult,
  type FrameworkConfig,
} from "./policy-service.ts";
import {
  canonical,
  checkNames,
  digest,
  modeSchema,
  policyClaimAnalysis,
  policyClaimFacts,
  question,
  resolveCitations,
  withClaimSummary,
} from "./policy-core.ts";
import { repositoryRoot } from "./config.ts";
import { Cache, summarize } from "./batch.ts";
import { packetJson } from "./packet-json.ts";
import { packetMarkdown } from "./packet-markdown.ts";
import { createApp } from "./server.ts";
import { savePolicyCache } from "./policy-service.ts";
import { chatMessageHtml, resultChatText } from "../web/policy-chat.js";

const base = path.join(
  repositoryRoot,
  "data",
  "policies",
  "rental",
  "ocr-comparison-v2",
);
async function includedRunId(cache: Cache) {
  const run = (await cache.list()).find(
    (entry) => entry.status === "completed",
  );
  assert.ok(run, "An included completed CU run is required");
  return run.id;
}
async function config(): Promise<FrameworkConfig> {
  return {
    schemaVersion: 1,
    provider: "agent-framework",
    azureOpenAIEndpoint: "https://example.services.ai.azure.com",
    modelDeployment: "same-model",
    searchEndpoint: "https://example.search.windows.net",
    indexName: "test-rental-index",
    corpusHash: digest(await readFile(path.join(base, "manifest.json"))),
    indexFingerprint: "a".repeat(64),
    extractionMode: "layout",
    cuEndpoint: "https://example.services.ai.azure.com",
    cuApiVersion: "2025-11-01",
    claimAnalyzerId: "claim-summary",
    claimAnalyzerHash: "b".repeat(64),
  };
}
function result(mode: "ungrounded" | "search", value: FrameworkConfig) {
  const citation = {
    File: "tx-rental-review-sop-v2.pdf",
    DocumentId: "TX-RENTAL-002",
    Version: "2.0",
    RuleId: "TX-R2",
    Section: "3. Rate, duration and charge schedules",
  };
  return {
    provider: "agent-framework",
    status: "completed",
    mode,
    retrievalCalls: mode === "search" ? 1 : 0,
    retrieved:
      mode === "search"
        ? [
            {
              id: "tx-schedule",
              content: "Synthetic test evidence",
              file: citation.File,
              documentId: citation.DocumentId,
              version: "2.0",
              citationSections: [citation.Section],
              ruleIds: ["TX-R2"],
              sha256: "c".repeat(64),
              corpusHash: value.corpusHash,
              indexFingerprint: value.indexFingerprint,
            },
          ]
        : [],
    checkPrompts: Object.fromEntries(checkNames.map(name => [name, `Question for ${name}\nSelected CU fields`])),
    result: {
      Checks: checkNames.map((Check, index) => ({
        Check,
        Outcome:
          mode === "search" && index === 1 ? "Satisfied" : "ReviewRequired",
        ReviewRequired: !(mode === "search" && index === 1),
        ExpectedValue:
          mode === "search"
            ? "Retrieve and apply the state rule"
            : "State SOP not established",
        ActualValue: "$54/day",
        Reason:
          mode === "search" ? "Test evidence" : "No policy retrieval available",
        Citation: mode === "search" && index === 1 ? [citation] : [],
      })),
    },
  };
}

test("Framework output enforces honest no-retrieval and real per-turn indexed citation evidence", async () => {
  const value = await config();
  const baseline = result("ungrounded", value);
  const review = await frameworkReview(baseline, "ungrounded", value);
  assert.ok(
    review.result.Checks.every(
      (check) => check.ReviewRequired && !check.Citation.length,
    ),
  );
  const grounded = result("search", value);
  const checked = await frameworkReview(grounded, "search", value);
  assert.equal(
    checked.citations[1][0].href,
    "/data/policies/rental/ocr-comparison-v2/tx-rental-review-sop-v2.pdf#page=3",
  );
  assert.throws(
    () => parseFrameworkResult(grounded, "ungrounded", value),
    /mode\/evidence mismatch/,
  );
  grounded.retrieved[0].indexFingerprint = "d".repeat(64);
  await assert.rejects(
    frameworkReview(grounded, "search", value),
    /different corpus/,
  );
  const fabricated = result("search", value);
  fabricated.result.Checks[1].Citation[0].RuleId = "TX-R5";
  await assert.rejects(
    frameworkReview(fabricated, "search", value),
    /not retrieved/,
  );
  const noTool = { ...result("search", value), retrievalCalls: 0 };
  await assert.rejects(
    frameworkReview(noTool, "search", value),
    /mode\/evidence mismatch/,
  );
  const notApplicable = result("search", value);
  notApplicable.result.Checks[1].Outcome = "NotApplicable";
  assert.equal(
    (await frameworkReview(notApplicable, "search", value)).result.Checks[1]
      .Outcome,
    "NotApplicable",
  );
  const waiting = result("search", value);
  waiting.result.Checks[1].Outcome = "InProgress";
  waiting.result.Checks[1].ReviewRequired = false;
  assert.equal((await frameworkReview(waiting, "search", value)).result.Checks[1].Outcome, "InProgress");
  assert.match(resultChatText(waiting.result), /Waiting for info/);
  waiting.result.Checks[1].ReviewRequired = true;
  await assert.rejects(frameworkReview(waiting, "search", value), /Inconsistent/);
  baseline.result.Checks[0].Outcome = "Satisfied";
  baseline.result.Checks[0].ReviewRequired = false;
  await assert.rejects(frameworkReview(baseline, "ungrounded", value));
});

test("compact findings retain comparisons and reject unsupported policy-rule pointers", async () => {
  const value = await config();
  const raw = result("search", value);
  const compact = {
    ...raw,
    result: {
      Checks: raw.result.Checks.map((check) => ({
        ...check,
        Headline: "Daily price needs a policy check",
        Comparisons: [{
          ClaimField: "RentalDailyBaseRate",
          ClaimLabel: "Daily rental price",
          ClaimValue: "$54/day",
          PolicyField: check.Citation[0]?.RuleId ?? "Not retrieved",
          PolicyLabel: "Daily rental limit",
          PolicyValue: check.Citation.length ? "$75/day" : "Not established",
        }],
      })),
    },
  };
  const parsed = await frameworkReview(compact, "search", value);
  assert.equal(parsed.result.Checks[1].Headline, "Daily price needs a policy check");
  assert.equal(parsed.result.Checks[1].Comparisons?.[0].ClaimField, "RentalDailyBaseRate");
  compact.result.Checks[1].Comparisons[0].PolicyField = "invented-rule";
  await assert.rejects(frameworkReview(compact, "search", value), /uncited policy rule/);
  compact.result.Checks[1].Comparisons[0].PolicyField = "TX-R2";
  compact.result.Checks[1].Headline = "x".repeat(101);
  await assert.rejects(frameworkReview(compact, "search", value));
});

test("Framework modes share prepared claim inputs but isolate review caches, chat and failures", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "framework-policy-"));
  try {
    const value = await config();
    const cache = new Cache();
    const run = await cache.load(await includedRunId(cache));
    run.items = run.items.filter((item) => item.id === "packet-01");
    run.source = run.source.filter((item) => item.id === "packet-01");
    const packet = run.source[0];
    const claimKey = digest(
      JSON.stringify({
        pdf: packet.sha256,
        endpoint: value.cuEndpoint,
        apiVersion: value.cuApiVersion,
        analyzer: value.claimAnalyzerId,
        definition: value.claimAnalyzerHash,
        schema: 1,
      }),
    );
    await savePolicyCache(path.join(folder, `claim-${claimKey}.json`), {
      analyzerFingerprint: value.claimAnalyzerHash,
      response: {
        status: "Succeeded",
        result: {
          contents: [
            {
              path: "input1",
              fields: {
                Routing: {
                  type: "object",
                  valueObject: {
                    LossState: { type: "string", valueString: "TX" },
                  },
                },
              },
            },
          ],
        },
      },
    });
    const requests: {
      mode: "ungrounded" | "search";
      prompt: string;
      chat?: boolean;
      lossState: string;
      claimAnalysis?: ReturnType<typeof policyClaimAnalysis>;
      reviewStrategy?: string;
      modelDeployment?: string;
      reasoningEffort?: string;
    }[] = [];
    const service = new PolicyService({
      config: async () => value,
      cacheFolder: folder,
      cu: {
        detail: async () => {
          throw new Error("Must reuse claim extraction");
        },
        analyze: async () => {
          throw new Error("No extraction expected");
        },
      },
      invoke: async (input) => {
        const req = input as (typeof requests)[number];
        requests.push(req);
        if (req.chat)
          return {
            ...result(req.mode, value),
            result: { Answer: "No rules established", Citation: [] },
          };
        return result(req.mode, value);
      },
    });
    assert.deepEqual(Object.keys((await service.status()).modes ?? {}), [
      "ungrounded",
      "search",
    ]);
    const readRaw = (id: string) => cache.raw(run.id, id);
    const noRules = await service.start(run, "ungrounded", readRaw);
    await noRules.task;
    assert.equal(noRules.job.items[0].status, "completed");
    assert.equal(requests[0].lossState, "TX");
    const raw = await readRaw(packet.id);
    const exported = packetJson(raw, packet, run, summarize(raw, packet, run.analyzer.mode));
    assert.ok(!requests[0].prompt.includes(exported.extracted_text!));
    assert.ok(!requests[0].prompt.includes("## Customer"));
    assert.equal(requests[0].reviewStrategy, "parallel");
    assert.ok(requests[0].claimAnalysis?.contents.length);
    assert.ok(!JSON.stringify(requests[0].claimAnalysis).includes(exported.extracted_text!));
    const withRules = await service.start(run, "search", readRaw);
    await withRules.task;
    assert.equal(withRules.job.items[0].status, "completed");
    assert.equal(requests[0].prompt, requests[1].prompt);
    const again = await service.start(run, "ungrounded", readRaw);
    await again.task;
    assert.equal(requests.length, 2);
    assert.equal(again.job.items[0].cached, true);
    const snapshots = await service.snapshot(run, "search", readRaw);
    assert.equal(
      snapshots[0].citations?.[1][0].href?.includes("ocr-comparison-v2"),
      true,
    );
    const context = await service.chatContext(
      run,
      "ungrounded",
      "packet-01",
      readRaw,
    );
    const savedNames = (await readdir(folder)).filter(name => name.startsWith("framework-saved-"));
    assert.equal(savedNames.length, 2);
    const savedSearch = await Promise.all(savedNames.map(async name => ({
      name, value: JSON.parse(await readFile(path.join(folder, name), "utf8")),
    })));
    const archive = savedSearch.find(({ value }) => value.raw.mode === "search")!;
    const originalReviewKey = archive.value.reviewKey;
    await savePolicyCache(path.join(folder, archive.name), { ...archive.value, reviewKey: "0".repeat(64) });
    const exactFile = path.join(folder, `framework-review-${originalReviewKey}.json`);
    await rename(exactFile, `${exactFile}.bak`);
    const reloaded = new PolicyService({ config: async () => value, cacheFolder: folder,
      invoke: async () => { throw new Error("Cache loading must not invoke Azure"); } });
    const historical = await reloaded.snapshot(run, "search", readRaw);
    assert.equal(historical[0].status, "completed");
    assert.equal(historical[0].historical, true);
    assert.deepEqual(historical[0].result, withRules.job.items[0].result);
    const oldChat = await reloaded.chatContext(run, "search", packet.id, readRaw);
    assert.deepEqual(oldChat.result.Checks, [historical[0].result!.Checks[0]]);
    assert.equal(oldChat.promptSource, "saved");
    const timingChat = await reloaded.chatContext(run, "search", packet.id, readRaw, "Rental start");
    assert.deepEqual(timingChat.result.Checks, [historical[0].result!.Checks[1]]);
    assert.notEqual(timingChat.contextId, oldChat.contextId);
    assert.equal(timingChat.prompt, "Question for Rental start\nSelected CU fields");
    assert.deepEqual(timingChat.citations, [historical[0].citations![1]]);
    await savePolicyCache(path.join(folder, archive.name), { ...archive.value, inputHash: "0".repeat(64) });
    assert.equal((await reloaded.snapshot(run, "search", readRaw))[0].status, "not run");
    await savePolicyCache(path.join(folder, archive.name), archive.value);
    await rename(`${exactFile}.bak`, exactFile);
    const reply = await service.followup(
      "ungrounded",
      "What is missing?",
      [],
      context.agent,
    );
    assert.equal(reply.text, "No rules established");
    const previousModel = process.env.POLICY_CHAT_MODEL_DEPLOYMENT;
    const previousEffort = process.env.POLICY_CHAT_REASONING_EFFORT;
    try {
      process.env.POLICY_CHAT_MODEL_DEPLOYMENT = "gpt-4.1-mini";
      delete process.env.POLICY_CHAT_REASONING_EFFORT;
      const fasterChat = await service.chatContext(run, "ungrounded", packet.id, readRaw, "Rental start");
      assert.equal(fasterChat.agent.modelDeployment, "gpt-4.1-mini");
      assert.equal(fasterChat.agent.reasoningEffort, undefined);
      assert.notEqual(fasterChat.contextId, context.contextId);
      await service.followup("ungrounded", "What dates are missing?", [], fasterChat.agent);
      assert.equal(requests.at(-1)?.modelDeployment, "gpt-4.1-mini");
      assert.equal((await service.snapshot(run, "ungrounded", readRaw))[0].historical, false);
      await assert.rejects(service.followup("ungrounded", "Old context", [], context.agent), /settings changed/);
    } finally {
      if (previousModel === undefined) delete process.env.POLICY_CHAT_MODEL_DEPLOYMENT;
      else process.env.POLICY_CHAT_MODEL_DEPLOYMENT = previousModel;
      if (previousEffort === undefined) delete process.env.POLICY_CHAT_REASONING_EFFORT;
      else process.env.POLICY_CHAT_REASONING_EFFORT = previousEffort;
    }
    await assert.rejects(
      service.followup("search", "wrong mode", [], context.agent),
      /configuration changed/,
    );
    const changed = new PolicyService({
      config: async () => ({ ...value, indexFingerprint: "e".repeat(64) }),
      cacheFolder: folder,
      invoke: async () => {
        throw new Error("Search 403");
      },
    });
    const failed = await changed.start(run, "search", readRaw);
    await failed.task;
    assert.equal(failed.job.items[0].status, "failed");
    assert.match(failed.job.items[0].error ?? "", /Search 403/);
    const failedSnapshot = (await changed.snapshot(run, "search", readRaw))[0];
    assert.equal(failedSnapshot.status, "failed");
    assert.match(failedSnapshot.error ?? "", /Search 403/);
    const files = await readdir(folder);
    assert.equal(
      files.filter((file) => file.startsWith("framework-review")).length,
      2,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("policy claim facts preserve extracted values without OCR, prose or source metadata", async () => {
  const cache = new Cache();
  const run = await cache.load(await includedRunId(cache));
  const packet = run.source[0];
  const raw = await cache.raw(run.id, packet.id);
  const exported = packetJson(raw, packet, run, summarize(raw, packet, run.analyzer.mode));
  const summary = {
    status: "Succeeded",
    result: { contents: [{ path: "input1", fields: {
      RentalRequested: { type: "boolean", valueBoolean: false },
      PriorDays: { type: "number", valueNumber: 0 },
      ActualRepairDeliveryDate: { type: "string" },
    } }] },
  };
  const enriched = withClaimSummary(exported, summary);
  const analysis = policyClaimAnalysis(enriched, raw, summary);
  assert.deepEqual(analysis.contents.at(-1), {
    kind: "document", category: "claim_summary",
    contentPath: "input1", pages: { start: 1, end: packet.pages },
    fields: {
      RentalRequested: { type: "boolean", valueBoolean: false },
      PriorDays: { type: "number", valueNumber: 0 },
      ActualRepairDeliveryDate: { type: "string" },
    },
  });
  assert.ok(!JSON.stringify(analysis).includes('"markdown"'));
  assert.ok(!JSON.stringify(analysis).includes('"source"'));
  assert.ok(!JSON.stringify(analysis).includes('"confidence"'));
  assert.ok(!JSON.stringify(analysis).includes(exported.extracted_text!));
  const facts = policyClaimFacts(enriched);
  const parsed = JSON.parse(facts);
  assert.deepEqual(parsed.documents.at(-1), {
    category: "claim_summary",
    fields: { RentalRequested: false, PriorDays: 0, ActualRepairDeliveryDate: null },
  });
  assert.deepEqual(parsed.documents.flatMap((doc: { fields: unknown }) => [doc.fields]),
    enriched.documents.flatMap((doc) => doc.extractions.map((entry) => entry.fields)));
  assert.ok(!facts.includes(exported.extracted_text!));
  assert.ok(!facts.includes('"extracted_text"'));
  assert.ok(!facts.includes('"regions"'));
  assert.ok(facts.length < packetMarkdown(enriched).length);
});

test("NotApplicable stays distinct in chat and v2 citations remain clickable", () => {
  assert.match(
    chatMessageHtml("Rule", [
      {
        DocumentId: "TX-RENTAL-002",
        RuleId: "TX-R2",
        Section: "Schedule",
        href: "/data/policies/rental/ocr-comparison-v2/tx-rental-review-sop-v2.pdf#page=3",
      },
    ]),
    /<a href=/,
  );
  assert.match(
    resultChatText({
      Checks: [
        {
          Check: "Daily rate",
          Outcome: "NotApplicable",
          ReviewRequired: false,
          ExpectedValue: "No rental request",
          ActualValue: "Confirmed no request",
          Reason: "Not payment approval",
        },
      ],
    }),
    /Not applicable/,
  );
});

test("one question and two retrieval modes reject legacy or malformed contracts", async () => {
  const prompt = await question();
  assert.match(prompt, /ExpectedValue/);
  assert.match(prompt, /ActualValue/);
  assert.ok(!prompt.includes("## Required output shape"));
  for (const mode of ["existing", "standard", "minimal", "invented"])
    assert.equal(modeSchema.safeParse(mode).success, false);
  const value = await config();
  const mutations: ((
    checks: ReturnType<typeof result>["result"]["Checks"],
  ) => unknown)[] = [
    (checks) => checks.slice(0, -1),
    (checks) => [...checks].reverse(),
    (checks) => [{ ...checks[0], ReviewRequired: "true" }, ...checks.slice(1)],
    (checks) => [{ ...checks[0], ExpectedValue: "" }, ...checks.slice(1)],
    (checks) => [{ ...checks[0], ActualValue: " " }, ...checks.slice(1)],
    (checks) => [{ ...checks[0], Reason: "" }, ...checks.slice(1)],
    (checks) => [{ ...checks[0], Approved: true }, ...checks.slice(1)],
  ];
  for (const mutate of mutations) {
    const raw = result("ungrounded", value);
    await assert.rejects(
      frameworkReview(
        { ...raw, result: { Checks: mutate(raw.result.Checks) } },
        "ungrounded",
        value,
      ),
    );
  }
});

test("review, snapshot, evidence and chat reuse Parse with zero additional claim CU calls", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "policy-claims-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const cache = new Cache();
  const run = await cache.load(await includedRunId(cache));
  run.items = run.items.slice(0, 1);
  run.source = run.source.slice(0, 1);
  const packet = run.source[0];
  const definition = {
    status: "ready",
    baseAnalyzerId: "prebuilt-document",
    config: { returnDetails: true },
    fieldSchema: { fields: {} },
    models: {},
  };
  const { status, ...definitionFields } = definition;
  const settings = {
    ...(await config()),
    claimAnalyzerHash: digest(canonical(definitionFields)),
  };
  const summary = {
    status: "Succeeded",
    result: {
      contents: [
        {
          path: "input1",
          analyzerId: "claim-summary",
          fields: {
            Routing: {
              type: "object",
              valueObject: { LossState: { type: "string", valueString: "TX" } },
            },
            Authorization: {
              type: "object",
              valueObject: {
                Authorized: { type: "boolean", valueBoolean: false },
                PriorDays: { type: "integer", valueInteger: 0 },
                Unknown: { type: "string" },
              },
            },
          },
        },
      ],
    },
  };
  let extractions = 0,
    invocations = 0;
  const service = new PolicyService({
    config: async () => settings,
    cacheFolder: folder,
    cu: {
      detail: async () => definition,
      analyze: async () => {
        extractions++;
        return summary;
      },
    },
    invoke: async () => {
      invocations++;
      return result("ungrounded", settings);
    },
  });
  const readRaw = (id: string) => cache.raw(run.id, id);
  const raw = await readRaw(packet.id);
  await service.markdown(run, packet, await readRaw(packet.id));
  assert.equal(extractions + invocations, 0);
  const first = await service.start(run, "ungrounded", readRaw);
  await assert.rejects(
    service.start(run, "search", readRaw),
    /already running/,
  );
  await first.task;
  assert.equal(
    first.job.items[0].status,
    "completed",
    first.job.items[0].error ?? "Claim review must complete",
  );
  const markdown = await service.markdown(
    run,
    packet,
    await readRaw(packet.id),
  );
  assert.equal(markdown, packetMarkdown(packetJson(raw, packet, run,
    summarize(raw, packet, run.analyzer.mode))));
  const evidence = await service.claimEvidence(run, packet, await readRaw(packet.id));
  assert.equal(evidence.packetId, packet.id);
  assert.ok(evidence.fields.some((field) => field.field.startsWith("parse.")));
  assert.ok(evidence.fields.every((field) => field.href === `/data/packets/${packet.id}.pdf`));
  assert.ok(evidence.fields.every((field) => field.regions.every((region) =>
    region.page >= 1 && region.page <= packet.pages)));
  const again = await service.start(run, "ungrounded", readRaw);
  await again.task;
  assert.equal(extractions, 0);
  assert.equal(invocations, 1);
  const exported = packetJson(
    await readRaw(packet.id),
    packet,
    run,
    summarize(await readRaw(packet.id), packet, run.analyzer.mode),
  );
  assert.equal(packetMarkdown(exported), markdown);
  assert.ok((await service.snapshot(run, "ungrounded", readRaw))[0].status === "completed");
  await service.chatContext(run, "ungrounded", packet.id, readRaw);
  assert.equal(extractions, 0);
  assert.ok(!(await readdir(folder)).some((name) => name.startsWith("claim-")));
  assert.throws(() =>
    withClaimSummary(exported, { ...summary, status: "Failed" }),
  );
  assert.throws(() =>
    withClaimSummary(exported, {
      status: "Succeeded",
      result: { contents: [] },
    }),
  );
});

test("citations accept only exact source files, versions, rules and sections", async () => {
  const value = result("search", await config()).result;
  const link = (await resolveCitations(value))[1][0].href;
  assert.match(link ?? "", /tx-rental-review-sop-v2\.pdf#page=3$/);
  for (const patch of [
    { File: "../tx-rental-review-sop-v2.pdf" },
    { File: "javascript:alert(1)" },
    { Version: "v99" },
    { Version: "vv2.0" },
    { DocumentId: "WA-RENTAL-002" },
    { RuleId: "WA-R2" },
    { Section: "Not a printed section" },
  ]) {
    const changed = structuredClone(value);
    Object.assign(changed.Checks[1].Citation[0], patch);
    assert.equal((await resolveCitations(changed))[1][0].href, null);
  }
});

test("private API chats preserve history, isolate cases and never replay failed requests", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "policy-api-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const settings = await config();
  const cache = new Cache(),
    runId = await includedRunId(cache);
  const original = await cache.load(runId);
  const run = {
    ...original,
    items: original.items.slice(0, 1),
    source: original.source.slice(0, 1),
  };
  const claimKey = digest(
    JSON.stringify({
      pdf: run.source[0].sha256,
      endpoint: settings.cuEndpoint,
      apiVersion: settings.cuApiVersion,
      analyzer: settings.claimAnalyzerId,
      definition: settings.claimAnalyzerHash,
      schema: 1,
    }),
  );
  await savePolicyCache(path.join(folder, `claim-${claimKey}.json`), {
    analyzerFingerprint: settings.claimAnalyzerHash,
    response: {
      status: "Succeeded",
      result: {
        contents: [
          {
            path: "input1",
            fields: {
              Routing: {
                type: "object",
                valueObject: {
                  LossState: { type: "string", valueString: "TX" },
                },
              },
            },
          },
        ],
      },
    },
  });
  let fail = false,
    calls = 0,
    delay = false;
  let release: (() => void) | undefined;
  const histories: unknown[] = [];
  const service = new PolicyService({
    config: async () => settings,
    cacheFolder: folder,
    invoke: async (input) => {
      const request = input as {
        mode: "ungrounded" | "search";
        chat?: boolean;
        history?: unknown[];
      };
      const raw = result(request.mode, settings);
      if (!request.chat) return raw;
      calls++;
      histories.push(structuredClone(request.history));
      if (delay)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (fail) throw new Error("Search authentication failed");
      return {
        ...raw,
        result: {
          Answer: "Rate explanation",
          Citation: raw.result.Checks[1].Citation,
        },
      };
    },
  });
  const { task } = await service.start(run, "search", (id) =>
    cache.raw(runId, id),
  );
  await task;
  const app = createApp(
    {
      detail: async () => {
        throw new Error("No automatic CU");
      },
      analyze: async () => {
        throw new Error("No automatic CU");
      },
    },
    { policy: service },
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/`;
  async function privateSession() {
    const value = await (
      await fetch(base + "session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).json();
    const headers = {
      "Content-Type": "application/json",
      "x-labmachine-session": value.sessionId,
    };
    assert.equal(
      (
        await fetch(base + "cache/load", {
          method: "POST",
          headers,
          body: JSON.stringify({ runId }),
        })
      ).status,
      200,
    );
    return headers;
  }
  const headers = await privateSession();
  const query = `policy/chat?mode=search&packetId=packet-01&runId=${runId}&check=Daily%20rate`;
  assert.equal((await fetch(base + query)).status, 401);
  const read = async () => (await fetch(base + query, { headers })).json();
  const context = await read();
  assert.equal(context.messages.length, 2);
  assert.equal(context.messages[0].content, context.prompt);
  assert.equal(calls, 0);
  const body = {
    mode: "search",
    packetId: "packet-01",
    check: "Daily rate",
    runId,
    contextId: context.contextId,
    message: "Explain the rate",
    live: true,
  };
  const send = (value = body) =>
    fetch(base + "policy/chat", {
      method: "POST",
      headers,
      body: JSON.stringify(value),
    });
  assert.equal((await send({ ...body, live: false })).status, 400);
  assert.equal((await send({ ...body, message: " " })).status, 400);
  assert.equal(
    (await send({ ...body, contextId: "a".repeat(64) })).status,
    409,
  );
  const reply = await (await send()).json();
  assert.equal(reply.text, "Rate explanation");
  assert.match(reply.citations[0].href, /#page=3$/);
  assert.deepEqual(histories[0], context.messages);
  assert.equal((await read()).messages.length, 4);
  const timing = await (await fetch(base + query.replace("check=Daily%20rate", "check=Rental%20start"), { headers })).json();
  assert.notEqual(timing.contextId, context.contextId);
  assert.equal(timing.messages.length, 2);
  assert.deepEqual(timing.result.Checks.map((check: { Check: string }) => check.Check), ["Rental start"]);
  assert.equal((await send({ ...body, check: "Rental start" })).status, 409);
  assert.equal((await fetch(base + query.replace("&check=Daily%20rate", ""), { headers })).status, 400);
  const other = await privateSession();
  assert.equal(
    (await (await fetch(base + query, { headers: other })).json()).messages
      .length,
    2,
  );
  assert.equal(
    (await fetch(base + query.replace("packet-01", "packet-02"), { headers }))
      .status,
    409,
  );
  assert.equal(
    (await fetch(base + query.replace("search", "ungrounded"), { headers }))
      .status,
    409,
  );
  assert.equal(
    (await fetch(base + query.replace("search", "existing"), { headers }))
      .status,
    400,
  );
  fail = true;
  assert.equal((await send()).status, 500);
  assert.equal((await read()).messages.length, 4);
  fail = false;
  delay = true;
  const pending = send();
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await send()).status, 409);
  assert.equal(
    (
      await fetch(base + "cache/load", {
        method: "POST",
        headers,
        body: JSON.stringify({ runId }),
      })
    ).status,
    409,
  );
  release();
  assert.equal((await pending).status, 200);
  assert.equal(
    (await service.snapshot(run, "search", (id) => cache.raw(runId, id)))[0]
      .result?.Checks[1].Outcome,
    "Satisfied",
  );
  settings.indexFingerprint = "f".repeat(64);
  assert.equal((await send()).status, 409);
});

test("missing configuration leaves claim views usable and exposes an actionable setup message", async () => {
  const service = new PolicyService({ config: async () => undefined });
  assert.equal((await service.status()).configured, false);
  const cache = new Cache(),
    run = await cache.load(await includedRunId(cache));
  const markdown = await service.markdown(
    run,
    run.source[0],
    await cache.raw(run.id, run.source[0].id),
  );
  assert.ok(markdown.length > 0);
  await assert.rejects(
    service.start(run, "search", (id) => cache.raw(run.id, id)),
    /setup-policy-index/,
  );
});
