import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configuration, LabError, record, repositoryRoot } from "./config.ts";
import { CuClient } from "./cu.ts";
import { summarize, type Packet, type Run } from "./batch.ts";
import { packetJson } from "./packet-json.ts";
import { packetMarkdown } from "./packet-markdown.ts";
import {
  canonical, checkNames, checkContractVersion, citationSchema, digest, modeSchema, policyClaimAnalysis, parsedPolicyScope, parsedTextEvidence, question, resolveCitations,
  type PolicyMode,
} from "./policy-core.ts";
import { chatAnswerSchema, type ChatMessage } from "./policy-chat.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const azureRoot = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && /\.(services\.ai|cognitiveservices)\.azure\.com$/.test(url.hostname) &&
    url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash && !url.port;
});
export const frameworkConfigSchema = z.object({
  schemaVersion: z.literal(1), provider: z.literal("agent-framework"),
  azureOpenAIEndpoint: azureRoot, modelDeployment: z.string().min(1),
  searchEndpoint: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && /\.search\.windows\.net$/.test(url.hostname) &&
      url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash && !url.port;
  }),
  indexName: z.string().regex(/^[a-z0-9][a-z0-9-]{1,126}$/),
  corpusHash: hash, indexFingerprint: hash, extractionMode: z.enum(["layout", "standard"]),
  cuEndpoint: azureRoot, cuApiVersion: z.enum(["2025-11-01", "2026-06-01-preview"]),
  claimAnalyzerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(), claimAnalyzerHash: hash.optional(),
});
export type FrameworkConfig = z.infer<typeof frameworkConfigSchema>;
type FrameworkMode = "ungrounded" | "search";
type PolicyScope = { policyId: string | null; vin: string | null };
export type PolicyContext = {
  provider: "agent-framework"; mode: PolicyMode; indexName: string | null;
  extractionMode: FrameworkConfig["extractionMode"]; configurationHash: string;
  lossState?: string | null;
  policyScope?: PolicyScope;
  modelDeployment?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
};
export type PolicyItem = {
  id: string; status: "pending" | "reviewing" | "completed" | "failed" | "not run";
  stageStartedAt?: string;
  cached?: boolean; error?: string; result?: z.infer<typeof frameworkOutput>;
  citations?: Awaited<ReturnType<typeof resolveCitations>>;
  completedAt?: string; provider?: string; indexName?: string | null;
  extractionMode?: FrameworkConfig["extractionMode"]; inputHash?: string;
  historical?: boolean;
};
export type PolicyJob = {
  id: string; runId: string; mode: PolicyMode; status: "running" | "completed";
  startedAt: string; completedAt?: string; items: PolicyItem[];
  checkContractVersion?: typeof checkContractVersion;
};
export async function loadPolicyCache(file: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (record(error)?.code === "ENOENT") return undefined;
    throw error;
  }
}
export async function savePolicyCache(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, file);
}
const savedReviewSchema = z.object({
  status: z.literal("completed"), raw: z.unknown(),
  completedAt: z.string().datetime(), reviewQuestion: z.string().optional(),
});
const archivedReviewSchema = savedReviewSchema.extend({
  inputHash: hash, reviewKey: hash, reviewQuestion: z.string(),
  checkContractVersion: z.literal(checkContractVersion),
});
const frameworkOutput = z.object({
  Checks: z.array(z.object({
    Check: z.enum(checkNames), Outcome: z.enum(["Satisfied", "ReviewRequired", "NotApplicable", "InProgress"]),
    ReviewRequired: z.boolean(), ExpectedValue: z.string().trim().min(1),
    ActualValue: z.string().trim().min(1), Reason: z.string().trim().min(1),
    Headline: z.string().trim().min(1).max(100).optional(),
    Comparisons: z.array(z.object({
      ClaimField: z.string().trim().min(1).max(160),
      ClaimLabel: z.string().trim().min(1).max(80),
      ClaimValue: z.string().trim().min(1).max(180),
      PolicyField: z.string().trim().min(1).max(160),
      PolicyLabel: z.string().trim().min(1).max(80),
      PolicyValue: z.string().trim().min(1).max(180),
    }).strict()).min(1).max(3).optional(),
    Citation: z.array(citationSchema),
  }).strict()).length(checkNames.length),
}).strict().superRefine((value, ctx) => value.Checks.forEach((check, index) => {
  if (check.Check !== checkNames[index] || check.ReviewRequired !== (check.Outcome === "ReviewRequired") ||
      (check.Outcome !== "ReviewRequired" && !check.Citation.length))
    ctx.addIssue({ code: "custom", message: "Inconsistent three-check outcome or missing rule citation." });
  if (Boolean(check.Headline) !== Boolean(check.Comparisons))
    ctx.addIssue({ code: "custom", message: "A compact check requires both a headline and comparisons." });
  for (const pair of check.Comparisons ?? [])
    if (!check.Citation.some((citation) => citation.RuleId === pair.PolicyField) &&
        !(pair.PolicyField === "Not retrieved" && pair.PolicyValue === "Not established" &&
          check.Outcome === "ReviewRequired"))
      ctx.addIssue({ code: "custom", message: "Comparison references an uncited policy rule." });
}));
const envelope = z.object({
  provider: z.literal("agent-framework"), status: z.literal("completed"),
  mode: z.enum(["ungrounded", "search"]), result: z.unknown(),
  retrievalCalls: z.number().int().nonnegative(),
  retrieved: z.array(z.object({
    file: z.string(), documentId: z.string(), version: z.string(),
    citationSections: z.array(z.string()).min(1),
    ruleIds: z.array(z.string()), sha256: hash, corpusHash: hash, indexFingerprint: hash,
  }).passthrough()),
  claimInput: z.string().optional(),
  checkPrompts: z.partialRecord(z.enum(checkNames), z.string().min(1)).optional(),
});

export function parseFrameworkResult(raw: unknown, mode: FrameworkMode, config: FrameworkConfig) {
  const value = envelope.parse(raw);
  if (value.mode !== mode || (mode === "ungrounded" && (value.retrievalCalls || value.retrieved.length)) ||
      (mode === "search" && !value.retrievalCalls))
    throw new LabError(502, "Agent Framework retrieval mode/evidence mismatch.");
  if (value.retrieved.some((doc) => doc.corpusHash !== config.corpusHash || doc.indexFingerprint !== config.indexFingerprint))
    throw new LabError(502, "Search returned a different corpus or index snapshot.");
  return value;
}
function verifyCitations(citations: z.infer<typeof citationSchema>[], raw: z.infer<typeof envelope>) {
  for (const citation of citations)
    if (!raw.retrieved.some((doc) => doc.file === citation.File && doc.documentId === citation.DocumentId &&
      doc.version === citation.Version.replace(/^v/, "") && doc.citationSections.includes(citation.Section) &&
      doc.ruleIds.includes(citation.RuleId)))
      throw new LabError(502, "Agent cited a rule not retrieved during this turn.");
}
export async function frameworkReview(raw: unknown, mode: FrameworkMode, config: FrameworkConfig) {
  const value = parseFrameworkResult(raw, mode, config);
  const result = frameworkOutput.parse(value.result);
  if (mode === "ungrounded" && result.Checks.some((check) => check.Outcome !== "ReviewRequired" || check.Citation.length))
    throw new LabError(502, "No-retrieval baseline must disclose missing rules, without invented citations or passes.");
  verifyCitations(result.Checks.flatMap((check) => check.Citation), value);
  const citations = await resolveCitations(result);
  if (citations.flat().some((citation) => !citation.href))
    throw new LabError(502, "Agent cited an unverified policy PDF or section.");
  return { result, citations };
}

export async function invokeFramework(request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.POLICY_PYTHON ?? "python",
      [path.join(repositoryRoot, "infra", "policy-framework-agent.py")],
      { cwd: repositoryRoot, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", failed = false;
    const fail = (error: Error) => { if (!failed) { failed = true; reject(error); } };
    const timer = setTimeout(() => {
      child.kill();
      fail(new LabError(504, "Agent Framework exceeded five minutes; no successful result was assumed."));
    }, 300_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 4_000_000) {
        child.kill();
        fail(new LabError(502, "Agent Framework output exceeded the response limit."));
      }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on("error", (error) => { clearTimeout(timer); fail(error); });
    child.stdin.on("error", (error) => fail(error));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      try {
        const value: unknown = JSON.parse(stdout);
        if (code || record(value)?.status !== "completed") {
          console.error(JSON.stringify({ event: "framework_agent_failed", code, stderr }));
          fail(new LabError(502, `Agent Framework failed: ${String(record(value)?.error ?? "Check Python runtime logs.")}`));
        } else resolve(value);
      } catch {
        console.error(JSON.stringify({ event: "framework_agent_protocol_failed", code, stderr }));
        fail(new LabError(502, "Agent Framework did not return valid JSON. Check installed Python dependencies."));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

type Dependencies = {
  configPath?: string; config?: () => Promise<FrameworkConfig | undefined>;
  invoke?: typeof invokeFramework; cu?: Pick<CuClient, "detail" | "analyze">; cacheFolder?: string;
};
export class PolicyService {
  private running = false;
  private configPath: string;
  readonly cacheFolder: string;
  constructor(private frameworkDependencies: Dependencies = {}) {
    this.cacheFolder = frameworkDependencies.cacheFolder ?? path.join(repositoryRoot, ".tools", "policy-cache");
    this.configPath = frameworkDependencies.configPath ?? process.env.POLICY_FRAMEWORK_CONFIG ??
      path.join(repositoryRoot, ".tools", "policy-agent-framework.json");
  }
  private async frameworkConfig() {
    const config = this.frameworkDependencies.config ? await this.frameworkDependencies.config()
      : await loadPolicyCache(this.configPath);
    if (!config) return undefined;
    const value = frameworkConfigSchema.parse(config);
    const base = path.join(repositoryRoot, "data", "policies", "rental", "ocr-comparison-v2");
    const manifestBytes = await readFile(path.join(base, "manifest.json"));
    if (value.corpusHash !== digest(manifestBytes)) throw new LabError(409, "Policy corpus changed. Rerun index setup.");
    const manifest = record(JSON.parse(manifestBytes.toString()));
    if (!Array.isArray(manifest?.documents)) throw new LabError(409, "Invalid policy corpus manifest.");
    for (const entry of manifest.documents) {
      const doc = z.object({ pdf: z.string().regex(/^[a-z0-9-]+\.pdf$/), sha256: hash }).parse(entry);
      if (digest(await readFile(path.join(base, doc.pdf))) !== doc.sha256)
        throw new LabError(409, "Policy PDF changed. Regenerate the corpus and rerun index setup.");
    }
    return value;
  }
  async status() {
    try {
      const config = await this.frameworkConfig();
      if (!config) return { configured: false, message: "Run infra/setup-policy-index.py to check policy setup prerequisites." };
      return {
        configured: true, batchRunning: this.running,
        modes: Object.fromEntries((["ungrounded", "search"] as const).map((mode) => {
          const agent = this.agent(config, mode);
          return [mode, { provider: agent.provider, indexName: agent.indexName,
            extractionMode: agent.extractionMode }];
        })),
        message: `${config.extractionMode === "standard" ? "Search-managed CU extraction" : "Current index: CU Layout extraction; managed extraction not activated"}. Three comparisons reuse saved Parse and extract evidence; no claim extraction is submitted. Earlier five-check caches remain history, not three-check results. Run explicitly; Search and model usage may be billed.`,
      };
    } catch (error) {
      console.error(JSON.stringify({ event: "framework_configuration_failed", message: String(error) }));
      return { configured: false, message: `Agent Framework configuration is invalid: ${String(error)}` };
    }
  }
  private agent(config: FrameworkConfig, mode: FrameworkMode): PolicyContext {
    return {
      provider: "agent-framework", mode,
      indexName: mode === "search" ? config.indexName : null,
      extractionMode: config.extractionMode,
      configurationHash: digest(canonical(config)),
    };
  }
  async markdown(run: Run, packet: Packet, raw: unknown) {
    return packetMarkdown(packetJson(raw, packet, run, summarize(raw, packet, run.analyzer.mode)));
  }
  async claimEvidence(run: Run, packet: Packet, raw: unknown) {
    const exported = packetJson(raw, packet, run, summarize(raw, packet, run.analyzer.mode));
    return {
      packetId: packet.id,
      fields: [...exported.documents.flatMap((document) =>
        document.extractions.flatMap((extraction) => extraction.evidence.map((fact) => ({
          ...fact, category: document.category, contentPath: extraction.content_path,
          href: `/data/packets/${packet.id}.pdf`,
          regions: fact.regions.filter((region) => region.page >= 1 && region.page <= packet.pages),
        }))),
      ), ...parsedTextEvidence(exported).map((source) => ({
        field: source.id, value: source.text, status: "present",
        category: source.category, contentPath: source.contentPath,
        pages: source.pages, provenance: "First-pass parsed page text; interpretation is not a typed CU field.",
        href: `/data/packets/${packet.id}.pdf`, regions: [],
        confidence: null, source: null,
      }))],
    };
  }
  private async input(run: Run, packet: Packet, config: FrameworkConfig, readRaw: (id: string) => Promise<unknown>) {
    const raw = await readRaw(packet.id);
    const exported = packetJson(raw, packet, run, summarize(raw, packet, run.analyzer.mode));
    const scope = parsedPolicyScope(exported);
    const claimAnalysis = { ...policyClaimAnalysis(exported, raw), scopeConflicts: scope.scopeConflicts };
    const markdown = canonical(claimAnalysis);
    const reviewQuestion = await question();
    const prompt = `${reviewQuestion}\n\n---\n\nClaim input: saved typed Parse fields and selected native page text; no second claim extraction.\nUntrusted parsed evidence:\n\n${markdown}`;
    return { markdown, prompt, reviewQuestion, claimAnalysis, ...scope };
  }
  private reviewOptions(config: FrameworkConfig) {
    return {
      reviewStrategy: z.enum(["parallel", "single"]).parse(process.env.POLICY_REVIEW_STRATEGY ?? "parallel"),
      reasoningEffort: process.env.POLICY_REASONING_EFFORT
        ? z.enum(["minimal", "low", "medium", "high"]).parse(process.env.POLICY_REASONING_EFFORT)
        : config.modelDeployment === "gpt-5" ? "low" : undefined,
    };
  }
  private chatOptions(config: FrameworkConfig) {
    const modelDeployment = z.string().trim().min(1).max(128).parse(
      process.env.POLICY_CHAT_MODEL_DEPLOYMENT ?? config.modelDeployment,
    );
    const reasoningEffort = process.env.POLICY_CHAT_REASONING_EFFORT
      ? z.enum(["minimal", "low", "medium", "high"]).parse(process.env.POLICY_CHAT_REASONING_EFFORT)
      : modelDeployment === config.modelDeployment ? this.reviewOptions(config).reasoningEffort
      : modelDeployment === "gpt-5" ? "low" as const : undefined;
    return { modelDeployment, reasoningEffort };
  }
  private async key(config: FrameworkConfig, mode: FrameworkMode, prompt: string, run: Run) {
    const [runtime, inputs, prompts] = await Promise.all([
      readFile(path.join(repositoryRoot, "infra", "policy-framework-agent.py")),
      readFile(path.join(repositoryRoot, "infra", "policy_check_inputs.py")),
      readFile(path.join(repositoryRoot, "docs", "rental-review-agent-question-v2.md")),
    ]);
    return digest(canonical({ schema: checkContractVersion, checks: checkNames, config, mode, prompt, run: run.id,
      options: this.reviewOptions(config), analyzer: run.analyzer.fingerprint,
      runtime: digest(runtime), inputs: digest(inputs), prompts: digest(prompts) }));
  }
  private file(key: string) { return path.join(this.cacheFolder, `framework-review-${key}.json`); }
  private savedFile(config: FrameworkConfig, run: Run, mode: FrameworkMode, packetId: string) {
    return path.join(this.cacheFolder, `framework-saved-${digest(canonical({
      checkContractVersion, config, runId: run.id, analyzer: run.analyzer.fingerprint, mode, packetId,
    }))}.json`);
  }
  private async savedReview(config: FrameworkConfig, run: Run, mode: FrameworkMode,
    packetId: string, input: Awaited<ReturnType<PolicyService["input"]>>) {
    const key = await this.key(config, mode, input.prompt, run);
    const exact = record(await loadPolicyCache(this.file(key)));
    if (exact?.status === "completed")
      return { ...savedReviewSchema.parse(exact), key, historical: false };
    const archived = record(await loadPolicyCache(this.savedFile(config, run, mode, packetId)));
    if (archived?.checkContractVersion !== checkContractVersion ||
        archived.status !== "completed" || archived.inputHash !== digest(input.markdown)) return undefined;
    const saved = archivedReviewSchema.parse(archived);
    return { ...saved, key: saved.reviewKey, historical: saved.reviewKey !== key };
  }
  private async required() {
    const config = await this.frameworkConfig();
    if (!config) throw new LabError(409, "Run infra/setup-policy-index.py --apply to configure Agent Framework.");
    return config;
  }
  async snapshot(run: Run, mode: PolicyMode, readRaw: (id: string) => Promise<unknown>): Promise<PolicyItem[]> {
    const config = await this.required();
    const failures = await this.failedAttempts(run.id, mode);
    return Promise.all(run.items.map(async (item): Promise<PolicyItem> => {
      const packet = run.source.find((p) => p.id === item.id);
      if (!packet || !item.rawSaved)
        return { id: item.id, status: "not run" };
      const input = await this.input(run, packet, config, readRaw);
      const saved = await this.savedReview(config, run, mode, item.id, input);
      if (!saved)
        return failures.get(item.id) ?? { id: item.id, status: "not run" };
      return { id: item.id, status: "completed", cached: true,
        ...await frameworkReview(saved.raw, mode, config), ...this.metadata(config, mode),
        completedAt: String(saved.completedAt), inputHash: digest(input.markdown),
        historical: saved.historical };
    }));
  }
  private async failedAttempts(runId: string, mode: PolicyMode) {
    let names: string[];
    try { names = await readdir(this.cacheFolder); }
    catch (error) {
      if (record(error)?.code === "ENOENT") return new Map<string, PolicyItem>();
      throw error;
    }
    const schema = z.object({
      runId: z.string(), mode: modeSchema, status: z.literal("completed"),
      completedAt: z.string().datetime(),
      items: z.array(z.object({
        id: z.string().regex(/^packet-\d{2}$/),
        status: z.enum(["completed", "failed"]), error: z.string().optional(),
      })),
    });
    const jobs: z.infer<typeof schema>[] = [];
    for (const name of names.filter((name) => /^framework-job-[a-f0-9-]+\.json$/.test(name))) {
      const saved = record(await loadPolicyCache(path.join(this.cacheFolder, name)));
      if (saved?.checkContractVersion === checkContractVersion &&
          saved.runId === runId && saved.mode === mode) jobs.push(schema.parse(saved));
    }
    const failures = new Map<string, PolicyItem>();
    for (const job of jobs.sort((a, b) => a.completedAt.localeCompare(b.completedAt)))
      for (const item of job.items) {
        if (item.status === "completed") failures.delete(item.id);
        else failures.set(item.id, {
          id: item.id, status: "failed", completedAt: job.completedAt,
          error: `Previous attempt (${job.completedAt}): ${item.error ?? "Policy review failed. Check the workbench logs."}`,
        });
      }
    return failures;
  }
  private metadata(config: FrameworkConfig, mode: FrameworkMode) {
    const agent = this.agent(config, mode);
    return { provider: agent.provider, indexName: agent.indexName, extractionMode: agent.extractionMode };
  }
  async start(run: Run, mode: PolicyMode, readRaw: (id: string) => Promise<unknown>, packetIds?: string[]) {
    if (this.running) throw new LabError(409, "An Agent Framework batch is already running.");
    if (packetIds && (!packetIds.length || new Set(packetIds).size !== packetIds.length ||
        packetIds.some((id) => !run.items.some((item) => item.id === id))))
      throw new LabError(422, "Select unique packets from the loaded CU run.");
    this.running = true;
    try {
      const config = await this.required();
      const job: PolicyJob = {
        id: randomUUID(), runId: run.id, mode, checkContractVersion, status: "running", startedAt: new Date().toISOString(),
        items: run.items.filter(({ id }) => !packetIds || packetIds.includes(id)).map(({ id, rawSaved }) => ({ id, status: rawSaved ? "pending" : "failed",
          ...(!rawSaved ? { error: "No saved CU result for this case." } : {}) })),
      };
      const task = this.executeFramework(job, run, mode, config, readRaw).finally(() => { this.running = false; });
      return { job, task };
    } catch (error) { this.running = false; throw error; }
  }
  private async executeFramework(job: PolicyJob, run: Run, mode: FrameworkMode, config: FrameworkConfig,
    readRaw: (id: string) => Promise<unknown>) {
    for (const item of job.items) {
      if (item.status === "failed") continue;
      try {
        const packet = run.source.find((p) => p.id === item.id);
        if (!packet) throw new LabError(422, "Packet metadata missing.");
        const input = await this.input(run, packet, config, readRaw);
        const reviewKey = await this.key(config, mode, input.prompt, run);
        const file = this.file(reviewKey);
        const previous = record(await loadPolicyCache(file));
        item.status = "reviewing";
        item.stageStartedAt = new Date().toISOString();
        const raw = previous?.status === "completed" ? previous.raw
          : await (this.frameworkDependencies.invoke ?? invokeFramework)({
            mode, prompt: input.claimAnalysis ? input.reviewQuestion : input.prompt,
            claimAnalysis: input.claimAnalysis, ...this.reviewOptions(config),
            ...(!input.claimAnalysis ? { reviewStrategy: "single" } : {}),
            lossState: input.lossState, policyScope: input.policyScope, configPath: this.configPath, compact: true,
          });
        const completedAt = previous?.status === "completed" ? String(previous.completedAt) : new Date().toISOString();
        await savePolicyCache(file, { status: "received", raw, completedAt });
        const parsed = await frameworkReview(raw, mode, config);
        await savePolicyCache(file, { status: "completed", raw, completedAt });
        await savePolicyCache(this.savedFile(config, run, mode, item.id), {
          status: "completed", checkContractVersion, raw, completedAt, reviewKey,
          inputHash: digest(input.markdown), reviewQuestion: input.reviewQuestion,
        });
        Object.assign(item, { status: "completed", ...parsed, completedAt,
          cached: previous?.status === "completed", inputHash: digest(input.markdown), ...this.metadata(config, mode) });
      } catch (error) {
        const stage = item.status;
        item.status = "failed";
        item.error = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({
          timestamp: new Date().toISOString(), event: "framework_policy_failed",
          jobId: job.id, runId: run.id, packetId: item.id, mode, stage, message: item.error,
        }));
      }
    }
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    await savePolicyCache(path.join(this.cacheFolder, `framework-job-${job.id}.json`), job);
  }
  async chatContext(run: Run, mode: PolicyMode, packetId: string, readRaw: (id: string) => Promise<unknown>,
    check: typeof checkNames[number] = checkNames[0], runtime: PolicyService = this) {
    const config = await this.required();
    const packet = run.source.find((p) => p.id === packetId);
    if (!packet || !run.items.some((item) => item.id === packetId && item.rawSaved))
      throw new LabError(404, "No saved CU result for this case.");
    const input = await this.input(run, packet, config, readRaw);
    const saved = await this.savedReview(config, run, mode, packetId, input);
    if (!saved) throw new LabError(409, "Run policy checks for this case and mode before chatting.");
    const key = saved.key;
    const parsed = await frameworkReview(saved.raw, mode, config);
    const runtimeConfig = runtime === this ? config : await runtime.required();
    const agent = { ...runtime.agent(runtimeConfig, mode), ...runtime.chatOptions(runtimeConfig),
      lossState: input.lossState, policyScope: input.policyScope };
    const savedPrompt = parseFrameworkResult(saved.raw, mode, config).checkPrompts?.[check];
    const prompt = savedPrompt ?? z.object({ prompt: z.string().min(1) }).parse(
      await (runtime.frameworkDependencies.invoke ?? invokeFramework)({
        mode, prompt: input.reviewQuestion, prepareCheck: check,
        claimAnalysis: input.claimAnalysis, configPath: runtime.configPath,
      }),
    ).prompt;
    const index = checkNames.indexOf(check);
    const result = { Checks: [parsed.result.Checks[index]] };
    return { contextId: digest(canonical({ key, agent, check, prompt, result })), packetId, mode, check, agent,
      prompt, promptSource: savedPrompt ? "saved" as const : "current" as const,
      result, citations: [parsed.citations[index]] };
  }
  async followup(mode: PolicyMode, message: string, history: ChatMessage[], expectedAgent: PolicyContext) {
    const config = await this.required();
    const expected = this.agent(config, mode);
    if (expected.configurationHash !== expectedAgent.configurationHash || expected.mode !== expectedAgent.mode)
      throw new LabError(409, "Agent Framework configuration changed. Reload this chat.");
    const chatOptions = this.chatOptions(config);
    if (chatOptions.modelDeployment !== expectedAgent.modelDeployment ||
        chatOptions.reasoningEffort !== expectedAgent.reasoningEffort)
      throw new LabError(409, "Chat model settings changed. Reload this chat.");
    const lossState = "lossState" in expectedAgent && typeof expectedAgent.lossState === "string" ? expectedAgent.lossState : null;
    const raw = await (this.frameworkDependencies.invoke ?? invokeFramework)({
      mode, prompt: message, history, lossState, policyScope: expectedAgent.policyScope, chat: true,
      ...chatOptions, configPath: this.configPath,
    });
    const value = parseFrameworkResult(raw, mode, config);
    const parsed = chatAnswerSchema.parse(value.result);
    verifyCitations(parsed.Citation, value);
    const [citations] = await resolveCitations({ Checks: [{ Citation: parsed.Citation }] });
    if (citations.some((citation) => !citation.href)) throw new LabError(502, "Unverified chat citation.");
    return { text: parsed.Answer, citations };
  }
}
