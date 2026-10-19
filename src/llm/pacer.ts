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
  private queue: Promise<void> = Promise.resolve();
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

  /** Wait for a slot (serialized so concurrent callers don't overshoot), then reserve it. */
  acquire(model: string, tokens: number, onWait?: (ms: number) => void): Promise<void> {
    const run = async () => {
      for (;;) {
        const wait = this.delayFor(model, tokens);
        if (wait <= 0) break;
        onWait?.(wait);
        await this.sleep(wait + 25);
      }
      this.windows.get(model)!.push({ t: this.now(), tokens });
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

/** Rough prompt-token estimate from the request body (≈ 4 chars per token). */
export function estimateTokens(body: unknown): number {
  return typeof body === 'string' ? Math.ceil(body.length / 4) : 1000;
}
