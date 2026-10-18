import type { Processor, ProcessInputStepArgs, ProcessOutputStepArgs } from '@mastra/core/processors';
import type { KvStore } from './kv.js';

export const BUDGET_MESSAGE =
  '⏸️ Paused, budget hit: the daily model budget is used up. I will be back after midnight (Bogotá time).';

/**
 * Estimated USD per 1M tokens. The prepaid Gemini balance is the hard stop; this is the
 * soft daily cap so a loop can't burn the whole balance in one day. Keep these slightly
 * pessimistic. `from` = effective date (ms since epoch, UTC).
 */
const PRICES: { match: RegExp; from: number; input: number; output: number }[] = [
  { match: /gemini-3\.5-flash-lite/, from: 0, input: 0.1, output: 0.4 },
  { match: /gemini-3\.5-transcribe/, from: 0, input: 0.5, output: 1.0 },
  { match: /gemini-3\.8-flash/, from: 0, input: 0.3, output: 2.5 },
  { match: /gemini-3\.8-flash/, from: Date.parse('2027-01-01T00:00:00Z'), input: 0.6, output: 5.0 },
];

export interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

function priceFor(modelId: string, at: number) {
  const candidates = PRICES.filter((p) => p.match.test(modelId) && p.from <= at).sort((a, b) => b.from - a.from);
  if (candidates[0]) return candidates[0];
  // Unknown model: assume the most expensive price we know so we never under-count.
  const max = PRICES.filter((p) => p.from <= at).reduce((a, b) => (b.input + b.output > a.input + a.output ? b : a));
  return max;
}

export function estimateCostUsd(modelId: string, usage: UsageLike, at: number): number {
  const p = priceFor(modelId, at);
  return ((usage.inputTokens ?? 0) * p.input + (usage.outputTokens ?? 0) * p.output) / 1_000_000;
}

/** Calendar day (YYYY-MM-DD) in the hub's timezone. */
export function bogotaDay(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export interface BudgetStatus {
  ok: boolean;
  day: string;
  tokens: number;
  costUsd: number;
  reason?: 'tokens' | 'cost';
}

const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

/** Daily token + estimated-cost counters in LibSQL, reset at local midnight. */
export class Budget {
  constructor(
    private readonly kv: KvStore,
    private readonly caps: { dailyTokenCap: number; dailyCostCapUsd: number },
    private readonly timezone: string,
    private readonly now: () => number = Date.now,
  ) {}

  private keys() {
    const day = bogotaDay(this.now(), this.timezone);
    return { day, tokens: `budget:${day}:tokens`, micros: `budget:${day}:usd_micros`, notice: `budget:${day}:noticed` };
  }

  async check(): Promise<BudgetStatus> {
    const k = this.keys();
    const tokens = (await this.kv.get<number>(k.tokens)) ?? 0;
    const costUsd = ((await this.kv.get<number>(k.micros)) ?? 0) / 1e6;
    const reason = tokens >= this.caps.dailyTokenCap ? 'tokens' : costUsd >= this.caps.dailyCostCapUsd ? 'cost' : undefined;
    return { ok: !reason, day: k.day, tokens, costUsd, ...(reason ? { reason } : {}) };
  }

  async record(modelId: string, usage: UsageLike): Promise<void> {
    const k = this.keys();
    const tokens = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    const micros = Math.ceil(estimateCostUsd(modelId, usage, this.now()) * 1e6);
    await this.kv.incr(k.tokens, tokens, TWO_DAYS);
    await this.kv.incr(k.micros, micros, TWO_DAYS);
  }

  /** True exactly once per day — used to send a single "budget hit" message. */
  claimNotice(): Promise<boolean> {
    return this.kv.setIfNotExists(this.keys().notice, true, TWO_DAYS);
  }
}

function modelIdOf(model: unknown): string {
  if (typeof model === 'string') return model;
  const m = model as { modelId?: string; provider?: string } | undefined;
  return m?.modelId ? `${m.provider ?? ''}/${m.modelId}` : 'unknown';
}

/**
 * Agent processor: refuses to call the model once today's cap is reached (before every step,
 * so tool loops stop too) and records each step's usage afterwards.
 */
export class BudgetGuard implements Processor<'budget-guard'> {
  readonly id = 'budget-guard' as const;
  readonly name = 'Daily budget guard';

  constructor(
    private readonly budget: Budget,
    private readonly onBlocked?: (status: BudgetStatus) => void,
  ) {}

  async processInputStep(args: ProcessInputStepArgs) {
    const status = await this.budget.check();
    if (!status.ok) {
      this.onBlocked?.(status);
      args.abort(BUDGET_MESSAGE, { retry: false });
    }
    args.state.modelId = modelIdOf(args.model);
    return undefined;
  }

  async processOutputStep(args: ProcessOutputStepArgs) {
    const responseModel = (args.steps.at(-1) as { response?: { modelId?: string } } | undefined)?.response?.modelId;
    await this.budget.record(responseModel ?? String(args.state.modelId ?? 'unknown'), args.usage ?? {});
    return args.messageList;
  }
}
