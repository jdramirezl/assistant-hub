/**
 * Client-side pacing for the Gemini free tier: wait for a slot instead of hitting 429.
 * Sliding 60 s windows per model for requests (RPM) and estimated input tokens (TPM).
 * Free-tier limits: flash-lite 15 RPM / 250K TPM, 3.8-flash 5 RPM; we stay just below.
 */
export interface PaceLimit {
  rpm: number;
  tpm: number;
}

export const FREE_TIER_LIMITS: Record<string, PaceLimit> = {
  'gemini-3.5-flash-lite': { rpm: 14, tpm: 240_000 },
  'gemini-3.8-flash': { rpm: 4, tpm: 240_000 },
};
const DEFAULT_LIMIT: PaceLimit = { rpm: 4, tpm: 240_000 };

export interface PacerOptions {
  limits?: Record<string, PaceLimit>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class Pacer {
  private readonly windows = new Map<string, { t: number; tokens: number }[]>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: PacerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** How long a request of `tokens` to `model` would have to wait right now (ms). */
  delayFor(model: string, tokens: number): number {
    const limit = this.opts.limits?.[model] ?? FREE_TIER_LIMITS[model] ?? DEFAULT_LIMIT;
    const now = this.now();
    const w = (this.windows.get(model) ?? []).filter((x) => now - x.t < 60_000);
    this.windows.set(model, w);
    let wait = 0;
    if (w.length >= limit.rpm) wait = Math.max(wait, w[w.length - limit.rpm]!.t + 60_000 - now);
    let used = w.reduce((a, x) => a + x.tokens, 0);
    for (const x of w) {
      if (used + tokens <= limit.tpm) break;
      used -= x.tokens;
      wait = Math.max(wait, x.t + 60_000 - now);
    }
    return Math.max(0, wait);
  }

  /**
   * Wait for a slot (serialized so concurrent callers don't overshoot), then reserve it.
   * Returns the reservation; call `settle(actual)` with the billed input tokens once known.
   */
  acquire(model: string, tokens: number, onWait?: (ms: number) => void): Promise<{ settle(actual: number): void }> {
    const run = async () => {
      for (;;) {
        const wait = this.delayFor(model, tokens);
        if (wait <= 0) break;
        onWait?.(wait);
        await this.sleep(wait + 25);
      }
      const entry = { t: this.now(), tokens };
      this.windows.get(model)!.push(entry);
      return {
        settle: (actual: number) => {
          if (Number.isFinite(actual) && actual >= 0) entry.tokens = actual;
        },
      };
    };
    const p = this.queue.then(run, run);
    this.queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }
}

/** Tokens Gemini bills per inline media part, roughly (audio ≈ 32/s; a ~40 s note ≈ 1.3K). */
export const MEDIA_PART_TOKENS: Record<string, number> = { audio: 1_500, image: 300, video: 5_000, application: 2_000 };
/** Base64 payload of an inline part (Gemini `inlineData.data`); never counted as text. */
const INLINE_DATA = /"data"\s*:\s*"[A-Za-z0-9+/=_-]{256,}"/g;
const MEDIA_TYPE = /"mimeType"\s*:\s*"(audio|image|video|application)\//g;

/**
 * Rough prompt-token estimate from the request body: ≈ 4 chars per token of TEXT, plus a
 * constant per inline media part. Base64 media is NOT text: a 1 MB voice note is ~1.3 MB of
 * base64 (≈ 335K "tokens" by length) but Gemini bills ~1.3K for it.
 */
export function estimateTokens(body: unknown): number {
  if (typeof body !== 'string') return 1000;
  if (body.length < 4096) return Math.ceil(body.length / 4);
  const text = body.replace(INLINE_DATA, '"data":""');
  let media = 0;
  if (text.length !== body.length) for (const m of text.matchAll(MEDIA_TYPE)) media += MEDIA_PART_TOKENS[m[1]!] ?? 1_000;
  return Math.ceil(text.length / 4) + media;
}
