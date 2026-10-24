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
import { createLogMeal, fixLoggedServings } from './mcp/log-meal.js';
import { createClearDay } from './mcp/clear-day.js';
import { createAdjustBalances } from './mcp/adjust-balances.js';
import { FINANCE_WRITES, FinanceDirectory, moneyNeedsApproval } from './mcp/finance-cache.js';
import { ToolCallFilter } from '@mastra/core/processors';
import { Budget, BudgetGuard } from './budget.js';
import { createGeminiModels, modelChain, PROVIDER_OPTIONS } from './models.js';
import type { Pacer } from './llm/pacer.js';
import { createTranscriber } from './voice/transcribe.js';
import { mealHint } from './meal.js';
import { checkDate, sanitizeFilters, sanitizeRange } from './cines/args.js';
import { withEvidenceGuard } from './guards/evidence.js';
import { StatusMessages, toPlain } from './status/messages.js';
import { appName, appOfTool, errorOf, explain } from './status/errors.js';
import { StatusRunEnd, StatusTracker } from './status/tracker.js';
import { formatEstado, recentFailures, recordFailure } from './status/estado.js';
import { hubVersion } from './version.js';
import { CinesHub, type PendingSecure } from './cines/service.js';
import { cinesApprovalCard } from './cines/card.js';
import { genericApprovalCard } from './status/approval-card.js';
import { HOLD_TOOL, HUB_ONLY_TOOLS, MONEY_TOOLS, PURCHASE_TOOL } from './cines/contract.js';
import { withMalformedFallback } from './llm/escalate.js';
import { createNotifier, type Notify } from './notify.js';
import { Digest, type DigestResult, type DigestSection } from './digest.js';
import { createDigestWorkflow } from './workflows/weekly-digest.js';
import { sendStartupPing, startHeartbeat } from './ops.js';
import { createVoice, personaPrompt } from './persona.js';
import { PlanStore } from './plans/store.js';
import { PlanService, planResultsPrompt } from './plans/service.js';
import { LogPlanPresenter, TelegramPlanPresenter } from './plans/presenter.js';
import { createProposePlanTool } from './plans/tool.js';
import { PlanGuard } from './plans/guard.js';
import { notSavedText, withFalseSaveGuard } from './guards/false-save.js';
import { withLeakGuard } from './guards/leak.js';
import { withAddressFix } from './guards/address.js';
import { loadProfile } from './nutrition/profile.js';
import { FoodBook } from './nutrition/book.js';
import { DayPlanner, dayTypeFromText, targetsNote, type CalendarDayType } from './nutrition/day.js';
import { contextFor } from './nutrition/context.js';
import { DECOMPOSITION, STYLE_RULES, dictionaryPrompt } from './nutrition/prompt.js';
import { createSaveFood, createSetDayType } from './nutrition/tools.js';
import { addressOf } from './persona.js';
import { TelegramApi } from './telegram-api.js';
import { UsageLog, formatUsageReport, summarize as summarizeUsage } from './telemetry/usage-log.js';
import { createUsageObserver } from './telemetry/observe.js';
import { newRequestId, usageContext, withUsageScope } from './telemetry/context.js';
import type { Domain } from './telemetry/intent.js';
import { RequestTimer, TimingLog, instrumentTelegramFetch, timingLine } from './telemetry/timing.js';
import { formatVelocidad } from './status/velocidad.js';
import { bogotaDay } from './budget.js';

export interface HubDeps {
  /** Test seam: model used by the assistant and reporter instead of Gemini. */
  model?: AssistantOptions['model'];
  /** Test seam: stronger model used when a response is malformed (defaults to `model`). */
  escalationModel?: unknown;
  telegram?: Omit<TelegramDeps, 'kv' | 'gate' | 'voice' | 'onPlanAction' | 'commands' | 'transcribe' | 'approvalCard' | 'secureInput' | 'preAgent'>;
  /** Status message timings (tests). */
  statusTimings?: { workingAfterMs?: number; slowAfterMs?: number; minEditGapMs?: number };
  /** Inline registry (tests); default: load config.mcpRegistryPath. */
  registry?: unknown;
  env?: Record<string, string | undefined>;
  /** Clock for budget/scheduling (tests). */
  now?: () => number;
  /** Per-app weekly digest sections (empty until the app forks provide them). */
  digestSections?: DigestSection[];
  /** healthchecks.io fetch (tests). */
  fetch?: typeof fetch;
  /** Test seam: model that transcribes voice notes (default: Gemini flash-lite; none with `model`). */
  transcribeModel?: unknown;
  /** Clock for the local time in the prompt and the meal-by-hour fallback (replay pins it). */
  localNow?: () => number;
  /** Poll interval for an in-progress Cinépolis purchase (tests; default 10 s). */
  cinesPollMs?: number;
  /** fetch for cines images (tests). */
  cinesFetch?: typeof fetch;
  /** Client-side pacer for Gemini (debug runs pace well below the free tier). */
  geminiPacer?: Pacer;
  /**
   * Debug entry point (src/debug): writes are blocked unless the current request allows them;
   * cines_purchase is never allowed.
   */
  debug?: { allowWrites(): boolean };
  /** Gemini HTTP fetch (replay/tests): wrapped by the rate limiter and usage observer. */
  geminiFetch?: typeof fetch;
  /** Hook for a future Calendar MCP: is a date a training day? (told by the user wins). */
  calendarDayType?: CalendarDayType;
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
  cines: CinesHub;
  /** Requests still running (their status message not closed yet). */
  openRequests(): number;
  usage: UsageLog;
  /** Per-request wall-clock spans (request_timings / request_spans). */
  timings: TimingLog;
  /** The /velocidad report text. */
  velocidadReport(): Promise<string>;
  /** The /usage report text. */
  usageReport(): Promise<string>;
  /**
   * Connect channels (network), catch up a missed digest, and (with `ops`) send the
   * "I'm up" ping and start the healthchecks.io heartbeat. Safe without Telegram.
   */
  start(opts?: { connectRetries?: number; ops?: boolean; catchUp?: boolean }): Promise<void>;
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
      const d = name.startsWith('fitness_') ? 'fitness' : name.startsWith('finance_') ? 'finance' : name.startsWith('cines_') ? 'cines' : undefined;
      return !d || domains.includes(d);
    }),
  );
}

/** Tools that only read (no "✅ done" for them). Everything else from an app is a write. */
const READ_TOOLS = /^(updateWorkingMemory$|propose_plan$|clear_day$|adjust_balances$|save_food$|set_day_type$|fitness_(get|search|draft|list|bulk)_|finance_(list|spending|convert|get)_|cines_(list_|listings|find|showtimes|best|upcoming|seat_map|validate|hold_status))/;

/** Tools the hub itself provides to the agent. */
const LOCAL_TOOLS: ReadonlySet<string> = new Set(['log_meal', 'clear_day', 'propose_plan', 'updateWorkingMemory', 'request_secure_input', 'save_food', 'set_day_type', 'adjust_balances']);

/** An argument the model left as a placeholder ("...", "<showtimeId>", "xxx"): the field name, or undefined. */
export function placeholderArg(args: Record<string, unknown>): string | undefined {
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v === 'string' && /^\s*(?:\.{2,}|…|<[^>]*>|\{[^}]*\}|x{3,}|placeholder|id_here|tbd|todo)\s*$/i.test(v)) return `${k}="${v}"`;
  }
  return undefined;
}

/** Finance tools that take accountId + pocketId: the hub fills accountId from the pocket. */
const POCKET_TOOLS: ReadonlySet<string> = new Set(['finance_create_movement', 'finance_update_movement']);
/** A balance correction ("Ajuste de saldo …"): only through adjust_balances (one approval card). */
const ADJUSTMENT = /\b(ajuste de saldo|ajuste del saldo|ajustar saldo|balance adjust|balance correction)/i;

/** accountId becomes optional in the schema (shown to the model and validated) when pocketId exists. */
export function optionalAccountId(s: Record<string, unknown>): Record<string, unknown> {
  const props = s.properties as Record<string, unknown> | undefined;
  if (!props?.pocketId || !Array.isArray(s.required)) return s;
  return { ...s, required: (s.required as string[]).filter((r) => r !== 'accountId') };
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
  const baseLog = deps.telegram?.log ?? ((m: string) => console.warn(m));
  // every log line inside a request carries its id (the one the user sees as `req 7f3a2c`)
  const log = (m: string) => {
    const id = usageContext.getStore()?.requestId;
    baseLog(id && id !== 'none' ? `[req ${id}] ${m}` : m);
  };
  const voice = createVoice(config.persona);
  /** Requests whose status message is still open (debug entry point waits for 0). */
  let openRequests = 0;
  const openByChat = new Map<string, number>();
  const msgs = new StatusMessages(config.persona);
  const version = hubVersion(deps.env ?? process.env);
  const client = createDbClient(config);
  const storage = createStorage(config, client);
  const kv = createKv(client);
  const memory = createMemory(storage);
  const budget = new Budget(kv, config.budget, config.timezone, deps.now);
  const guard = new BudgetGuard(
    budget,
    (s) => log(`[budget] blocked: ${s.tokens} tokens, $${s.costUsd.toFixed(4)} on ${s.day}`),
    () => toPlain(msgs.budget(usageContext.getStore()?.requestId)),
  );
  const registry = deps.registry !== undefined ? parseRegistry(deps.registry) : loadRegistry(config.mcpRegistryPath);
  const notify = createNotifier(config, { apiBaseUrl: deps.telegram?.apiBaseUrl, log });
  const nutrition = new NutritionTracker();
  const tgApi = config.telegram.enabled ? new TelegramApi(config.telegram.botToken, deps.telegram?.apiBaseUrl) : undefined;
  // assigned right after the toolbox exists (they reference each other)
  // eslint-disable-next-line prefer-const
  let cines: CinesHub | undefined;
  const toolbox = new McpToolbox(registry, deps.env ?? process.env, {
    log,
    now: deps.now,
    hooks: {
      approval: (tool) =>
        tool === 'fitness_log_food'
          ? // priced AFTER the grams-as-quantity fix (else a 166 g pick looked like 166 servings: a bogus card)
            (input) => nutrition.needsConfirmation(fixLoggedServings(input) ?? input)
          : tool === 'finance_create_transfer' || tool === 'finance_create_movement'
            ? // every transfer, big movements, and "retirar/eliminar X" get a card (expense vs transfer is on it)
              // (a same-pocket transfer gets no card: beforeCall sends it back to the model first)
              async (input) => !(tool === 'finance_create_transfer' && input.sourcePocketId && input.sourcePocketId === input.targetPocketId) && (await financeDir.prompt().catch(() => ''), moneyNeedsApproval(tool, input, (id) => financeDir.currencyOf(id), usageContext.getStore()?.text))
            : undefined,
      approvalOverride: (tool) =>
        tool === PURCHASE_TOOL
          ? (input) => cines!.purchaseNeedsApproval(input)
          : tool === HOLD_TOOL
            ? // seats checked (and the showtime fixed) BEFORE the card; a hold that cannot work gets no card
              async (input) => !('error' in (await cines!.prepareHold(usageContext.getStore()?.chatId ?? 'local', input, usageContext.getStore()?.text)))
            : undefined,
      beforeCall: (tool, given) => {
        if (deps.debug) {
          const refuse = (m: string) => Promise.resolve({ error: { error: { code: 'DEBUG_READ_ONLY', message: m, retryable: false } } });
          if (tool === PURCHASE_TOOL) return refuse('cines_purchase is never allowed from the debug entry point.');
          if (isWrite(tool) && tool !== 'log_meal' && tool !== 'clear_day' && !deps.debug.allowWrites()) {
            log(`[debug] blocked write ${tool} (read-only; pass allowWrites)`);
            return refuse(`${tool} is a write and this debug request is read-only (allowWrites:false). Nothing was changed.`);
          }
        }
        const ph = placeholderArg(given);
        // errors about the MODEL's own arguments (placeholders, wrong years): for the model only
        const invalid = (message: string) => Promise.resolve({ error: { error: { code: 'MODEL_ARG', message, retryable: false } } });
        if (ph) return invalid(`${ph} is a placeholder, not a real value. Copy the real value verbatim from the latest tool result (never invent ids).`);
        let input = given;
        if (tool.startsWith('cines_')) {
          // dates resolved/checked by the hub; filters the user did not ask for dropped
          const d = checkDate(input.date, config.timezone, localNow());
          if (d && 'error' in d) {
            log(`[cines] refused date ${String(input.date)} for ${tool}`);
            return invalid(d.error);
          }
          if (d) input = { ...input, date: d.date };
          const r = sanitizeRange(tool, input, usageContext.getStore()?.text, config.timezone, localNow());
          if (r.error) {
            log(`[cines] refused dateTo ${String(input.dateTo)} for ${tool}`);
            return invalid(r.error);
          }
          if (r.changes.length) log(`[cines] ${tool}: ${r.changes.join('; ')}`);
          input = r.args;
          const f = sanitizeFilters(tool, input, usageContext.getStore()?.text);
          if (f.dropped.length) log(`[cines] ${tool}: dropped filters the user did not ask for (${f.dropped.join(', ')})`);
          input = f.args;
        }
        if (MONEY_TOOLS.has(tool) || tool === 'cines_validate_seats' || tool === 'cines_seat_map') return cines!.beforeCall(tool, input, { chatId: usageContext.getStore()?.chatId });
        if (tool === 'finance_create_movement' && usageContext.getStore()?.kind !== 'plan' && ADJUSTMENT.test(String(input.notes ?? ''))) {
          log('[finance] balance adjustment outside adjust_balances: sent back');
          return invalid('Balance adjustments are recorded with adjust_balances (one approval card with current → new for every pocket), not finance_create_movement. Call adjust_balances once with every pocket and its new balance (or delta).');
        }
        if (POCKET_TOOLS.has(tool)) return withOwningAccount(tool, input);
        if (tool === 'finance_create_transfer' && input.sourcePocketId && input.sourcePocketId === input.targetPocketId) {
          log('[finance] transfer to the same pocket: sent back');
          return Promise.resolve({ error: { error: { code: 'VALIDATION_ERROR', message: `source and target are the same pocket (${financeDir.label(input.sourcePocketId) ?? String(input.sourcePocketId)}). Use the pocket the user named as each side.`, retryable: false } } });
        }
        if (tool === 'fitness_log_food') {
          const fixed = fixLoggedServings(input);
          if (fixed) {
            log(`[log_meal] fitness_log_food quantity ${String(input.quantity)} was the user's grams; logged ${String(fixed.quantity)} servings`);
            return Promise.resolve({ args: fixed });
          }
        }
        return input === given ? undefined : Promise.resolve({ args: input });
      },
      // a hold/purchase that timed out may have happened at Cinépolis: poll for the outcome
      onCallError: (tool) => (MONEY_TOOLS.has(tool) ? { status: 'in_progress', jobId: '', transport: true } : undefined),
      // the hub fills accountId from the pocket, so the model may omit it
      schema: (tool, s) => (POCKET_TOOLS.has(tool) ? optionalAccountId(s) : s),
      afterResult: (tool, input, result, { raw }) => {
        let out = result;
        if (tool.startsWith('fitness_')) {
          // guards see the FULL result, also for hub-internal calls (log_meal's drafts must be
          // priced, or its needs_confirmation → fitness_log_food path would skip the 800 kcal card)
          nutrition.recordResult(tool, input, result);
          if (tool === 'fitness_log_food') out = nutrition.annotateLog(input, result);
        }
        if (FINANCE_WRITES.has(tool)) financeDir.invalidate();
        if (raw) return out;
        // a failure carries the cause the user will see in the status line: the model must use
        // it, not invent another ("la función ya no está disponible" for a wrong id)
        const withCause = (v: unknown) => {
          const e = errorOf(v);
          if (!e) return v;
          const x = explain(e.code, e.message, config.persona.language, appName(appOfTool(tool), config.persona.language));
          return { ...(v as object), user_message: `${x.cause}. ${x.action}`, note: 'Tell the user exactly this cause (user_message), briefly. Do not guess another reason.' };
        };
        if (tool.startsWith('cines_')) return Promise.resolve(cines!.afterResult(tool, input, out, { chatId: usageContext.getStore()?.chatId, userText: usageContext.getStore()?.text })).then(withCause);
        return withCause(trimForModel(tool, out));
      },
    },
    onRecovered: (name, downForMs) => {
      log(`[mcp] ${name} is back after ${Math.round(downForMs / 60_000)} min`);
      if (downForMs > RECOVERY_NOTICE_MS) void notify(toPlain(msgs.serviceBack(name, downForMs)));
    },
    onDownLong: (name, downForMs) => {
      log(`[mcp] ${name} down for ${Math.round(downForMs / 60_000)} min`);
      void notify(toPlain(msgs.serviceDown(name, downForMs)));
    },
    longDownMs: RECOVERY_NOTICE_MS,
  });

  cines = new CinesHub({
    kv,
    toolbox,
    log,
    now: deps.now,
    fetch: deps.cinesFetch,
    securePrompt: (kind, details) => voice.securePrompt(kind, details),
    secureBadFormat: (kind) => voice.secureBadFormat(kind),
    secureExpired: () => voice.secureExpired(),
    dryRun: config.cinesDryRun,
    paypalWaitMin: Number((deps.env ?? process.env).CINES_PAYPAL_WAIT_MIN ?? 15) || 15,
    pollMs: deps.cinesPollMs,
    holdPollMs: deps.cinesPollMs,
    holdWaitText: () => (config.persona.language === 'es' ? '⏳ Apartando en Cinépolis…' : '⏳ Holding the seats at Cinépolis…'),
    paypalWaitText: () => msgs.paypalWait(),
    seatInvalidText: (seats, reason) => msgs.seatInvalid(seats, reason),
    working: (text) => usageContext.getStore()?.status?.setActivity(text),
    lang: config.persona.language,
    autoBuy: (chatId: string, holdId: string) => cinesCard(`cines:b:${holdId}`, chatId),
    ...(tgApi
      ? {
          sendCard: (chatId: string, text: string, keyboard: { text: string; callback_data: string }[][]) => tgApi.send(chatId, text, keyboard),
          editCard: (chatId: string, id: number, text: string, keyboard?: { text: string; callback_data: string }[][]) => tgApi.editKeyboard(chatId, id, text, keyboard),
          sendPhoto: (chatId: string, bytes: Uint8Array) => tgApi.sendPhoto(chatId, bytes),
          sendText: async (chatId: string, text: string) => void (await tgApi.send(chatId, text)),
        }
      : {}),
  });
  const cinesHub = cines;
  const withOwningAccount = async (tool: string, input: Record<string, unknown>): Promise<{ args: Record<string, unknown> } | { error: unknown }> => {
    // account → pocket → sub-pocket checked against the cache before the server sees it
    const r = await financeDir.repairPocket(input);
    if ('error' in r) {
      log(`[finance] ${tool}: pocketId is not a pocket; sent back to the model with the pocket list`);
      return { error: { error: { code: 'VALIDATION_ERROR', message: r.error, retryable: false } } };
    }
    if (r.fixed) log(`[finance] ${tool}: ${r.fixed}`);
    const args = r.args;
    if (args.accountId || tool !== 'finance_create_movement') return { args };
    return { error: { error: { code: 'VALIDATION_ERROR', message: 'accountId is required: use the accountId listed with the pocket under "## Now" (or pass a pocketId of that account).', retryable: false } } };
  };
  const isWrite = (tool: string) => tool === 'log_meal' || (!READ_TOOLS.test(tool) && !/workingmemory/i.test(tool) && toolbox.annotationsFor(tool)?.readOnlyHint !== true);
  const financeDir: FinanceDirectory = new FinanceDirectory(toolbox, { now: deps.now, timezone: config.timezone, available: async () => (await toolbox.getTools(), toolbox.status().finance?.state === 'up') });
  const localNow = deps.localNow ?? deps.now ?? Date.now;
  // nutrition brain: private profile (never logged), dictionary + recipes, day targets
  const profile = loadProfile(config.nutritionProfilePath, log);
  const book = new FoodBook(profile, kv);
  const planner = profile ? new DayPlanner(profile, kv, { calendar: deps.calendarDayType }) : undefined;
  const today = () => bogotaDay(localNow(), config.timezone);
  const logMeal = createLogMeal(toolbox, log, {
    mealHint: (date) => mealHint(usageContext.getStore()?.text, { date, timezone: config.timezone, now: localNow() }),
    ...(profile ? { nutrition: { book, planner, defaults: profile.defaults, userText: () => usageContext.getStore()?.text, today } } : {}),
  });
  const nutritionTools: Record<string, ReturnType<typeof createSaveFood> | ReturnType<typeof createSetDayType>> = profile && planner ? { save_food: createSaveFood(book, log), set_day_type: createSetDayType(planner, today) } : {};
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
    // a plan may re-add foods after a clear (clear_day then_log)
    localTools: { log_meal: (args) => (logMeal as unknown as { execute(i: unknown, c: unknown): Promise<unknown> }).execute(args, {}) },
    summarize: (plan, results) =>
      summarizePlan(planResultsPrompt(plan, results), plan.threadId ? { thread: plan.threadId, resource: plan.owner } : undefined),
  });
  const proposePlan = createProposePlanTool(plans);
  const adjustBalances = createAdjustBalances({ directory: financeDir, propose: (input, meta) => plans.propose(input, meta), today: () => bogotaDay(localNow(), config.timezone), language: config.persona.language, log });
  const clearDay = createClearDay({
    toolbox,
    propose: (input, meta) => plans.propose(input, meta),
    today: () => bogotaDay(localNow(), config.timezone),
    language: config.persona.language,
    log,
  });

  const usage = new UsageLog(client, deps.now);
  // where each request's wall-clock goes: spans from every layer, one row per request
  instrumentTelegramFetch();
  const timings = new TimingLog(client);
  const newTimer = (requestId: string, startedAt?: number) => {
    const timer = new RequestTimer(requestId, {
      startedAt,
      onEnd: (t) => {
        baseLog(`[req ${requestId}] ${timingLine(t)}`);
        void timings.record(t).catch((e: Error) => baseLog(`[timing] ${e.message}`));
      },
    });
    return { timer, close: () => void timer.end() };
  };
  const observe = createUsageObserver(usage, { now: deps.now, primaryModel: 'gemini-3.5-flash-lite', onError: (e) => log(`[usage] ${e.message}`) });
  if (!deps.model) log(`[models] Gemini key from ${config.modelKeySource}${config.modelKeySource === 'DEV_GOOGLE_API_KEY' ? ' (dev project)' : ''}`);
  const gemini = deps.model ? undefined : createGeminiModels(config.googleApiKey, log, observe, deps.geminiFetch, deps.geminiPacer);
  const transcribeModel = deps.transcribeModel ?? gemini?.default;
  const transcribe = transcribeModel ? createTranscriber(transcribeModel, { providerOptions: PROVIDER_OPTIONS.default, log, record: (id, u) => budget.record(id, u) }) : undefined;
  const notSaved = () => notSavedText(config.persona.language, config.persona.persona === 'alfred' ? addressOf(config.persona) : config.persona.ownerName);
  const address = addressOf(config.persona);
  const fixAddress = (m: unknown) => (config.persona.persona === 'alfred' ? withAddressFix(m, address, log) : m);
  if (gemini) gemini.default = fixAddress(withFalseSaveGuard(withEvidenceGuard(withLeakGuard(withMalformedFallback(gemini.default, gemini.report, log), log), log), notSaved, log)) as typeof gemini.default;
  const assistant = createAssistantAgent({
    timezone: config.timezone,
    model: deps.model ? fixAddress(withFalseSaveGuard(withEvidenceGuard(withLeakGuard(withMalformedFallback(deps.model, deps.escalationModel, log), log), log), notSaved, log)) : modelChain('default', gemini!),
    memory,
    persona: config.persona,
    now: localNow,
    tools: async () => {
      const all = Object.fromEntries(Object.entries(await toolbox.getTools()).filter(([n]) => !HUB_ONLY_TOOLS.has(n)));
      const app = toolsForDomains(all, usageContext.getStore()?.domains);
      return { ...app, ...('fitness_log_food' in app ? { log_meal: logMeal, clear_day: clearDay, ...nutritionTools } : {}), ...('finance_create_movement' in app ? { adjust_balances: adjustBalances } : {}), propose_plan: proposePlan };
    },
    // nutrition style + decomposition rules + the user's dictionary: stable, with the fitness rules
    domainPrompt: async (domains) => (profile && domains.includes('fitness') ? [...STYLE_RULES, '', ...DECOMPOSITION, '', await dictionaryPrompt(book)].join('\n') : ''),
    extraInstructions: async () => {
      const store = usageContext.getStore();
      const domains = store?.domains;
      const fin = !domains || domains.includes('finance') ? await financeDir.prompt().catch(() => '') : '';
      let food = '';
      if (profile && planner && (!domains || domains.includes('fitness'))) {
        // "hoy tengo gimnasia" / "hoy no entreno": remembered for today without a tool call
        const said = dayTypeFromText(store?.text);
        if (said) await planner.set(today(), said);
        food = [await targetsNote(planner, profile, today()).catch(() => ''), contextFor(profile, store?.text)].filter(Boolean).join('\n');
      }
      return [toolbox.statusNote(), fin, food].filter(Boolean).join('\n');
    },
    guards: [guard],
    // Older turns keep their text but drop tool calls/results; the current run keeps all of them.
    inputGuards: [new WorkingMemoryPrompt(memory), new ToolCallFilter()],
    outputGuards: [new PlanGuard((t) => toolbox.isGated(t) && !MONEY_TOOLS.has(t), log), new StatusRunEnd(() => usageContext.getStore()?.status) as never],
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

  const makeTracker = tgApi
      ? (chatId: string, requestId: string) => {
          openRequests++;
          openByChat.set(chatId, (openByChat.get(chatId) ?? 0) + 1);
          return new StatusTracker({
            onFinish: () => {
              openRequests = Math.max(0, openRequests - 1);
              openByChat.set(chatId, Math.max(0, (openByChat.get(chatId) ?? 1) - 1));
            },
            api: {
              send: (c, html) => tgApi.sendHtml(c, html),
              edit: (c, id, html) => tgApi.editHtml(c, id, html),
              remove: (c, id) => tgApi.remove(c, id),
            },
            chatId,
            requestId,
            msgs,
            isWrite,
            isKnown: (t) => LOCAL_TOOLS.has(t) || toolbox.knownTool(t),
            log,
            now: deps.now,
            onFailure: (f) => recordFailure(kv, f),
            ...(deps.statusTimings ?? {}),
          });
        }
      : undefined;

  const telegram = createTelegramChannel(config, {
    ...deps.telegram,
    kv,
    voice,
    gate: async (requestId) => ((await budget.check()).ok ? undefined : toPlain(msgs.budget(requestId))),
    status: makeTracker,
    onPlanAction: (actionId, userId) => plans.handleAction(actionId, userId),
    onCinesAction: (actionId, chatId) => cinesCard(actionId, chatId),
    commands: { usage: () => usageReport(), estado: () => estadoReport(), velocidad: () => velocidadReport() },
    timer: newTimer,
    transcribe,
    approvalCard: (event) => {
      if (event.kind === 'approval') log(`[approval] card: ${event.toolName}`);
      return cinesApprovalCard(event, cinesHub, config.persona.language) ?? genericApprovalCard(event, config.persona.language, { kcal: (a) => nutrition.estimateLogKcal(fixLoggedServings(a) ?? a), label: (id) => financeDir.label(id) });
    },
    // a pick typed while the seat-map run is still open waits for it (the map is remembered as
    // soon as cines_seat_map returns; the wait covers a pick sent before that)
    preAgent: (chatId, text) => cinesHub.seatPick(chatId, text, { othersRunning: () => (openByChat.get(chatId) ?? 0) > 1 }),
    secureInput: {
      pending: (chatId) => cinesHub.pending(chatId),
      cancel: (chatId) => cinesHub.cancelSecure(chatId),
      looksLikeSecret: (kind, text) => cinesHub.looksLikeSecret(kind, text),
      deliver: (chatId, value, p) => (p.purpose === 'payment' ? securePayment(chatId, value, p) : cinesHub.deliver(chatId, value, p)),
    },
  });

  const mastra = new Mastra({
    storage,
    agents: { assistant, reporter },
    workflows: { weeklyDigest },
    ...(telegram ? { channels: { telegram } } : {}),
    server: { host: config.server.host, port: config.server.port },
  });

  /** Purchase-card button (or auto-purchase): run it with its own live status message. */
  async function cinesCard(actionId: string, chatId: string): Promise<void> {
    const m = actionId.match(/^cines:([br]):(.+)$/);
    if (!m) return;
    const holdId = m[2]!;
    const requestId = newRequestId();
    const tracker = makeTracker?.(chatId, requestId);
    const timing = newTimer(requestId);
    await withUsageScope({ requestId, intent: 'cines', media: 'text', kind: 'resume', chatId, domains: ['cines'], status: tracker, timer: timing.timer }, async () => {
      timing.timer.bindScope(usageContext.getStore()!);
      tracker?.start();
      const tool = m[1] === 'b' ? PURCHASE_TOOL : 'cines_release_hold';
      log(`[cines] purchase card: ${m[1] === 'b' ? 'Comprar' : 'Cancelar'} ${holdId}`);
      const r = m[1] === 'b' ? await cinesHub.buyFromCard(holdId) : await cinesHub.releaseFromCard(holdId);
      if (r !== undefined) tracker?.onToolEvent({ kind: 'result', toolCallId: `card-${requestId}`, toolName: tool, displayName: tool, argsSummary: '', args: { holdId }, result: r, resultText: '', durationMs: 0, isError: false });
      await tracker?.finish();
      timing.close();
    });
  }

  /**
   * The user's CVV / arming PIN / bank code for a purchase: delivered by the hub, and the outcome
   * (paid, failed, unknown, the next secret) reported by its own status message, like a purchase
   * card button. The model is not called (the secret never reaches it either way).
   */
  async function securePayment(chatId: string, value: string, p: PendingSecure): Promise<{ agentText?: string; userText?: string }> {
    const requestId = newRequestId();
    const tracker = makeTracker?.(chatId, requestId);
    const timing = newTimer(requestId);
    return withUsageScope({ requestId, intent: 'cines', media: 'text', kind: 'resume', chatId, domains: ['cines'], status: tracker, timer: timing.timer }, async () => {
      timing.timer.bindScope(usageContext.getStore()!);
      tracker?.start();
      log(`[cines] secure ${p.kind} for ${p.holdId ?? 'a purchase'}`);
      const es = config.persona.language === 'es';
      // say what is happening right away (the charge / PIN check can take a while); always closed below
      tracker?.setActivity(p.kind === 'arm_pin' ? (es ? '⏳ Verificando su PIN…' : '⏳ Checking your PIN…') : p.kind === 'cvv' ? (es ? '⏳ Pagando con su tarjeta en Cinépolis…' : '⏳ Paying with your card at Cinépolis…') : es ? '⏳ Enviando el código…' : '⏳ Sending the code…');
      const r = await cinesHub.deliver(chatId, value, p);
      const res = r.payment?.result as Record<string, unknown> | undefined;
      // only a settled purchase is reported here; a next secret / a background job reports itself
      const settled = !!res && (res.status === 'paid' || !!res.error);
      if (!settled && res && p.kind === 'arm_pin' && /^(waiting_for_secure_input|needs_)/.test(String(res.status ?? ''))) {
        tracker?.setNote(es ? '✅ PIN correcto' : '✅ PIN accepted');
      }
      if (settled) tracker?.onToolEvent({ kind: 'result', toolCallId: `secure-${requestId}`, toolName: PURCHASE_TOOL, displayName: PURCHASE_TOOL, argsSummary: '', args: { holdId: p.holdId }, result: res, resultText: '', durationMs: 0, isError: false });
      await tracker?.finish();
      timing.close();
      return { userText: r.userText, agentText: r.payment ? undefined : r.agentText };
    });
  }

  async function estadoReport(): Promise<string> {
    const now = (deps.now ?? Date.now)();
    const day = bogotaDay(now, config.timezone);
    const dayStart = Date.parse(`${day}T00:00:00Z`) - tzOffsetMs(config.timezone, now);
    const [today, b, failures] = await Promise.all([usage.rows(dayStart), budget.check(), recentFailures(kv, 3)]);
    return formatEstado({
      lang: config.persona.language,
      version,
      now,
      timezone: config.timezone,
      services: toolbox.statusDetail(),
      today,
      budget: { tokens: b.tokens, costUsd: b.costUsd, tokenCap: config.budget.dailyTokenCap, costCapUsd: config.budget.dailyCostCapUsd },
      failures,
    });
  }

  async function velocidadReport(): Promise<string> {
    const now = Date.now();
    const week = (await timings.rows(now - 7 * 86_400_000)).filter((r) => r.kind !== 'digest');
    return formatVelocidad({
      lang: config.persona.language,
      address: config.persona.persona === 'alfred' ? addressOf(config.persona) : config.persona.ownerName,
      timezone: config.timezone,
      day: week.filter((r) => r.ts >= now - 86_400_000),
      week,
    });
  }

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
    cines: cinesHub,
    openRequests: () => openRequests,
    usage,
    timings,
    velocidadReport,
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
        if (opts.catchUp !== false && (await digest.isMissed())) await runDigest({ trigger: 'catch-up' });
      } catch (err) {
        log(`[digest] catch-up failed: ${(err as Error).message}`);
      }
      if (opts.ops) {
        await sendStartupPing({ kv, notify, version, text: toPlain(msgs.restart(version, toolbox.status())) }).catch((err) =>
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
