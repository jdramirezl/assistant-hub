import { afterEach, describe, expect, it } from 'vitest';
import { classifyIntent, mediaOf } from '../src/telemetry/intent.js';
import { estimateCostUsd } from '../src/budget.js';
import { UsageLog, summarize, formatUsageReport, type CallRow } from '../src/telemetry/usage-log.js';
import { createUsageObserver } from '../src/telemetry/observe.js';
import { withUsageScope } from '../src/telemetry/context.js';
import { createClient } from '@libsql/client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { MockTelegram, textUpdate } from './support/mock-telegram.js';

const db = () => createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), 'usage-')), 'u.db')}` });

describe('classifyIntent', () => {
  it.each([
    ['registra 2 huevos y una tostada en el desayuno', 'meal'],
    ['comí arroz con pollo y ensalada', 'meal'],
    ['¿qué comí hoy?', 'mfp-other'],
    ['borra el café del desayuno', 'mfp-other'],
    ['borra todo el desayuno de hoy', 'plan'],
    ['gasté 25k en almuerzo con Nequi', 'expense'],
    ['pásale 100 mil de Nequi a Bancolombia', 'expense'],
    ['¿cuánto gasté este mes?', 'finance-read'],
    ['almorcé una arepa y pagué 12k con Nequi', 'mixed'],
    ['hola Alfred', 'chat'],
  ])('%s → %s', (text, intent) => {
    expect(classifyIntent(text)).toBe(intent);
  });
  it('media without caption is mixed; media types are detected', () => {
    expect(classifyIntent('', 'photo')).toBe('mixed');
    expect(mediaOf([{ mimeType: 'audio/ogg' }])).toBe('voice');
    expect(mediaOf([{ mediaType: 'image/jpeg' }])).toBe('photo');
    expect(mediaOf([])).toBe('text');
  });
});

describe('paid prices', () => {
  const at = Date.parse('2026-10-19T00:00:00Z');
  it('flash-lite: $0.30 in, $0.03 cached, $2.50 out (thinking billed as output)', () => {
    expect(estimateCostUsd('gemini-3.5-flash-lite', { inputTokens: 1e6, outputTokens: 0 }, at)).toBeCloseTo(0.3, 6);
    expect(estimateCostUsd('gemini-3.5-flash-lite', { inputTokens: 1e6, cachedInputTokens: 1e6, outputTokens: 0 }, at)).toBeCloseTo(0.03, 6);
    expect(estimateCostUsd('gemini-3.5-flash-lite', { inputTokens: 0, outputTokens: 1e6 }, at)).toBeCloseTo(2.5, 6);
  });
  it('3.8-flash: $0.75 / $3.75 now, doubled from 2027', () => {
    expect(estimateCostUsd('gemini-3.8-flash', { inputTokens: 1e6, outputTokens: 1e6 }, at)).toBeCloseTo(4.5, 6);
    expect(estimateCostUsd('gemini-3.8-flash', { inputTokens: 1e6, outputTokens: 1e6 }, Date.parse('2027-02-01T00:00:00Z'))).toBeCloseTo(9, 6);
  });
});

describe('usage observer', () => {
  const geminiSse = (usage: object, fn?: string) =>
    new Response(
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] })}\n\ndata: ${JSON.stringify({ candidates: [{ content: { parts: fn ? [{ functionCall: { name: fn, args: {} } }] : [] } }], usageMetadata: usage })}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  it('records one row per HTTP attempt with tokens, cache, thinking, tools, scope and step', async () => {
    const log = new UsageLog(db());
    const observe = createUsageObserver(log, { primaryModel: 'gemini-3.5-flash-lite' });
    const body = JSON.stringify({ systemInstruction: { parts: [{ text: 'x'.repeat(123) }] }, tools: [{ functionDeclarations: [{}, {}, {}] }] });
    await withUsageScope({ requestId: 'r1', intent: 'meal', media: 'photo', kind: 'chat' }, async () => {
      observe({ url: 'https://g/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse', init: { body }, res: new Response('{}', { status: 429 }), attempt: 0 });
      observe({ url: 'https://g/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse', init: { body }, res: geminiSse({ promptTokenCount: 7700, cachedContentTokenCount: 5000, candidatesTokenCount: 40, thoughtsTokenCount: 10 }, 'fitness_log_food'), attempt: 1 });
      observe({ url: 'https://g/v1beta/models/gemini-3.8-flash:generateContent', init: { body }, res: new Response(JSON.stringify({ usageMetadata: { promptTokenCount: 100 } }), { status: 200 }), attempt: 0 });
    });
    await new Promise((r) => setTimeout(r, 100));
    const rows = await log.rows(0);
    expect(rows.map((r) => [r.seq, r.status, r.attempt, r.model, r.fallback])).toEqual([
      [0, 429, 0, 'gemini-3.5-flash-lite', false],
      [1, 200, 1, 'gemini-3.5-flash-lite', false],
      [2, 200, 0, 'gemini-3.8-flash', true],
    ]);
    expect(rows[1]).toMatchObject({ requestId: 'r1', intent: 'meal', media: 'photo', inputTokens: 7700, cachedTokens: 5000, outputTokens: 50, thinkingTokens: 10, toolsSent: 3, systemChars: 123, toolsCalled: ['fitness_log_food'] });
  });
});

describe('summarize + report', () => {
  const row = (o: Partial<CallRow>): CallRow => ({ ts: 0, requestId: 'a', seq: 0, kind: 'chat', intent: 'meal', media: 'text', model: 'gemini-3.5-flash-lite', status: 200, attempt: 0, fallback: false, inputTokens: 1000, cachedTokens: 500, outputTokens: 10, thinkingTokens: 0, toolsSent: 10, systemChars: 1, bodyChars: 1, toolsCalled: [], ...o });
  it('computes calls/request, cached %, peak RPM, per-intent, and plan requests', () => {
    const rows = [row({ ts: 0 }), row({ ts: 10_000 }), row({ ts: 20_000, requestId: 'b', intent: 'expense' }), row({ ts: 200_000, requestId: 'c', toolsCalled: ['propose_plan'] }), row({ ts: 210_000, requestId: 'c', status: 429, inputTokens: 0, cachedTokens: 0 })];
    const s = summarize(rows);
    expect(s).toMatchObject({ requests: 3, calls: 5, okCalls: 4, rateLimited: 1, peakRpm: 3, cachedPct: 50 });
    expect(s.byIntent).toEqual({ meal: { requests: 1, calls: 2, inputTokens: 2000 }, expense: { requests: 1, calls: 1, inputTokens: 1000 }, plan: { requests: 1, calls: 2, inputTokens: 1000 } });
    const text = formatUsageReport(s, s, 'es');
    expect(text).toMatch(/Solicitudes 3 · llamadas 5 \(1\.7\/sol\)/);
    expect(text).toMatch(/caché 50%/);
    expect(text).toMatch(/Pico 3 RPM/);
    expect(text.length).toBeLessThan(900);
  });
});

describe('/usage in Telegram', () => {
  let tg: MockTelegram;
  let hub: Hub;
  afterEach(async () => {
    await hub?.stop();
    await tg?.stop();
  });
  it('the allowlisted user gets the report without a model call; strangers get nothing', async () => {
    tg = await new MockTelegram().start();
    hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: '42' }), {
      model: { specificationVersion: 'v2', provider: 'x', modelId: 'never', doGenerate: () => { throw new Error('model must not be called'); }, doStream: () => { throw new Error('model must not be called'); } } as never,
      registry: { servers: {} },
      telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: () => {} },
    });
    await hub.usage.record({ ts: Date.now(), requestId: 'z', seq: 0, kind: 'chat', intent: 'expense', media: 'text', model: 'gemini-3.5-flash-lite', status: 200, attempt: 0, fallback: false, inputTokens: 7700, cachedTokens: 0, outputTokens: 50, thinkingTokens: 0, toolsSent: 30, systemChars: 1, bodyChars: 1, toolsCalled: [] });
    await hub.start();
    tg.push(textUpdate(666, '/usage'));
    tg.push(textUpdate(42, '/usage'));
    await tg.waitFor(() => tg.outgoingText(42).includes('Uso de Gemini'));
    expect(tg.outgoingText(42)).toMatch(/expense 1\/1/);
    expect(tg.callsTo(666).filter((c) => c.method !== 'getChat')).toEqual([]);
  });
});
