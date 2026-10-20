/**
 * Where a request's wall-clock goes. One RequestTimer per request (in the usage scope); every
 * layer records spans on it (Gemini call, pacer wait, retry backoff, MCP tool, hub hook,
 * Telegram send/edit, polling loop). At the end the spans are attributed EXCLUSIVELY (an
 * instant of time belongs to one category: a tool call running inside a polling loop is
 * polling, a Telegram edit sent while Gemini thinks is Gemini) and stored in LibSQL.
 *
 * Never records message bodies, arguments or secrets: only kinds, tool/model/method names,
 * status codes and durations.
 */
import type { Client } from '@libsql/client';
import { usageContext } from './context.js';

export type SpanKind =
  | 'gemini' // one Gemini HTTP attempt (headers → last byte)
  | 'backoff' // waiting before retrying a 429/503
  | 'pacer' // the hub's own RPM/TPM pacing
  | 'tool' // one MCP tool call (server round trip)
  | 'hub' // hub-side work around a tool (before/after hooks, guards)
  | 'telegram' // a Bot API call (send/edit/delete/photo/file download)
  | 'poll' // a polling loop (PayPal/hold/purchase): NOT counted as slowness
  | 'transcribe' // a voice note: download + transcription (informational, nests gemini)
  | 'receive'; // Telegram date → handler start (informational; seconds resolution)

/** Time categories of the breakdown. `hub` is everything not covered by another span. */
export type Category = 'gemini' | 'pacer' | 'tools' | 'telegram' | 'poll' | 'hub';
export const CATEGORIES: readonly Category[] = ['gemini', 'pacer', 'tools', 'telegram', 'poll', 'hub'];

/** Who owns an instant when spans overlap: first match wins. */
const PRIORITY: readonly [SpanKind, Category][] = [
  ['poll', 'poll'],
  ['pacer', 'pacer'],
  ['backoff', 'gemini'],
  ['gemini', 'gemini'],
  ['tool', 'tools'],
  ['hub', 'hub'],
  ['telegram', 'telegram'],
];

export type Meta = Record<string, string | number | boolean>;

export interface Span {
  kind: SpanKind;
  label: string;
  /** ms since the request started (may be negative for `receive`). */
  start: number;
  end: number;
  ok?: boolean;
  meta?: Meta;
}

export interface SpanHandle {
  /** Close the span (idempotent). */
  end(patch?: { ok?: boolean; meta?: Meta }): void;
  /** Add metadata (e.g. ttft) while it is open. */
  set(meta: Meta): void;
  /** ms since this span started. */
  elapsed(): number;
}

const NOOP: SpanHandle = { end() {}, set() {}, elapsed: () => 0 };

/** Requests are bounded: a runaway loop cannot grow a request's spans without limit. */
export const MAX_SPANS = 400;

export interface RequestInfo {
  intent: string;
  media: string;
  kind: string;
}

export interface RequestTiming extends RequestInfo {
  requestId: string;
  /** Wall-clock start (epoch ms). */
  ts: number;
  /** Handler start → end (final reply / status closed). */
  totalMs: number;
  /** total − polling: what "slow" is about. */
  activeMs: number;
  /** Telegram message date → handler start (seconds resolution), if known. */
  queueMs?: number;
  byCategory: Record<Category, number>;
  geminiCalls: number;
  geminiRetries: number;
  /** HTTP status of failed Gemini attempts, e.g. {503: 2}. */
  geminiErrors: Record<string, number>;
  toolCalls: number;
  toolErrors: number;
  /** Category with most time, and the longest single span in it. */
  dominant: { category: Category; ms: number; label?: string; spanMs?: number };
  /** Instant events (guard retries, escalations). */
  marks: string[];
  spans: Span[];
}

export interface TimerOptions {
  now?: () => number;
  /** Start earlier than construction (e.g. when the handler got the message). */
  startedAt?: number;
  onEnd?: (t: RequestTiming) => void;
}

export class RequestTimer {
  readonly t0: number;
  private readonly spans: Span[] = [];
  private readonly open = new Set<Span>();
  private readonly marks: string[] = [];
  private receivedAt?: number;
  private ended?: RequestTiming;
  readonly now: () => number;

  constructor(
    readonly requestId: string,
    private readonly opts: TimerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.t0 = Math.min(this.now(), opts.startedAt ?? Infinity);
  }

  private scope?: { intent: string; media: string; kind: string; domains?: readonly string[] };
  /** The request's usage scope: its intent (decided later by the router) is read at the end. */
  bindScope(scope: { intent: string; media: string; kind: string; domains?: readonly string[] }): void {
    this.scope = scope;
  }
  /** Intent/media/kind of the bound scope; a resumed approval is counted under its topic. */
  info(): RequestInfo {
    const s = this.scope;
    if (!s) return { intent: 'other', media: 'text', kind: 'other' };
    const intent = (s.intent === 'resume' || s.intent === 'plan') && s.domains?.length === 1 ? `${s.intent}-${s.domains[0]}` : s.intent;
    return { intent, media: s.media, kind: s.kind };
  }

  get done(): boolean {
    return this.ended !== undefined;
  }

  /** When Telegram says the user sent the message (epoch ms). */
  received(at: number | undefined): void {
    if (at === undefined || !Number.isFinite(at) || at > this.t0) return;
    this.receivedAt = at;
  }

  begin(kind: SpanKind, label: string, meta?: Meta): SpanHandle {
    if (this.ended || this.spans.length >= MAX_SPANS) return NOOP;
    const s: Span = { kind, label, start: this.now() - this.t0, end: Number.NaN, ...(meta ? { meta: { ...meta } } : {}) };
    this.spans.push(s);
    this.open.add(s);
    return {
      end: (patch) => {
        if (!this.open.has(s)) return;
        this.open.delete(s);
        s.end = this.now() - this.t0;
        if (patch?.ok !== undefined) s.ok = patch.ok;
        if (patch?.meta) s.meta = { ...(s.meta ?? {}), ...patch.meta };
      },
      set: (m) => void (s.meta = { ...(s.meta ?? {}), ...m }),
      elapsed: () => this.now() - this.t0 - s.start,
    };
  }

  async time<T>(kind: SpanKind, label: string, fn: () => Promise<T>, meta?: Meta, okOf?: (v: T) => boolean): Promise<T> {
    const h = this.begin(kind, label, meta);
    try {
      const v = await fn();
      h.end({ ok: okOf ? okOf(v) : true });
      return v;
    } catch (err) {
      h.end({ ok: false });
      throw err;
    }
  }

  mark(label: string): void {
    if (!this.ended && this.marks.length < 50) this.marks.push(label);
  }

  /** Close the request (idempotent): attribute the time, then hand it to onEnd. */
  end(info: RequestInfo = this.info()): RequestTiming {
    if (this.ended) return this.ended;
    const total = Math.max(0, this.now() - this.t0);
    for (const s of this.open) s.end = total; // e.g. a stream nobody finished reading
    this.open.clear();
    const spans = this.spans.filter((s) => !(s.kind === 'pacer' && s.end - s.start < 5)); // instant slots are noise
    if (this.receivedAt !== undefined) spans.unshift({ kind: 'receive', label: 'telegram→hub', start: this.receivedAt - this.t0, end: 0 });
    const byCategory = attribute(spans, total);
    const gem = spans.filter((s) => s.kind === 'gemini');
    const geminiErrors: Record<string, number> = {};
    for (const g of gem) if (g.ok === false) geminiErrors[String(g.meta?.status ?? 'error')] = (geminiErrors[String(g.meta?.status ?? 'error')] ?? 0) + 1;
    const tools = spans.filter((s) => s.kind === 'tool');
    this.ended = {
      ...info,
      requestId: this.requestId,
      ts: this.t0,
      totalMs: total,
      activeMs: total - byCategory.poll,
      ...(this.receivedAt !== undefined ? { queueMs: this.t0 - this.receivedAt } : {}),
      byCategory,
      geminiCalls: gem.length,
      geminiRetries: gem.filter((g) => Number(g.meta?.attempt ?? 0) > 0).length,
      geminiErrors,
      toolCalls: tools.length,
      toolErrors: tools.filter((t) => t.ok === false).length,
      dominant: dominantOf(byCategory, spans),
      marks: [...this.marks],
      spans,
    };
    try {
      this.opts.onEnd?.(this.ended);
    } catch {
      /* telemetry never breaks a request */
    }
    return this.ended;
  }
}

/** Exclusive time per category over [0, total]: each instant goes to its highest-priority span. */
export function attribute(spans: readonly Span[], total: number): Record<Category, number> {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const counted = spans.filter((s) => PRIORITY.some(([k]) => k === s.kind) && s.end > s.start);
  const cuts = new Set<number>([0, total]);
  for (const s of counted) {
    cuts.add(Math.min(total, Math.max(0, s.start)));
    cuts.add(Math.min(total, Math.max(0, s.end)));
  }
  const points = [...cuts].sort((a, b) => a - b);
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (b <= a) continue;
    let cat: Category = 'hub';
    for (const [kind, c] of PRIORITY) {
      if (counted.some((s) => s.kind === kind && s.start <= a && s.end >= b)) {
        cat = c;
        break;
      }
    }
    out[cat] += b - a;
  }
  return out;
}

function categoryOf(kind: SpanKind): Category | undefined {
  return PRIORITY.find(([k]) => k === kind)?.[1];
}

function dominantOf(byCategory: Record<Category, number>, spans: readonly Span[]): RequestTiming['dominant'] {
  const active = CATEGORIES.filter((c) => c !== 'poll');
  const category = active.reduce((best, c) => (byCategory[c] > byCategory[best] ? c : best), 'hub' as Category);
  const longest = spans.filter((s) => categoryOf(s.kind) === category).sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  return { category, ms: byCategory[category], ...(longest ? { label: longest.label, spanMs: longest.end - longest.start } : {}) };
}

/** The request's timer, if any (no timer = nothing is recorded). */
export function currentTimer(): RequestTimer | undefined {
  const t = usageContext.getStore()?.timer;
  return t && !t.done ? t : undefined;
}

/** Open a span on the current request (no-op outside a request). */
export function span(kind: SpanKind, label: string, meta?: Meta): SpanHandle {
  return currentTimer()?.begin(kind, label, meta) ?? NOOP;
}

/** Time an async step on the current request. */
export function timed<T>(kind: SpanKind, label: string, fn: () => Promise<T>, meta?: Meta, okOf?: (v: T) => boolean): Promise<T> {
  const t = currentTimer();
  return t ? t.time(kind, label, fn, meta, okOf) : fn();
}

/** Record an instant event (a guard retry, an escalation) on the current request. */
export function markTiming(label: string): void {
  currentTimer()?.mark(label);
}

const s1 = (ms: number) => `${Math.round(ms)}ms`;

/** `[timing] total=…ms gemini=…(n) tools=…(n) pacer=… telegram=… hub=… poll=…` (the caller adds `[req X]`). */
export function timingLine(t: RequestTiming): string {
  const c = t.byCategory;
  const errs = Object.entries(t.geminiErrors).map(([s, n]) => `${s}×${n}`).join(',');
  return [
    '[timing]',
    `total=${s1(t.totalMs)}`,
    ...(c.poll ? [`active=${s1(t.activeMs)}`] : []),
    `gemini=${s1(c.gemini)}(${t.geminiCalls}${errs ? ` ${errs}` : ''})`,
    `tools=${s1(c.tools)}(${t.toolCalls}${t.toolErrors ? ` err ${t.toolErrors}` : ''})`,
    `pacer=${s1(c.pacer)}`,
    `telegram=${s1(c.telegram)}`,
    `hub=${s1(c.hub)}`,
    ...(c.poll ? [`poll=${s1(c.poll)}`] : []),
    ...(t.queueMs !== undefined ? [`queue=${s1(t.queueMs)}`] : []),
    `intent=${t.intent}${t.media !== 'text' ? `/${t.media}` : ''}`,
    `dominant=${t.dominant.category}${t.dominant.label ? `:${t.dominant.label}` : ''}`,
    ...(t.marks.length ? [`marks=${t.marks.join(',')}`] : []),
  ].join(' ');
}

/** One row per request (for /velocidad) plus its spans (for deep dives). 30 days. */
export const TIMING_KEEP_MS = 30 * 24 * 60 * 60_000;

export interface TimingRow {
  requestId: string;
  ts: number;
  intent: string;
  media: string;
  kind: string;
  totalMs: number;
  activeMs: number;
  queueMs?: number;
  byCategory: Record<Category, number>;
  geminiCalls: number;
  geminiRetries: number;
  toolCalls: number;
  toolErrors: number;
  dominant: RequestTiming['dominant'];
  marks: string[];
}

export class TimingLog {
  private ready?: Promise<void>;
  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  private init(): Promise<void> {
    this.ready ??= this.client
      .batch(
        [
          `CREATE TABLE IF NOT EXISTS request_timings (
            request_id TEXT NOT NULL, ts INTEGER NOT NULL, intent TEXT NOT NULL, media TEXT NOT NULL, kind TEXT NOT NULL,
            total_ms INTEGER NOT NULL, active_ms INTEGER NOT NULL, queue_ms INTEGER, gemini_ms INTEGER NOT NULL,
            pacer_ms INTEGER NOT NULL, tools_ms INTEGER NOT NULL, telegram_ms INTEGER NOT NULL, poll_ms INTEGER NOT NULL,
            hub_ms INTEGER NOT NULL, gemini_calls INTEGER NOT NULL, gemini_retries INTEGER NOT NULL, tool_calls INTEGER NOT NULL,
            tool_errors INTEGER NOT NULL, dominant TEXT NOT NULL, marks TEXT NOT NULL)`,
          'CREATE INDEX IF NOT EXISTS request_timings_ts ON request_timings (ts)',
          `CREATE TABLE IF NOT EXISTS request_spans (
            id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL,
            label TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, ok INTEGER, meta TEXT)`,
          'CREATE INDEX IF NOT EXISTS request_spans_req ON request_spans (request_id)',
          'CREATE INDEX IF NOT EXISTS request_spans_ts ON request_spans (ts)',
        ],
        'write',
      )
      .then(() => undefined);
    return this.ready;
  }

  async record(t: RequestTiming): Promise<void> {
    await this.init();
    const c = t.byCategory;
    const stmts = [
      {
        sql: `INSERT INTO request_timings (request_id, ts, intent, media, kind, total_ms, active_ms, queue_ms, gemini_ms, pacer_ms, tools_ms,
              telegram_ms, poll_ms, hub_ms, gemini_calls, gemini_retries, tool_calls, tool_errors, dominant, marks)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [t.requestId, t.ts, t.intent, t.media, t.kind, Math.round(t.totalMs), Math.round(t.activeMs), t.queueMs ?? null, Math.round(c.gemini), Math.round(c.pacer),
          Math.round(c.tools), Math.round(c.telegram), Math.round(c.poll), Math.round(c.hub), t.geminiCalls, t.geminiRetries, t.toolCalls, t.toolErrors,
          JSON.stringify(t.dominant), t.marks.join(',')],
      },
      ...t.spans.map((s) => ({
        sql: 'INSERT INTO request_spans (request_id, ts, kind, label, start_ms, end_ms, ok, meta) VALUES (?,?,?,?,?,?,?,?)',
        args: [t.requestId, t.ts, s.kind, s.label, Math.round(s.start), Math.round(s.end), s.ok === undefined ? null : s.ok ? 1 : 0, s.meta ? JSON.stringify(s.meta) : null],
      })),
    ];
    await this.client.batch(stmts, 'write');
    if (Math.random() < 0.02) await this.prune();
  }

  async prune(): Promise<void> {
    await this.init();
    const cut = this.now() - TIMING_KEEP_MS;
    await this.client.batch([{ sql: 'DELETE FROM request_timings WHERE ts < ?', args: [cut] }, { sql: 'DELETE FROM request_spans WHERE ts < ?', args: [cut] }], 'write');
  }

  async rows(since: number): Promise<TimingRow[]> {
    await this.init();
    const rs = await this.client.execute({ sql: 'SELECT * FROM request_timings WHERE ts >= ? ORDER BY ts', args: [since] });
    return rs.rows.map((x) => ({
      requestId: String(x.request_id), ts: Number(x.ts), intent: String(x.intent), media: String(x.media), kind: String(x.kind),
      totalMs: Number(x.total_ms), activeMs: Number(x.active_ms), ...(x.queue_ms === null ? {} : { queueMs: Number(x.queue_ms) }),
      byCategory: { gemini: Number(x.gemini_ms), pacer: Number(x.pacer_ms), tools: Number(x.tools_ms), telegram: Number(x.telegram_ms), poll: Number(x.poll_ms), hub: Number(x.hub_ms) },
      geminiCalls: Number(x.gemini_calls), geminiRetries: Number(x.gemini_retries), toolCalls: Number(x.tool_calls), toolErrors: Number(x.tool_errors),
      dominant: JSON.parse(String(x.dominant)), marks: String(x.marks) ? String(x.marks).split(',') : [],
    }));
  }

  async spans(requestId: string): Promise<Span[]> {
    await this.init();
    const rs = await this.client.execute({ sql: 'SELECT * FROM request_spans WHERE request_id = ? ORDER BY start_ms, id', args: [requestId] });
    return rs.rows.map((x) => ({
      kind: String(x.kind) as SpanKind, label: String(x.label), start: Number(x.start_ms), end: Number(x.end_ms),
      ...(x.ok === null ? {} : { ok: Number(x.ok) === 1 }), ...(x.meta ? { meta: JSON.parse(String(x.meta)) } : {}),
    }));
  }
}

const TELEGRAM_METHOD = /\/bot[^/]+\/(\w+)(?:\?|$)/;
const TELEGRAM_FILE = /\/file\/bot[^/]+\//;
const INSTALLED = Symbol.for('assistant-hub.timedFetch');

/**
 * Time Bot API calls made inside a request (the Mastra Telegram adapter and the hub's own
 * TelegramApi both use the global fetch). Only the method name is recorded, never the URL
 * (it carries the bot token) or the body. getUpdates (long polling) is never a request span.
 * Idempotent; a passthrough for everything else.
 */
export function instrumentTelegramFetch(): void {
  const g = globalThis as unknown as { fetch: typeof fetch & { [INSTALLED]?: true } };
  if (g.fetch[INSTALLED]) return;
  const orig = g.fetch;
  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const t = currentTimer();
    if (!t) return orig(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = TELEGRAM_FILE.test(url) ? 'getFile' : url.match(TELEGRAM_METHOD)?.[1];
    if (!method || method === 'getUpdates') return orig(input, init);
    const h = t.begin('telegram', method);
    try {
      const res = await orig(input, init);
      h.end({ ok: res.ok, ...(res.ok ? {} : { meta: { status: res.status } }) });
      return res;
    } catch (err) {
      h.end({ ok: false });
      throw err;
    }
  }) as typeof fetch & { [INSTALLED]?: true };
  wrapped[INSTALLED] = true;
  g.fetch = wrapped;
}
