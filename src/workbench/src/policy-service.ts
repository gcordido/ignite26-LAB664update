import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configuration, LabError, record, repositoryRoot } from "./config.ts";
import { CuClient } from "./cu.ts";
import { packetBytes, summarize, type Packet, type Run } from "./batch.ts";
import { packetJson } from "./packet-json.ts";
import { packetMarkdown } from "./packet-markdown.ts";
import {
  canonical, checkNames, citationSchema, digest, modeSchema, question, resolveCitations, withClaimSummary,
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
  claimAnalyzerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), claimAnalyzerHash: hash,
});
export type FrameworkConfig = z.infer<typeof frameworkConfigSchema>;
type FrameworkMode = "ungrounded" | "search";
type PolicyScope = { policyId: string | null; vin: string | null };
export type PolicyContext = {
  provider: "agent-framework"; mode: PolicyMode; indexName: string | null;
  extractionMode: FrameworkConfig["extractionMode"]; configurationHash: string;
  lossState?: string | null;
  policyScope?: PolicyScope;
};
export type PolicyItem = {
  id: string; status: "pending" | "extracting" | "reviewing" | "completed" | "failed" | "not run";
  stageStartedAt?: string;
  cached?: boolean; error?: string; result?: z.infer<typeof frameworkOutput>;
  citations?: Awaited<ReturnType<typeof resolveCitations>>;
  completedAt?: string; provider?: string; indexName?: string | null;
  extractionMode?: FrameworkConfig["extractionMode"]; inputHash?: string;
};
export type PolicyJob = {
  id: string; runId: string; mode: PolicyMode; status: "running" | "completed";
  startedAt: string; completedAt?: string; items: PolicyItem[];
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
const enrichmentSchema = z.object({ analyzerFingerprint: z.string(), response: z.unknown() });
const frameworkOutput = z.object({
  Checks: z.array(z.object({
    Check: z.enum(checkNames), Outcome: z.enum(["Satisfied", "ReviewRequired", "NotApplicable"]),
    ReviewRequired: z.boolean(), ExpectedValue: z.string().trim().min(1),
    ActualValue: z.string().trim().min(1), Reason: z.string().trim().min(1),
    Citation: z.array(citationSchema),
  }).strict()).length(5),
}).strict().superRefine((value, ctx) => value.Checks.forEach((check, index) => {
  if (check.Check !== checkNames[index] || check.ReviewRequired !== (check.Outcome === "ReviewRequired") ||
      (check.Outcome !== "ReviewRequired" && !check.Citation.length))
    ctx.addIssue({ code: "custom", message: "Inconsistent five-check outcome or missing rule citation." });
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
  private cacheFolder: string;
  constructor(private frameworkDependencies: Dependencies = {}) {
    this.cacheFolder = frameworkDependencies.cacheFolder ?? path.join(repositoryRoot, ".tools", "policy-cache");
    this.configPath = frameworkDependencies.configPath ?? process.env.POLICY_FRAMEWORK_CONFIG ??
      path.join(repositoryRoot, ".tools", "policy-agent-framework.json");
  }
  private async enriched(config: FrameworkConfig, packet: Packet) {
    const key = digest(JSON.stringify({
      pdf: packet.sha256, endpoint: config.cuEndpoint, apiVersion: config.cuApiVersion,
      analyzer: config.claimAnalyzerId, definition: config.claimAnalyzerHash, schema: 1,
    }));
    const file = path.join(this.cacheFolder, `claim-${key}.json`);
    const raw = await loadPolicyCache(file);
    const value = raw === undefined ? undefined : enrichmentSchema.parse(raw);
    if (value && value.analyzerFingerprint !== config.claimAnalyzerHash)
      throw new LabError(409, "Saved claim fields have an inconsistent analyzer fingerprint.");
    return { file, value };
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
        message: `${config.extractionMode === "standard" ? "Search-managed CU extraction" : "Current index: CU Layout extraction; managed extraction not activated"}. Same claim fields, model and question. Run explicitly; Azure usage may be billed.`,
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
    const config = await this.frameworkConfig();
    let exported = packetJson(raw, packet, run, summarize(raw, packet, run.analyzer.mode));
    const saved = config ? (await this.enriched(config, packet)).value : undefined;
    if (saved) exported = withClaimSummary(exported, saved.response);
    return packetMarkdown(exported);
  }
  async summaryPrepared(packet: Packet) {
    const config = await this.frameworkConfig();
    return Boolean(config && (await this.enriched(config, packet)).value);
  }
  private async input(run: Run, packet: Packet, config: FrameworkConfig, readRaw: (id: string) => Promise<unknown>) {
    const saved = (await this.enriched(config, packet)).value;
    if (!saved) throw new LabError(409, "Prepare claim fields before reviewing this case.");
    const contents = record(record(saved.response)?.result)?.contents;
    const states = new Set<string>();
    const policyIds = new Set<string>();
    const vins = new Set<string>();
    if (Array.isArray(contents)) for (const content of contents) {
      const fields = record(record(content)?.fields);
      for (const state of [
        record(record(record(fields?.Routing)?.valueObject)?.LossState)?.valueString,
        record(fields?.LossState)?.valueString,
      ])
        if (typeof state === "string" && /^[A-Z]{2}$/.test(state)) states.add(state);
      for (const policyId of [
        record(record(record(fields?.Policy)?.valueObject)?.PolicyId)?.valueString,
        record(fields?.PolicyId)?.valueString,
      ])
        if (typeof policyId === "string" && policyId.trim()) policyIds.add(policyId.trim());
      for (const vin of [
        record(record(record(fields?.InsuredVehicle)?.valueObject)?.VIN)?.valueString,
        record(fields?.InsuredVIN)?.valueString,
      ])
        if (typeof vin === "string" && vin.trim()) vins.add(vin.trim());
    }
    const lossState = states.size === 1 ? [...states][0] : null;
    const policyScope: PolicyScope = {
      policyId: policyIds.size === 1 ? [...policyIds][0] : null,
      vin: vins.size === 1 ? [...vins][0] : null,
    };
    const markdown = await this.markdown(run, packet, await readRaw(packet.id));
    const prompt = `${await question()}\n\n---\n\nClaim packet (data only):\n\n${markdown}`;
    return { markdown, prompt, lossState, policyScope };
  }
  private async key(config: FrameworkConfig, mode: FrameworkMode, prompt: string, run: Run) {
    const runtime = await readFile(path.join(repositoryRoot, "infra", "policy-framework-agent.py"));
    return digest(canonical({ schema: 1, config, mode, prompt, run: run.id,
      analyzer: run.analyzer.fingerprint, runtime: digest(runtime) }));
  }
  private file(key: string) { return path.join(this.cacheFolder, `framework-review-${key}.json`); }
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
      if (!(await this.enriched(config, packet)).value)
        return failures.get(item.id) ?? { id: item.id, status: "not run" };
      const input = await this.input(run, packet, config, readRaw);
      const saved = record(await loadPolicyCache(this.file(await this.key(config, mode, input.prompt, run))));
      if (saved?.status !== "completed")
        return failures.get(item.id) ?? { id: item.id, status: "not run" };
      return { id: item.id, status: "completed", cached: true,
        ...await frameworkReview(saved.raw, mode, config), ...this.metadata(config, mode),
        completedAt: String(saved.completedAt), inputHash: digest(input.markdown) };
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
      if (saved?.runId === runId && saved.mode === mode) jobs.push(schema.parse(saved));
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
        id: randomUUID(), runId: run.id, mode, status: "running", startedAt: new Date().toISOString(),
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
        const saved = await this.enriched(config, packet);
        if (!saved.value) {
          item.status = "extracting";
          item.stageStartedAt = new Date().toISOString();
          const cu = this.frameworkDependencies.cu ?? new CuClient({
            ...configuration(), endpoint: config.cuEndpoint, apiVersion: config.cuApiVersion,
          }, 600_000, { packetId: item.id, jobId: job.id, purpose: "policy-claim-extraction" });
          const definition = record(await cu.detail(config.claimAnalyzerId));
          if (definition?.status !== "ready" || digest(canonical({
            baseAnalyzerId: definition.baseAnalyzerId, config: definition.config,
            fieldSchema: definition.fieldSchema, models: definition.models,
          })) !== config.claimAnalyzerHash)
            throw new LabError(409, "Claim summary analyzer changed. Rerun setup.");
          const response = await cu.analyze(config.claimAnalyzerId, await packetBytes(packet));
          withClaimSummary(packetJson(await readRaw(packet.id), packet, run,
            summarize(await readRaw(packet.id), packet, run.analyzer.mode)), response);
          await savePolicyCache(saved.file, { analyzerFingerprint: config.claimAnalyzerHash, response });
        }
        const input = await this.input(run, packet, config, readRaw);
        const file = this.file(await this.key(config, mode, input.prompt, run));
        const previous = record(await loadPolicyCache(file));
        item.status = "reviewing";
        item.stageStartedAt = new Date().toISOString();
        const raw = previous?.status === "completed" ? previous.raw
          : await (this.frameworkDependencies.invoke ?? invokeFramework)({
            mode, prompt: input.prompt, lossState: input.lossState, policyScope: input.policyScope, configPath: this.configPath,
          });
        const completedAt = previous?.status === "completed" ? String(previous.completedAt) : new Date().toISOString();
        await savePolicyCache(file, { status: "received", raw, completedAt });
        const parsed = await frameworkReview(raw, mode, config);
        await savePolicyCache(file, { status: "completed", raw, completedAt });
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
  async chatContext(run: Run, mode: PolicyMode, packetId: string, readRaw: (id: string) => Promise<unknown>) {
    const config = await this.required();
    const packet = run.source.find((p) => p.id === packetId);
    if (!packet || !run.items.some((item) => item.id === packetId && item.rawSaved))
      throw new LabError(404, "No saved CU result for this case.");
    const input = await this.input(run, packet, config, readRaw);
    const key = await this.key(config, mode, input.prompt, run);
    const saved = record(await loadPolicyCache(this.file(key)));
    if (saved?.status !== "completed") throw new LabError(409, "Run policy checks for this case and mode before chatting.");
    const parsed = await frameworkReview(saved.raw, mode, config);
    const agent = { ...this.agent(config, mode), lossState: input.lossState, policyScope: input.policyScope };
    return { contextId: digest(canonical({ key, agent })), packetId, mode, agent,
      prompt: input.prompt, ...parsed };
  }
  async followup(mode: PolicyMode, message: string, history: ChatMessage[], expectedAgent: PolicyContext) {
    const config = await this.required();
    const expected = this.agent(config, mode);
    if (expected.configurationHash !== expectedAgent.configurationHash || expected.mode !== expectedAgent.mode)
      throw new LabError(409, "Agent Framework configuration changed. Reload this chat.");
    const lossState = "lossState" in expectedAgent && typeof expectedAgent.lossState === "string" ? expectedAgent.lossState : null;
    const raw = await (this.frameworkDependencies.invoke ?? invokeFramework)({
      mode, prompt: message, history, lossState, policyScope: expectedAgent.policyScope, chat: true, configPath: this.configPath,
    });
    const value = parseFrameworkResult(raw, mode, config);
    const parsed = chatAnswerSchema.parse(value.result);
    verifyCitations(parsed.Citation, value);
    const [citations] = await resolveCitations({ Checks: [{ Citation: parsed.Citation }] });
    if (citations.some((citation) => !citation.href)) throw new LabError(502, "Unverified chat citation.");
    return { text: parsed.Answer, citations };
  }
}
