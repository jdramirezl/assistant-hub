import { AsyncLocalStorage } from 'node:async_hooks';
import type { Voice } from '../persona.js';

/**
 * Per-request context so a model call deep inside an agent run can tell the chat it is
 * waiting ("⏳ rate limit, retrying in 12s"). Set by the Telegram handler around each turn.
 */
export const rateLimitContext = new AsyncLocalStorage<{
  notify: (text: string) => Promise<void>;
  /** Wording for the waiting notice (persona); default "⏳ rate limit, retrying in Ns". */
  format?: (seconds: number) => string;
}>();

export const MAX_WAIT_MS = 60_000;

/** Gemini RetryInfo.retryDelay ("17s", "0.5s") in ms. */
export function parseRetryDelayMs(body: unknown): number | undefined {
  const details = (body as { error?: { details?: { '@type'?: string; retryDelay?: string }[] } })?.error?.details ?? [];
  const info = details.find((d) => d['@type']?.endsWith('RetryInfo'));
  const m = info?.retryDelay?.match(/^([\d.]+)s$/);
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

/** True when the violated quota is per day (waiting a minute won't help). */
export function isDailyQuota(body: unknown): boolean {
  return /PerDay/i.test(JSON.stringify((body as { error?: { details?: unknown } })?.error?.details ?? ''));
}

export interface RateLimitedFetchOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries per request on 429 (and on 500/503). */
  maxRetries?: number;
  maxWaitMs?: number;
  log?: (m: string) => void;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * fetch for the Gemini provider. On 429, waits Gemini's retryDelay (capped at 60 s) and
 * retries the SAME request: same model, no escalation to the stronger model, which has an
 * even smaller free-tier quota. Gives up immediately on a per-day quota. Retries 500/503
 * ("high demand") a couple of times with short backoff.
 */
export function createRateLimitedFetch(opts: RateLimitedFetchOptions = {}): typeof fetch {
  const base = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? DEFAULT_SLEEP;
  const maxRetries = opts.maxRetries ?? 3;
  const maxWait = opts.maxWaitMs ?? MAX_WAIT_MS;
  const log = opts.log ?? ((m: string) => console.warn(m));

  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let notified = false;
    for (let attempt = 0; ; attempt++) {
      const res = await base(input, init);
      if (res.status !== 429 && res.status !== 503 && res.status !== 500) return res;
      if (attempt >= maxRetries) return res;

      let waitMs: number;
      if (res.status === 429) {
        const body = await res
          .clone()
          .json()
          .catch(() => ({}));
        const delay = parseRetryDelayMs(body) ?? 10_000;
        if (isDailyQuota(body) || delay > maxWait * 2) {
          log(`[llm] 429 daily/long quota (retryDelay ${Math.round(delay / 1000)}s); not retrying`);
          return res;
        }
        waitMs = Math.min(delay, maxWait);
        log(`[llm] 429 rate limit; retrying same model in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1})`);
        const ctx = rateLimitContext.getStore();
        if (ctx && !notified) {
          notified = true;
          const s = Math.round(delay / 1000);
          await ctx.notify(ctx.format?.(s) ?? `⏳ rate limit, retrying in ${s}s`).catch(() => {});
        }
      } else {
        waitMs = Math.min(1_000 * 2 ** attempt, 8_000);
        log(`[llm] ${res.status} from Gemini; retrying in ${waitMs / 1000}s`);
      }
      await res.body?.cancel().catch(() => {});
      await sleep(waitMs);
    }
  }) as typeof fetch;
}

/** Chat-facing text for a model/run error (Telegram formatError). */
export function describeModelError(err: unknown, voice?: Pick<Voice, 'rateLimitGiveUp'>): string {
  const e = err as { statusCode?: number; message?: string; cause?: { statusCode?: number } };
  const status = e?.statusCode ?? e?.cause?.statusCode;
  const msg = String(e?.message ?? err);
  if (status === 429 || /RESOURCE_EXHAUSTED|exceeded your current quota|\b429\b/i.test(msg)) {
    const daily = /PerDay/i.test(msg);
    if (voice) return voice.rateLimitGiveUp(daily);
    return daily
      ? '⏳ Gemini daily free-tier limit reached; I will be able to answer again tomorrow.'
      : '⏳ Gemini rate limit; give me a minute and send it again.';
  }
  return `⚠️ Something went wrong: ${msg.split('\n')[0]!.slice(0, 160)}`;
}
