import { describe, expect, it, vi } from 'vitest';
import { createRateLimitedFetch, parseRetryDelayMs, rateLimitContext, isDailyQuota, describeModelError } from '../src/llm/rate-limit.js';

const r429 = (delay: string, quotaId = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier') =>
  new Response(
    JSON.stringify({
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: 'You exceeded your current quota',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay },
        ],
      },
    }),
    { status: 429, headers: { 'content-type': 'application/json' } },
  );
const ok = () => new Response('{"candidates":[]}', { status: 200 });

describe('parseRetryDelayMs', () => {
  it('reads Gemini RetryInfo', async () => {
    expect(parseRetryDelayMs(await r429('17s').json())).toBe(17_000);
    expect(parseRetryDelayMs(await r429('0.5s').json())).toBe(500);
    expect(parseRetryDelayMs({})).toBeUndefined();
  });
  it('detects per-day quotas', async () => {
    expect(isDailyQuota(await r429('3600s', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier').json())).toBe(true);
    expect(isDailyQuota(await r429('5s').json())).toBe(false);
  });
});

describe('createRateLimitedFetch', () => {
  it('on 429 waits retryDelay and retries the same request (same model URL)', async () => {
    const base = vi.fn().mockResolvedValueOnce(r429('7s')).mockResolvedValueOnce(ok());
    const sleep = vi.fn(async () => {});
    const f = createRateLimitedFetch({ fetch: base, sleep, log: () => {} });
    const res = await f('https://x/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(7_000);
    expect(base.mock.calls.map((c) => c[0])).toEqual([
      'https://x/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent',
      'https://x/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent',
    ]);
  });

  it('caps the wait at 60 s and gives up (returns the 429) after maxRetries', async () => {
    const base = vi.fn(async () => r429('45s'));
    const sleep = vi.fn(async (_ms: number) => {});
    const f = createRateLimitedFetch({ fetch: base, sleep, maxRetries: 2, log: () => {} });
    const res = await f('https://x', { body: '{}' });
    expect(res.status).toBe(429);
    expect(base).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.every(([ms]) => ms <= 60_000)).toBe(true);
  });

  it('does not wait when the daily quota is exhausted or the delay is far beyond the cap', async () => {
    const sleep = vi.fn(async () => {});
    const daily = createRateLimitedFetch({ fetch: vi.fn(async () => r429('5s', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier')), sleep, log: () => {} });
    expect((await daily('https://x', {})).status).toBe(429);
    const huge = createRateLimitedFetch({ fetch: vi.fn(async () => r429('3600s')), sleep, log: () => {} });
    expect((await huge('https://x', {})).status).toBe(429);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries 503 "high demand" briefly on the same model', async () => {
    const base = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(ok());
    const sleep = vi.fn(async () => {});
    const res = await createRateLimitedFetch({ fetch: base, sleep, log: () => {} })('https://x', {});
    expect(res.status).toBe(200);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('tells the chat "⏳ rate limit, retrying in Ns" via the request context (once per wait burst)', async () => {
    const base = vi.fn().mockResolvedValueOnce(r429('12s')).mockResolvedValueOnce(r429('12s')).mockResolvedValueOnce(ok());
    const said: string[] = [];
    const f = createRateLimitedFetch({ fetch: base, sleep: async () => {}, log: () => {} });
    await rateLimitContext.run({ notify: async (t) => void said.push(t) }, () => f('https://x', {}));
    expect(said).toEqual(['⏳ rate limit, retrying in 12s']);
  });

  it('passes other statuses straight through', async () => {
    const base = vi.fn(async () => new Response('bad', { status: 400 }));
    const res = await createRateLimitedFetch({ fetch: base, sleep: async () => {}, log: () => {} })('https://x', {});
    expect(res.status).toBe(400);
    expect(base).toHaveBeenCalledTimes(1);
  });
});

describe('describeModelError (Telegram error text)', () => {
  it('turns a 429 into a short rate-limit note, not a failure', () => {
    const err = Object.assign(new Error('You exceeded your current quota'), { statusCode: 429 });
    expect(describeModelError(err)).toMatch(/^⏳/);
    const daily = Object.assign(new Error('quota GenerateRequestsPerDayPerProjectPerModel exceeded'), { statusCode: 429 });
    expect(describeModelError(daily)).toMatch(/daily/i);
  });
  it('keeps other errors short', () => {
    expect(describeModelError(new Error('boom\nstack'))).toBe('⚠️ Something went wrong: boom');
  });
});
