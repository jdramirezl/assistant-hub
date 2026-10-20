import { AsyncLocalStorage } from 'node:async_hooks';
import type { Voice } from '../persona.js';
import { estimateTokens, type Pacer } from './pacer.js';
import { span } from '../telemetry/timing.js';

/**
 * Per-request context so a model call deep inside an agent run can tell the chat it is
 * waiting ("⏳ rate limit, retrying in 12s"). Set by the Telegram handler around each turn.
 */
export const rateLimitContext = new AsyncLocalStorage<{
  notify: (text: string) => Promise<void>;
  /** Wording for a real 429 (persona); default "⏳ rate limit, retrying in Ns". */
  format?: (seconds: number) => string;
  /** Wording for a client-side pacing wait (not an error); default "⏳ One moment, processing…". */
  waiting?: (seconds: number) => string;
  /** Status layer: a REAL 429 wait (replaces the notify message). */
  onQuota?: (seconds: number) => void;
  /** Status layer: the hub's own pacing wait (replaces the notify message). */
  onPacing?: (ms: number) => void;
}>();

/** Pacer waits shorter than this are silent (the user only sees "typing…"). */
export const SILENT_WAIT_MS = 10_000;

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
  /** Client-side pacing (wait for a slot instead of hitting 429). */
  pacer?: Pacer;
  /** Called once per HTTP attempt (usage logging). Must not throw. */
  observe?: (info: { url: string; init?: RequestInit; res: Response; attempt: number }) => void;
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
    let paced = false;
    const url = String(input instanceof Request ? input.url : input);
    const model = url.match(/models\/([^:/?]+)/)?.[1] ?? 'unknown';
    for (let attempt = 0; ; attempt++) {
      let slot: { settle(actual: number): void } | undefined;
      if (opts.pacer) {
        const wait = span('pacer', model);
        slot = await opts.pacer.acquire(model, estimateTokens(init?.body), (ms) => {
          // our own pacing, not an error: a calm "one moment" (or nothing for short waits)
          if (ms < SILENT_WAIT_MS || paced) return;
          const ctx = rateLimitContext.getStore();
          if (!ctx) return;
          paced = true;
          if (ctx.onPacing) return ctx.onPacing(ms);
          const s = Math.ceil(ms / 1000);
          void ctx.notify(ctx.waiting?.(s) ?? '⏳ One moment, processing your message…').catch(() => {});
        }).finally(() => wait.end());
      }
      const call = span('gemini', model, { attempt });
      let res: Response;
      try {
        res = timeBody(await base(input, init), call);
      } catch (err) {
        call.end({ ok: false, meta: { status: 'network' } });
        throw err;
      }
      // replace the estimate with the tokens Gemini actually billed (non-blocking)
      if (slot && res.ok) void billedInputTokens(res).then((n) => n !== undefined && slot!.settle(n), () => {});
      try {
        opts.observe?.({ url: String(input instanceof Request ? input.url : input), init, res, attempt });
      } catch {
        /* telemetry must never break a call */
      }
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
          if (ctx.onQuota) ctx.onQuota(s);
          else await ctx.notify(ctx.format?.(s) ?? `⏳ rate limit, retrying in ${s}s`).catch(() => {});
        }
      } else {
        waitMs = Math.min(1_000 * 2 ** attempt, 8_000);
        log(`[llm] ${res.status} from Gemini; retrying in ${waitMs / 1000}s`);
      }
      await res.body?.cancel().catch(() => {});
      const back = span('backoff', `${model} ${res.status}`);
      await sleep(waitMs);
      back.end();
    }
  }) as typeof fetch;
}

/**
 * The Gemini span covers the whole response: headers, first byte (ttft, after thinking) and the
 * last byte of the stream. A failed status ends it right away.
 */
function timeBody(res: Response, call: ReturnType<typeof span>): Response {
  if (!res.ok || !res.body) {
    call.end({ ok: res.ok, meta: { status: res.status } });
    return res;
  }
  let first = true;
  const body = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        if (first) {
          first = false;
          call.set({ ttft: call.elapsed() });
        }
        ctrl.enqueue(chunk);
      },
      flush() {
        call.end({ ok: true, meta: { status: res.status } });
      },
    }),
  );
  const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  Object.defineProperty(out, 'url', { value: res.url });
  return out;
}

/** promptTokenCount (+ tool-use prompt tokens) from a Gemini response, JSON or SSE. */
async function billedInputTokens(res: Response): Promise<number | undefined> {
  const text = await res.clone().text();
  let last: { promptTokenCount?: number; toolUsePromptTokenCount?: number } | undefined;
  for (const m of text.matchAll(/"usageMetadata"\s*:\s*(\{[^{}]*\})/g)) {
    try {
      last = JSON.parse(m[1]!);
    } catch {
      /* partial */
    }
  }
  return last?.promptTokenCount !== undefined ? last.promptTokenCount + (last.toolUsePromptTokenCount ?? 0) : undefined;
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
