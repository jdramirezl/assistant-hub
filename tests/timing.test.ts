/** Latency measurement: request spans, exclusive attribution, request_timings, /velocidad. */
import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestTimer, TimingLog, attribute, instrumentTelegramFetch, span, timingLine, type RequestTiming, type Span, type TimingRow, TIMING_KEEP_MS } from '../src/telemetry/timing.js';
import { withUsageScope } from '../src/telemetry/context.js';
import { createRateLimitedFetch } from '../src/llm/rate-limit.js';
import { Pacer } from '../src/llm/pacer.js';
import { bucketOf, formatVelocidad, latencyStats, percentile } from '../src/status/velocidad.js';
import { createHub, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel, type Turn } from './support/scripted-model.js';
import { MockTelegram, textUpdate } from './support/mock-telegram.js';
import { MFP_REGISTRY, startFakeMason } from './support/fake-mason.js';
import { startFakeFinance } from './support/fake-finance.js';

const db = () => createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), 'timing-')), 't.db')}` });
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

/** A manual clock. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => void (t += ms) };
}

describe('exclusive attribution', () => {
  const s = (kind: Span['kind'], start: number, end: number): Span => ({ kind, label: kind, start, end });
  it('each instant belongs to one category; uncovered time is hub', () => {
    const c = attribute([s('gemini', 0, 1000), s('telegram', 500, 1500), s('tool', 2000, 3000)], 4000);
    expect(c).toEqual({ gemini: 1000, pacer: 0, tools: 1000, telegram: 500, poll: 0, hub: 1500 });
  });
  it('a tool call inside a polling loop is polling; pacer beats gemini; backoff is gemini', () => {
    const c = attribute([s('poll', 0, 10_000), s('tool', 1000, 2000), s('pacer', 10_000, 12_000), s('gemini', 10_000, 13_000), s('backoff', 13_000, 14_000)], 15_000);
    expect(c).toEqual({ gemini: 2000, pacer: 2000, tools: 0, telegram: 0, poll: 10_000, hub: 1000 });
  });
  it('hub-side work around a tool is hub, the round trip is tools; transcribe/receive are informational', () => {
    const c = attribute([s('hub', 0, 1000), s('tool', 200, 800), s('transcribe', 0, 5000), s('receive', -3000, 0)], 5000);
    expect(c).toEqual({ gemini: 0, pacer: 0, tools: 600, telegram: 0, poll: 0, hub: 4400 });
  });
});

describe('RequestTimer', () => {
  it('records spans, closes open ones at the end, finds the dominant span, and calls onEnd once', () => {
    const k = clock();
    const ended: RequestTiming[] = [];
    const t = new RequestTimer('abc123', { now: k.now, onEnd: (x) => ended.push(x) });
    t.received(k.now() - 2000);
    const g1 = t.begin('gemini', 'gemini-3.5-flash-lite', { attempt: 0 });
    k.tick(300);
    g1.end({ ok: false, meta: { status: 503 } });
    const b = t.begin('backoff', 'gemini 503');
    k.tick(1000);
    b.end();
    const g2 = t.begin('gemini', 'gemini-3.5-flash-lite', { attempt: 1 });
    k.tick(4000);
    g2.end({ ok: true, meta: { status: 200, ttft: 3500 } });
    const tool = t.begin('tool', 'mfp.fitness_get_day');
    k.tick(700);
    tool.end({ ok: true });
    t.begin('telegram', 'sendMessage'); // never closed
    k.tick(200);
    t.mark('guard-leak');
    const r = t.end({ intent: 'meal', media: 'text', kind: 'chat' });
    t.end({ intent: 'x', media: 'x', kind: 'x' });
    expect(ended).toHaveLength(1);
    expect(r).toMatchObject({ requestId: 'abc123', totalMs: 6200, activeMs: 6200, queueMs: 2000, geminiCalls: 2, geminiRetries: 1, geminiErrors: { 503: 1 }, toolCalls: 1, toolErrors: 0, marks: ['guard-leak'] });
    expect(r.byCategory).toEqual({ gemini: 5300, pacer: 0, tools: 700, telegram: 200, poll: 0, hub: 0 });
    expect(r.dominant).toEqual({ category: 'gemini', ms: 5300, label: 'gemini-3.5-flash-lite', spanMs: 4000 });
    expect(timingLine(r)).toBe('[timing] total=6200ms gemini=5300ms(2 503×1) tools=700ms(1) pacer=0ms telegram=200ms hub=0ms queue=2000ms intent=meal dominant=gemini:gemini-3.5-flash-lite marks=guard-leak');
  });
  it('polling is excluded from active time and from the dominant category', () => {
    const k = clock();
    const t = new RequestTimer('p', { now: k.now });
    const p = t.begin('poll', 'cines.paypal');
    k.tick(120_000);
    p.end();
    k.tick(500);
    const r = t.end({ intent: 'cines', media: 'text', kind: 'resume' });
    expect(r.activeMs).toBe(500);
    expect(r.dominant.category).toBe('hub');
    expect(timingLine(r)).toMatch(/total=120500ms active=500ms .* poll=120000ms/);
  });
  it('a resumed approval is counted under its topic', () => {
    const t = new RequestTimer('x');
    t.bindScope({ intent: 'resume', media: 'text', kind: 'resume', domains: ['cines'] });
    expect(t.info().intent).toBe('resume-cines');
  });
  it('span()/timed outside a request are no-ops', async () => {
    expect(() => span('tool', 'x').end()).not.toThrow();
  });
});

describe('Gemini fetch spans', () => {
  it('pacer wait, each attempt (503 then 200, with ttft) and the retry backoff', async () => {
    let n = 0;
    const base = (async () => {
      n++;
      if (n === 1) return new Response('{"error":{}}', { status: 503 });
      await new Promise((r) => setTimeout(r, 30));
      const enc = new TextEncoder();
      const body = new ReadableStream({
        async start(c) {
          c.enqueue(enc.encode('data: {"candidates":[]}\n\n'));
          await new Promise((r) => setTimeout(r, 40));
          c.enqueue(enc.encode('data: {"usageMetadata":{"promptTokenCount":10}}\n\n'));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const k = clock();
    let wall = 0;
    const pacer = new Pacer({ limits: { m: { rpm: 1, tpm: 1e9 } }, now: () => Date.now() + wall, sleep: async (ms) => void (wall += ms) });
    const f = createRateLimitedFetch({ fetch: base, pacer, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))), log: () => {} });
    const timer = new RequestTimer('g1');
    void k;
    await withUsageScope({ requestId: 'g1', intent: 'chat', media: 'text', kind: 'chat', timer }, async () => {
      const res = await f('https://g/v1beta/models/m:streamGenerateContent?alt=sse', { method: 'POST', body: '{}' });
      expect(await res.text()).toContain('promptTokenCount');
    });
    const r = timer.end({ intent: 'chat', media: 'text', kind: 'chat' });
    const kinds = r.spans.map((s) => `${s.kind}:${s.ok ?? ''}`);
    expect(kinds).toContain('gemini:false');
    expect(kinds).toContain('gemini:true');
    expect(kinds).toContain('backoff:');
    const ok = r.spans.find((s) => s.kind === 'gemini' && s.ok)!;
    expect(ok.meta).toMatchObject({ status: 200, attempt: 1 });
    expect(Number(ok.meta!.ttft)).toBeGreaterThanOrEqual(25);
    expect(ok.end - ok.start).toBeGreaterThanOrEqual(Number(ok.meta!.ttft) + 30); // the span lasts until the last byte
    expect(r).toMatchObject({ geminiCalls: 2, geminiRetries: 1, geminiErrors: { 503: 1 } });
  });
});

describe('Telegram fetch spans', () => {
  it('records the Bot API method only (never the token), skips getUpdates and non-Telegram URLs', async () => {
    const tg = await new MockTelegram().start();
    closers.push(() => tg.stop());
    instrumentTelegramFetch();
    instrumentTelegramFetch(); // idempotent
    const timer = new RequestTimer('t1');
    await withUsageScope({ requestId: 't1', intent: 'chat', media: 'text', kind: 'chat', timer }, async () => {
      await fetch(`${tg.url}/bot1:SECRET/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: 1, text: 'x' }) });
      await fetch(`${tg.url}/bot1:SECRET/getUpdates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
    });
    const r = timer.end({ intent: 'chat', media: 'text', kind: 'chat' });
    expect(r.spans.map((s) => s.label)).toEqual(['sendMessage']);
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
});

describe('TimingLog', () => {
  it('stores one row per request and its spans; prunes after 30 days', async () => {
    const client = db();
    let now = Date.now();
    const log = new TimingLog(client, () => now);
    const t = new RequestTimer('aaa111');
    t.begin('tool', 'finance.finance_create_movement').end({ ok: false, meta: { code: 'VALIDATION_ERROR' } });
    const r = t.end({ intent: 'expense', media: 'text', kind: 'chat' });
    await log.record(r);
    const rows = await log.rows(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestId: 'aaa111', intent: 'expense', toolCalls: 1, toolErrors: 1 });
    const spans = await log.spans('aaa111');
    expect(spans[0]).toMatchObject({ kind: 'tool', label: 'finance.finance_create_movement', ok: false, meta: { code: 'VALIDATION_ERROR' } });
    now += TIMING_KEEP_MS + 1;
    await log.prune();
    expect(await log.rows(0)).toHaveLength(0);
    expect(await log.spans('aaa111')).toHaveLength(0);
  });
});

describe('/velocidad report', () => {
  const row = (o: Partial<TimingRow>): TimingRow => ({
    requestId: 'r', ts: Date.parse('2026-10-20T15:00:00Z'), intent: 'meal', media: 'text', kind: 'chat', totalMs: 1000, activeMs: 1000,
    byCategory: { gemini: 800, pacer: 0, tools: 100, telegram: 50, poll: 0, hub: 50 }, geminiCalls: 2, geminiRetries: 0, toolCalls: 1, toolErrors: 0,
    dominant: { category: 'gemini', ms: 800, label: 'gemini-3.5-flash-lite', spanMs: 500 }, marks: [], ...o,
  });
  it('buckets: voice wins; cines, finance, mfp, chat; resumes by topic', () => {
    expect(bucketOf({ intent: 'meal', media: 'voice' })).toBe('voice');
    expect(bucketOf({ intent: 'resume-cines', media: 'text' })).toBe('cines');
    expect(bucketOf({ intent: 'finance-read', media: 'text' })).toBe('finance');
    expect(bucketOf({ intent: 'mfp-other', media: 'text' })).toBe('mfp');
    expect(bucketOf({ intent: 'plan', media: 'text' })).toBe('chat');
  });
  it('nearest-rank percentiles', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
  it('p50/p95 per intent, where the time went, the 5 slowest with the dominant span (Alfred, Spanish)', () => {
    const rows = [
      row({ requestId: 'a1', activeMs: 60_000, totalMs: 60_000, byCategory: { gemini: 55_000, pacer: 0, tools: 3000, telegram: 1000, poll: 0, hub: 1000 }, geminiCalls: 4, geminiRetries: 2, dominant: { category: 'gemini', ms: 55_000 } }),
      row({ requestId: 'c1', intent: 'cines', activeMs: 9000, byCategory: { gemini: 3000, pacer: 0, tools: 6000, telegram: 0, poll: 600_000, hub: 0 }, dominant: { category: 'tools', ms: 6000, label: 'cines.cines_seat_map' } }),
      row({ requestId: 'v1', media: 'voice', activeMs: 30_000 }),
    ];
    const s = latencyStats(rows);
    expect(s).toMatchObject({ n: 3, p50: 30_000, p95: 60_000, pollMs: 600_000 });
    const text = formatVelocidad({ lang: 'es', address: 'Master Julian', timezone: 'America/Bogota', day: rows, week: rows });
    expect(text).toMatch(/^🐢 Velocidad, Master Julian\./);
    expect(text).toContain('3 solicitudes · p50 30 s · p95 60 s');
    expect(text).toContain('• comidas (1): p50 60 s · p95 60 s');
    expect(text).toContain('• cine (1): p50 9.0 s');
    expect(text).toContain('• voz (1)');
    expect(text).toMatch(/El tiempo se fue en: Gemini \d+% · apps \d+%/);
    expect(text).toContain('Esperas de pago (no cuentan): 600 s');
    const slow = text.split('— Las 5 más lentas (7 d) —')[1]!;
    expect(slow.trim().split('\n')[0]).toBe('• 20/10 10:00 req a1 · comidas · 60 s — Gemini 55 s (4 llamadas, 2 reintentos)');
    expect(slow).toContain('req c1 · cine · 9.0 s — apps 6.0 s (cines.cines_seat_map)');
  });
  it('with no data says so', () => {
    expect(formatVelocidad({ lang: 'es', address: 'Master Julian', timezone: 'America/Bogota', day: [], week: [] })).toContain('Sin solicitudes.');
  });
});

describe('through Telegram', () => {
  const ME = 42;
  async function boot(script: Turn[]) {
    const tg = await new MockTelegram().start();
    closers.push(() => tg.stop());
    const mason = await startFakeMason();
    closers.push(mason.close);
    const fin = await startFakeFinance('t');
    closers.push(fin.close);
    const sm = scriptedModel(script);
    const logs: string[] = [];
    const hub: Hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME) }), {
      model: sm.model as never,
      env: { T: 't' },
      registry: { servers: { ...MFP_REGISTRY(mason.url).servers, finance: { url: fin.url, headers: { Authorization: { env: 'T', prefix: 'Bearer ' } } } } },
      telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: (m) => logs.push(m) },
    });
    closers.push(() => hub.stop());
    await hub.start();
    return { tg, hub, logs };
  }

  it('one [timing] line per request, a request_timings row with tool + Telegram spans, and /velocidad', async () => {
    const { tg, hub, logs } = await boot([{ tool: 'fitness_get_day', args: { date: '2026-10-19' } }, { text: 'Hoy lleva 0 kcal, Master Julian.' }]);
    tg.push(textUpdate(ME, '¿qué comí hoy?'));
    await tg.waitFor(() => logs.some((l) => /\[timing\]/.test(l)), 10_000);
    const line = logs.find((l) => /\[timing\]/.test(l))!;
    expect(line).toMatch(/^\[req [0-9a-f]{6}\] \[timing\] total=\d+ms gemini=\d+ms\(0\) tools=\d+ms\(1\) pacer=\d+ms telegram=\d+ms hub=\d+ms .*intent=mfp-read dominant=/);
    expect(logs.filter((l) => /\[timing\]/.test(l))).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 100));
    const rows = await hub.timings.rows(0);
    expect(rows).toHaveLength(1);
    const req = line.match(/\[req ([0-9a-f]{6})\]/)![1]!;
    expect(rows[0]).toMatchObject({ requestId: req, intent: 'mfp-read', toolCalls: 1, toolErrors: 0 });
    const spans = await hub.timings.spans(req);
    expect(spans.map((s) => s.label)).toEqual(expect.arrayContaining(['mfp.fitness_get_day', 'fitness_get_day']));
    expect(spans.some((s) => s.kind === 'telegram')).toBe(true);
    expect(rows[0]!.totalMs).toBeGreaterThanOrEqual(spans.find((s) => s.kind === 'tool')!.end);

    tg.push(textUpdate(ME, '/velocidad'));
    await tg.waitFor(() => /🐢 Velocidad/.test(tg.outgoingText(ME)), 10_000);
    const v = tg.outgoingText(ME).slice(tg.outgoingText(ME).indexOf('🐢'));
    expect(v).toContain('Master Julian');
    expect(v).toMatch(/1 solicitudes · p50/);
    expect(v).toContain(`req ${req} · comidas`);
    // a hub command is not a timed request
    expect(await hub.timings.rows(0)).toHaveLength(1);
  });
});
