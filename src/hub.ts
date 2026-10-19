import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import type { TelegramProvider } from '@mastra/telegram';
import type { HubConfig } from './config.js';
import { createAssistantAgent, ASSISTANT_ID, type AssistantOptions } from './agents/assistant.js';
import { WorkingMemoryPrompt, createDbClient, createKv, createMemory, createStorage } from './memory.js';
import { createTelegramChannel, connectTelegram, type TelegramDeps } from './channels/telegram.js';
import type { KvStore } from './kv.js';
import { loadRegistry, parseRegistry } from './mcp/registry.js';
import { McpToolbox } from './mcp/toolbox.js';
import { NutritionTracker } from './mcp/nutrition.js';
import { trimForModel } from './mcp/trim.js';
import { createLogMeal } from './mcp/log-meal.js';
import { FINANCE_WRITES, FinanceDirectory } from './mcp/finance-cache.js';
import { ToolCallFilter } from '@mastra/core/processors';
import { Budget, BudgetGuard, BUDGET_MESSAGE } from './budget.js';
import { createGeminiModels, modelChain } from './models.js';
import { withMalformedFallback } from './llm/escalate.js';
import { createNotifier, type Notify } from './notify.js';
import { Digest, type DigestResult, type DigestSection } from './digest.js';
import { createDigestWorkflow } from './workflows/weekly-digest.js';
import { sendStartupPing, startHeartbeat } from './ops.js';
import { hostname } from 'node:os';
import { createVoice, personaPrompt } from './persona.js';
import { PlanStore } from './plans/store.js';
import { PlanService, planResultsPrompt } from './plans/service.js';
import { LogPlanPresenter, TelegramPlanPresenter } from './plans/presenter.js';
import { createProposePlanTool } from './plans/tool.js';
import { PlanGuard } from './plans/guard.js';
import { notSavedText, withFalseSaveGuard } from './guards/false-save.js';
import { addressOf } from './persona.js';
import { TelegramApi } from './telegram-api.js';
import { UsageLog, formatUsageReport, summarize as summarizeUsage } from './telemetry/usage-log.js';
import { createUsageObserver } from './telemetry/observe.js';
import { newRequestId, usageContext, withUsageScope } from './telemetry/context.js';
import type { Domain } from './telemetry/intent.js';
import { bogotaDay } from './budget.js';

export interface HubDeps {
  /** Test seam: model used by the assistant and reporter instead of Gemini. */
  model?: AssistantOptions['model'];
  /** Test seam: stronger model used when a response is malformed (defaults to `model`). */
  escalationModel?: unknown;
  telegram?: Omit<TelegramDeps, 'kv' | 'gate' | 'voice' | 'onPlanAction' | 'commands'>;
  /** Inline registry (tests); default: load config.mcpRegistryPath. */
  registry?: unknown;
  env?: Record<string, string | undefined>;
  /** Clock for budget/scheduling (tests). */
  now?: () => number;
  /** Per-app weekly digest sections (empty until the app forks provide them). */
  digestSections?: DigestSection[];
  /** healthchecks.io fetch (tests). */
  fetch?: typeof fetch;
  /** Gemini HTTP fetch (replay/tests): wrapped by the rate limiter and usage observer. */
  geminiFetch?: typeof fetch;
}

export interface Hub {
  mastra: Mastra;
  kv: KvStore;
  toolbox: McpToolbox;
  budget: Budget;
  digest: Digest;
  notify: Notify;
  telegram?: TelegramProvider;
  plans: PlanService;
  usage: UsageLog;
  /** The /usage report text. */
  usageReport(): Promise<string>;
  /**
   * Connect channels (network), catch up a missed digest, and (with `ops`) send the
   * "I'm up" ping and start the healthchecks.io heartbeat. Safe without Telegram.
   */
  start(opts?: { connectRetries?: number; ops?: boolean }): Promise<void>;
  /** Run the weekly-digest workflow now. */
  runDigest(input?: { trigger?: string; force?: boolean }): Promise<DigestResult | undefined>;
  stop(): Promise<void>;
}

/** Offset of `timezone` from UTC at `at`, in ms (Bogota: -5 h → -18_000_000). */
function tzOffsetMs(timezone: string, at: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(at).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(at / 1000) * 1000;
}

/** Keep only the app tools of the request's domains (fitness_*, finance_*); other tools stay. */
export function toolsForDomains<T>(tools: Record<string, T>, domains: readonly Domain[] | undefined): Record<string, T> {
  if (!domains) return tools;
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => {
      const d = name.startsWith('fitness_') ? 'fitness' : name.startsWith('finance_') ? 'finance' : undefined;
      return !d || domains.includes(d);
    }),
  );
}

/** Tell the user when an app comes back only after a real outage, not a blip. */
const RECOVERY_NOTICE_MS = 10 * 60_000;

const REPORTER_INSTRUCTIONS =
  "You write the user's periodic reports (finance, fitness, …) for Telegram. Be concise, concrete and friendly. Never invent numbers.";

/**
 * Build the hub from config. Every subsystem is created here so tests can build a hub
 * with a temp data dir and mocked dependencies.
 */
export function createHub(config: HubConfig, deps: HubDeps = {}): Hub {
  const log = deps.telegram?.log ?? ((m: string) => console.warn(m));
  const voice = createVoice(config.persona);
  const client = createDbClient(config);
  const storage = createStorage(config, client);
  const kv = createKv(client);
  const memory = createMemory(storage);
  const budget = new Budget(kv, config.budget, config.timezone, deps.now);
  const guard = new BudgetGuard(budget, (s) => log(`[budget] blocked: ${s.tokens} tokens, $${s.costUsd.toFixed(4)} on ${s.day}`));
  const registry = deps.registry !== undefined ? parseRegistry(deps.registry) : loadRegistry(config.mcpRegistryPath);
  const notify = createNotifier(config, { apiBaseUrl: deps.telegram?.apiBaseUrl, log });
  const nutrition = new NutritionTracker();
  const toolbox = new McpToolbox(registry, deps.env ?? process.env, {
    log,
    now: deps.now,
    hooks: {
      approval: (tool) => (tool === 'fitness_log_food' ? (input) => nutrition.needsConfirmation(input) : undefined),
      afterResult: (tool, input, result, { raw }) => {
        let out = result;
        if (tool.startsWith('fitness_')) {
          // guards see the FULL result, also for hub-internal calls (log_meal's drafts must be
          // priced, or its needs_confirmation → fitness_log_food path would skip the 800 kcal card)
          nutrition.recordResult(tool, input, result);
          if (tool === 'fitness_log_food') out = nutrition.annotateLog(input, result);
        }
        if (FINANCE_WRITES.has(tool)) financeDir.invalidate();
        return raw ? out : trimForModel(tool, out);
      },
    },
    onRecovered: (name, downForMs) => {
      log(`[mcp] ${name} is back after ${Math.round(downForMs / 60_000)} min`);
      if (downForMs > RECOVERY_NOTICE_MS) void notify(voice.back(name, Math.round(downForMs / 60_000)));
    },
  });

  const financeDir = new FinanceDirectory(toolbox, { now: deps.now, timezone: config.timezone, available: async () => (await toolbox.getTools(), toolbox.status().finance?.state === 'up') });
  const logMeal = createLogMeal(toolbox, log);
  const planStore = new PlanStore(kv, deps.now);
  const presenter = config.telegram.enabled
    ? new TelegramPlanPresenter(
        new TelegramApi(config.telegram.botToken, deps.telegram?.apiBaseUrl),
        config.telegram.allowedUserIds[0]!,
        config.persona.language,
        Math.round(planStore.ttlMs / 60_000),
        log,
      )
    : new LogPlanPresenter(config.persona.language, log);
  let summarizePlan: (prompt: string, memory?: { thread: string; resource: string }) => Promise<string> = async () => '';
  const plans = new PlanService({
    store: planStore,
    toolbox,
    presenter,
    voice,
    language: config.persona.language,
    allowedUserIds: config.telegram.allowedUserIds,
    log,
    summarize: (plan, results) =>
      summarizePlan(planResultsPrompt(plan, results), plan.threadId ? { thread: plan.threadId, resource: plan.owner } : undefined),
  });
  const proposePlan = createProposePlanTool(plans);

  const usage = new UsageLog(client, deps.now);
  const observe = createUsageObserver(usage, { now: deps.now, primaryModel: 'gemini-3.5-flash-lite', onError: (e) => log(`[usage] ${e.message}`) });
  const gemini = deps.model ? undefined : createGeminiModels(config.googleApiKey, log, observe, deps.geminiFetch);
  const notSaved = () => notSavedText(config.persona.language, config.persona.persona === 'alfred' ? addressOf(config.persona) : config.persona.ownerName);
  if (gemini) gemini.default = withFalseSaveGuard(withMalformedFallback(gemini.default, gemini.report, log), notSaved, log);
  const assistant = createAssistantAgent({
    timezone: config.timezone,
    model: deps.model ? withFalseSaveGuard(withMalformedFallback(deps.model, deps.escalationModel, log), notSaved, log) : modelChain('default', gemini!),
    memory,
    persona: config.persona,
    now: deps.now,
    tools: async () => {
      const app = toolsForDomains(await toolbox.getTools(), usageContext.getStore()?.domains);
      return { ...app, ...('fitness_log_food' in app ? { log_meal: logMeal } : {}), propose_plan: proposePlan };
    },
    extraInstructions: async () => {
      const domains = usageContext.getStore()?.domains;
      const fin = !domains || domains.includes('finance') ? await financeDir.prompt().catch(() => '') : '';
      return [toolbox.statusNote(), fin].filter(Boolean).join('\n');
    },
    guards: [guard],
    // Older turns keep their text but drop tool calls/results; the current run keeps all of them.
    inputGuards: [new WorkingMemoryPrompt(memory), new ToolCallFilter()],
    outputGuards: [new PlanGuard((t) => toolbox.isGated(t), log)],
  });
  summarizePlan = async (prompt, memory) => {
    const res = await assistant.generate(prompt, { ...(memory ? { memory } : {}), maxSteps: 1, toolChoice: 'none' } as never);
    return res.text;
  };
  const reporter = new Agent({
    id: 'reporter',
    name: 'Reporter',
    description: 'Writes the weekly digest on the stronger model',
    instructions: [REPORTER_INSTRUCTIONS, personaPrompt(config.persona)].filter(Boolean).join('\n\n'),
    model: (deps.model ?? modelChain('report', gemini!)) as never,
    inputProcessors: [guard],
    outputProcessors: [guard],
  });

  const digest = new Digest({
    kv,
    sections: deps.digestSections ?? [],
    compose: async (prompt) => (await reporter.generate(prompt)).text,
    notify,
    emptyText: voice.digestEmpty,
    timezone: config.timezone,
    now: deps.now,
    log,
  });
  const weeklyDigest = createDigestWorkflow(digest, config.timezone);

  const telegram = createTelegramChannel(config, {
    ...deps.telegram,
    kv,
    voice,
    gate: async () => ((await budget.check()).ok ? undefined : BUDGET_MESSAGE),
    onPlanAction: (actionId, userId) => plans.handleAction(actionId, userId),
    commands: { usage: () => usageReport() },
  });

  const mastra = new Mastra({
    storage,
    agents: { assistant, reporter },
    workflows: { weeklyDigest },
    ...(telegram ? { channels: { telegram } } : {}),
    server: { host: config.server.host, port: config.server.port },
  });

  async function usageReport(): Promise<string> {
    const now = (deps.now ?? Date.now)();
    const day = bogotaDay(now, config.timezone);
    const dayStart = Date.parse(`${day}T00:00:00Z`) - tzOffsetMs(config.timezone, now);
    const [today, week] = await Promise.all([usage.rows(dayStart), usage.rows(dayStart - 6 * 86_400_000)]);
    return formatUsageReport(summarizeUsage(today), summarizeUsage(week), config.persona.language);
  }

  async function runDigest(input: { trigger?: string; force?: boolean } = {}): Promise<DigestResult | undefined> {
    if (!usageContext.getStore()) {
      return withUsageScope({ requestId: newRequestId(), intent: 'digest', media: 'text', kind: 'digest' }, () => runDigest(input));
    }
    const run = await mastra.getWorkflow('weeklyDigest').createRun();
    const res = await run.start({ inputData: { trigger: input.trigger ?? 'manual', force: input.force ?? false } });
    if (res.status !== 'success') {
      log(`[digest] workflow ${res.status}${'error' in res && res.error ? `: ${String((res.error as Error).message ?? res.error)}` : ''}`);
      return undefined;
    }
    return res.result as DigestResult;
  }

  let heartbeat: { stop(): void } | undefined;

  return {
    mastra,
    kv,
    toolbox,
    budget,
    digest,
    notify,
    telegram,
    plans,
    usage,
    usageReport,
    runDigest,
    async start(opts = {}) {
      await toolbox.getTools(); // discover apps at boot so status is logged early
      if (opts.ops) toolbox.startBackgroundRetry();
      if (telegram && config.telegram.enabled) {
        await connectTelegram(telegram, ASSISTANT_ID, {
          botToken: config.telegram.botToken,
          retries: opts.connectRetries,
          log,
        });
      }
      try {
        if (await digest.isMissed()) await runDigest({ trigger: 'catch-up' });
      } catch (err) {
        log(`[digest] catch-up failed: ${(err as Error).message}`);
      }
      if (opts.ops) {
        await sendStartupPing({ kv, notify, text: voice.startup(hostname(), toolbox.status()) }).catch((err) =>
          log(`[ops] startup ping failed: ${(err as Error).message}`),
        );
        heartbeat = startHeartbeat({
          url: config.healthcheckUrl,
          fetch: deps.fetch,
          log,
          check: async () => {
            await client.execute('SELECT 1');
            return true;
          },
        });
      }
    },
    async stop() {
      heartbeat?.stop();
      await toolbox.close();
      if (!telegram) return;
      const install = await telegram.getInstallation(ASSISTANT_ID);
      if (install) await telegram.getAdapter(install.id)?.stopPolling();
    },
  };
}
