import type { Client } from '@libsql/client';
import { estimateCostUsd } from '../budget.js';
import type { Language } from '../persona.js';

/** One row per Gemini HTTP call (including 429 attempts and retries). */
export interface CallRow {
  ts: number;
  requestId: string;
  seq: number;
  kind: string;
  intent: string;
  media: string;
  model: string;
  status: number;
  attempt: number;
  fallback: boolean;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  toolsSent: number;
  systemChars: number;
  bodyChars: number;
  toolsCalled: string[];
}

const KEEP_MS = 35 * 24 * 60 * 60_000;

export class UsageLog {
  private ready?: Promise<void>;
  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  private init(): Promise<void> {
    this.ready ??= this.client
      .batch(
        [
          `CREATE TABLE IF NOT EXISTS llm_calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, request_id TEXT NOT NULL, seq INTEGER NOT NULL,
            kind TEXT NOT NULL, intent TEXT NOT NULL, media TEXT NOT NULL, model TEXT NOT NULL, status INTEGER NOT NULL,
            attempt INTEGER NOT NULL, fallback INTEGER NOT NULL, input_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL, thinking_tokens INTEGER NOT NULL, tools_sent INTEGER NOT NULL,
            system_chars INTEGER NOT NULL, body_chars INTEGER NOT NULL, tools_called TEXT NOT NULL)`,
          'CREATE INDEX IF NOT EXISTS llm_calls_ts ON llm_calls (ts)',
          'CREATE INDEX IF NOT EXISTS llm_calls_req ON llm_calls (request_id)',
        ],
        'write',
      )
      .then(() => undefined);
    return this.ready;
  }

  async record(r: CallRow): Promise<void> {
    await this.init();
    await this.client.execute({
      sql: `INSERT INTO llm_calls (ts, request_id, seq, kind, intent, media, model, status, attempt, fallback, input_tokens,
            cached_tokens, output_tokens, thinking_tokens, tools_sent, system_chars, body_chars, tools_called)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [r.ts, r.requestId, r.seq, r.kind, r.intent, r.media, r.model, r.status, r.attempt, r.fallback ? 1 : 0, r.inputTokens,
        r.cachedTokens, r.outputTokens, r.thinkingTokens, r.toolsSent, r.systemChars, r.bodyChars, r.toolsCalled.join(',')],
    });
    if (Math.random() < 0.01) await this.client.execute({ sql: 'DELETE FROM llm_calls WHERE ts < ?', args: [this.now() - KEEP_MS] });
  }

  async rows(since: number, until = Infinity): Promise<CallRow[]> {
    await this.init();
    const rs = await this.client.execute({ sql: 'SELECT * FROM llm_calls WHERE ts >= ? AND ts < ? ORDER BY ts, id', args: [since, Number.isFinite(until) ? until : 8.64e15] });
    return rs.rows.map((x) => ({
      ts: Number(x.ts), requestId: String(x.request_id), seq: Number(x.seq), kind: String(x.kind), intent: String(x.intent),
      media: String(x.media), model: String(x.model), status: Number(x.status), attempt: Number(x.attempt), fallback: Number(x.fallback) === 1,
      inputTokens: Number(x.input_tokens), cachedTokens: Number(x.cached_tokens), outputTokens: Number(x.output_tokens),
      thinkingTokens: Number(x.thinking_tokens), toolsSent: Number(x.tools_sent), systemChars: Number(x.system_chars),
      bodyChars: Number(x.body_chars), toolsCalled: String(x.tools_called) ? String(x.tools_called).split(',') : [],
    }));
  }
}

export interface UsageStats {
  requests: number;
  calls: number;
  okCalls: number;
  retries: number;
  rateLimited: number;
  callsPerRequest: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  inputPerCall: number;
  cachedPct: number;
  peakRpm: number;
  costUsd: number;
  byIntent: Record<string, { requests: number; calls: number; inputTokens: number }>;
}

/** Aggregate call rows. A request that proposed a plan counts under "plan". */
export function summarize(rows: CallRow[]): UsageStats {
  const reqIntent = new Map<string, string>();
  for (const r of rows) {
    if (r.kind === 'chat' || r.kind === 'digest' || !reqIntent.has(r.requestId)) reqIntent.set(r.requestId, r.intent);
  }
  for (const r of rows) if (r.toolsCalled.includes('propose_plan') || r.kind === 'plan') reqIntent.set(r.requestId, 'plan');
  const ok = rows.filter((r) => r.status === 200);
  const byIntent: UsageStats['byIntent'] = {};
  for (const r of rows) {
    const i = reqIntent.get(r.requestId) ?? r.intent;
    byIntent[i] ??= { requests: 0, calls: 0, inputTokens: 0 };
    byIntent[i].calls++;
    byIntent[i].inputTokens += r.inputTokens;
  }
  for (const [, i] of reqIntent) {
    byIntent[i] ??= { requests: 0, calls: 0, inputTokens: 0 };
    byIntent[i].requests++;
  }
  let peak = 0;
  for (let i = 0, j = 0; j < rows.length; j++) {
    while (rows[j]!.ts - rows[i]!.ts >= 60_000) i++;
    peak = Math.max(peak, j - i + 1);
  }
  const sum = (f: (r: CallRow) => number) => ok.reduce((a, r) => a + f(r), 0);
  const input = sum((r) => r.inputTokens);
  const cached = sum((r) => r.cachedTokens);
  const requests = reqIntent.size;
  return {
    requests,
    calls: rows.length,
    okCalls: ok.length,
    retries: rows.filter((r) => r.attempt > 0).length,
    rateLimited: rows.filter((r) => r.status === 429).length,
    callsPerRequest: requests ? rows.length / requests : 0,
    inputTokens: input,
    cachedTokens: cached,
    outputTokens: sum((r) => r.outputTokens),
    inputPerCall: ok.length ? input / ok.length : 0,
    cachedPct: input ? (100 * cached) / input : 0,
    peakRpm: peak,
    costUsd: ok.reduce((a, r) => a + estimateCostUsd(r.model, { inputTokens: r.inputTokens, cachedInputTokens: r.cachedTokens, outputTokens: r.outputTokens }, r.ts), 0),
    byIntent,
  };
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(Math.round(n)));

function block(title: string, s: UsageStats, lang: Language): string {
  const es = lang === 'es';
  if (!s.calls) return `${title}: ${es ? 'sin uso' : 'no usage'}`;
  const intents = Object.entries(s.byIntent)
    .sort((a, b) => b[1].calls - a[1].calls)
    .map(([i, v]) => `${i} ${v.requests}/${v.calls}`)
    .join(' · ');
  return [
    title,
    `${es ? 'Solicitudes' : 'Requests'} ${s.requests} · ${es ? 'llamadas' : 'calls'} ${s.calls} (${s.callsPerRequest.toFixed(1)}/${es ? 'sol' : 'req'})${s.rateLimited ? ` · 429×${s.rateLimited}` : ''}`,
    `${es ? 'Entrada' : 'Input'} ${k(s.inputPerCall)}/${es ? 'llamada' : 'call'} · ${es ? 'caché' : 'cached'} ${s.cachedPct.toFixed(0)}% · ${es ? 'total' : 'total'} ${k(s.inputTokens)} in / ${k(s.outputTokens)} out`,
    `${es ? 'Pico' : 'Peak'} ${s.peakRpm} RPM · ${es ? 'costo est. (pago)' : 'est. cost (paid)'} $${s.costUsd.toFixed(3)}`,
    `${es ? 'Por intención (sol/llam)' : 'By intent (req/calls)'}: ${intents}`,
  ].join('\n');
}

export function formatUsageReport(today: UsageStats, week: UsageStats, lang: Language): string {
  return [`📊 ${lang === 'es' ? 'Uso de Gemini' : 'Gemini usage'}`, block(lang === 'es' ? '— Hoy —' : '— Today —', today, lang), block(lang === 'es' ? '— 7 días —' : '— 7 days —', week, lang)].join('\n');
}
