import { describe, expect, it, vi } from 'vitest';
import { Pacer } from '../src/llm/pacer.js';
import { createRateLimitedFetch, rateLimitContext } from '../src/llm/rate-limit.js';

describe('Pacer', () => {
  it('lets 14 flash-lite requests through per minute, then waits for the oldest to age out', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const p = new Pacer({ now: () => now, sleep: async (ms) => void (sleeps.push(ms), (now += ms)) });
    for (let i = 0; i < 14; i++) {
      await p.acquire('gemini-3.5-flash-lite', 8000);
      now += 1000;
    }
    expect(sleeps).toEqual([]);
    await p.acquire('gemini-3.5-flash-lite', 8000); // 15th within the minute
    expect(sleeps).toHaveLength(1);
    expect(now).toBeGreaterThanOrEqual(60_000);
  });
  it('3.8-flash is paced at 4 RPM; models are independent', async () => {
    let now = 0;
    const p = new Pacer({ now: () => now, sleep: async (ms) => void (now += ms) });
    for (let i = 0; i < 4; i++) await p.acquire('gemini-3.8-flash', 100);
    expect(p.delayFor('gemini-3.8-flash', 100)).toBeGreaterThan(55_000);
    expect(p.delayFor('gemini-3.5-flash-lite', 100)).toBe(0);
  });
  it('also paces by estimated tokens per minute', () => {
    const p = new Pacer({ now: () => 0, limits: { m: { rpm: 100, tpm: 10_000 } } });
    void p.acquire('m', 9_000);
    return p.acquire('m', 0).then(() => expect(p.delayFor('m', 2_000)).toBeGreaterThan(0));
  });
});

describe('fetch with pacer', () => {
  it('waits instead of sending, and tells the chat when the wait is long', async () => {
    let now = 0;
    const pacer = new Pacer({ now: () => now, sleep: async (ms) => void (now += ms), limits: { 'gemini-x': { rpm: 1, tpm: 1e9 } } });
    const base = vi.fn(async () => new Response('{}', { status: 200 }));
    const f = createRateLimitedFetch({ fetch: base, pacer, log: () => {} });
    const said: string[] = [];
    await rateLimitContext.run({ notify: async (t) => void said.push(t), format: (s) => `⏳ ${s}s` }, async () => {
      await f('https://g/models/gemini-x:generateContent', { body: '{}' });
      await f('https://g/models/gemini-x:generateContent', { body: '{}' });
    });
    expect(base).toHaveBeenCalledTimes(2);
    expect(now).toBeGreaterThanOrEqual(60_000);
    expect(said).toEqual(['⏳ 60s']);
  });
});
