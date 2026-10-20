import { describe, expect, it, vi } from 'vitest';
import { Pacer, estimateTokens } from '../src/llm/pacer.js';
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
  it('a pacer wait is not an error: a calm "one moment" (not the 429 wording)', async () => {
    let now = 0;
    const pacer = new Pacer({ now: () => now, sleep: async (ms) => void (now += ms), limits: { 'gemini-x': { rpm: 1, tpm: 1e9 } } });
    const base = vi.fn(async () => new Response('{}', { status: 200 }));
    const f = createRateLimitedFetch({ fetch: base, pacer, log: () => {} });
    const said: string[] = [];
    await rateLimitContext.run({ notify: async (t) => void said.push(t), format: (s) => `429 ${s}s`, waiting: () => '⏳ un momento' }, async () => {
      await f('https://g/models/gemini-x:generateContent', { body: '{}' });
      await f('https://g/models/gemini-x:generateContent', { body: '{}' });
    });
    expect(base).toHaveBeenCalledTimes(2);
    expect(now).toBeGreaterThanOrEqual(60_000);
    expect(said).toEqual(['⏳ un momento']);
  });

  it('short pacer waits are silent', async () => {
    let now = 0;
    const pacer = new Pacer({ now: () => now, sleep: async (ms) => void (now += ms), limits: { 'gemini-x': { rpm: 1, tpm: 1e9 } } });
    const f = createRateLimitedFetch({ fetch: async () => new Response('{}', { status: 200 }), pacer, log: () => {} });
    const said: string[] = [];
    await rateLimitContext.run({ notify: async (t) => void said.push(t), waiting: () => 'wait' }, async () => {
      await f('https://g/models/gemini-x:generateContent', { body: '{}' });
      now += 55_000; // next slot in 5 s
      await f('https://g/models/gemini-x:generateContent', { body: '{}' });
    });
    expect(said).toEqual([]);
  });

  it('a 1 MB voice note does not count as text tokens, and does not delay the next call', async () => {
    const audio = Buffer.alloc(1_006_152, 7).toString('base64'); // ~1.34 MB of base64
    const body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Transcribe this voice note.' }, { inlineData: { mimeType: 'audio/ogg', data: audio } }] }] });
    expect(body.length / 4).toBeGreaterThan(300_000); // what the old estimate counted
    expect(estimateTokens(body)).toBeLessThan(3_000);
    let now = 0;
    const pacer = new Pacer({ now: () => now, sleep: async (ms) => void (now += ms) });
    const usage = (n: number) => new Response(JSON.stringify({ usageMetadata: { promptTokenCount: n } }), { status: 200 });
    const f = createRateLimitedFetch({ fetch: async () => usage(1288), pacer, log: () => {} });
    await f('https://g/models/gemini-3.5-flash-lite:generateContent', { body });
    await f('https://g/models/gemini-3.5-flash-lite:generateContent', { body: JSON.stringify({ contents: [{ parts: [{ text: 'x'.repeat(40_000) }] }] }) });
    expect(now).toBe(0); // no wait
  });

  it('the window is corrected with the billed tokens once the response arrives', async () => {
    let now = 0;
    const pacer = new Pacer({ now: () => now, sleep: async (ms) => void (now += ms), limits: { 'gemini-x': { rpm: 100, tpm: 100_000 } } });
    const f = createRateLimitedFetch({ fetch: async () => new Response(JSON.stringify({ usageMetadata: { promptTokenCount: 500 } }), { status: 200 }), pacer, log: () => {} });
    await f('https://g/models/gemini-x:generateContent', { body: 'y'.repeat(360_000) }); // estimate 90K, billed 500
    await new Promise((r) => setTimeout(r, 10));
    expect(pacer.delayFor('gemini-x', 90_000)).toBe(0); // the 90K estimate no longer blocks
  });
});
