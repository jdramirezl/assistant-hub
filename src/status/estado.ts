/** `/estado`: compact health of the hub, answered without a model call. */
import type { KvStore } from '../kv.js';
import type { CallRow } from '../telemetry/usage-log.js';
import { appName, type Lang } from './errors.js';
import type { FailureRecord } from './tracker.js';

const FAILURES_KEY = 'status:failures';
const KEEP = 20;

/** Keep the last failures (request id, code, message) for /estado. */
export async function recordFailure(kv: KvStore, f: FailureRecord): Promise<void> {
  const list = ((await kv.get<FailureRecord[]>(FAILURES_KEY)) ?? []).concat(f).slice(-KEEP);
  await kv.set(FAILURES_KEY, list, 30 * 86_400_000);
}
export async function recentFailures(kv: KvStore, n = 3): Promise<FailureRecord[]> {
  return ((await kv.get<FailureRecord[]>(FAILURES_KEY)) ?? []).slice(-n).reverse();
}

export interface EstadoInput {
  lang: Lang;
  version: string;
  now: number;
  timezone: string;
  services: Record<string, { state: string; tools?: number; reason?: string; since?: number }>;
  /** llm_calls rows of today (local day). */
  today: CallRow[];
  budget: { tokens: number; costUsd: number; tokenCap: number; costCapUsd: number };
  failures: FailureRecord[];
}

const dur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

export function formatEstado(i: EstadoInput): string {
  const es = i.lang === 'es';
  const lines = [`📊 ${es ? 'Estado' : 'Status'} · ${es ? 'versión' : 'version'} ${i.version}`];
  for (const [name, s] of Object.entries(i.services)) {
    if (name === 'echo' && s.state === 'skipped') continue;
    const since = s.since !== undefined ? dur(i.now - s.since) : '';
    const app = appName(name, i.lang);
    if (s.state === 'up') lines.push(`🟢 ${app}: ${s.tools} ${es ? 'herramientas' : 'tools'}${since ? ` · ${es ? 'arriba' : 'up'} ${since}` : ''}`);
    else if (s.state === 'down') lines.push(`🔴 ${app}: ${es ? 'caído' : 'down'}${since ? ` ${since}` : ''} (${(s.reason ?? '').slice(0, 60)})`);
    else lines.push(`⚪ ${app}: ${es ? 'no configurado aquí' : 'not configured here'}`);
  }
  const byModel = new Map<string, { ok: number; limited: number }>();
  for (const r of i.today) {
    const m = byModel.get(r.model) ?? { ok: 0, limited: 0 };
    if (r.status === 429) m.limited++;
    else m.ok++;
    byModel.set(r.model, m);
  }
  let peak = 0;
  const ts = i.today.map((r) => r.ts).sort((a, b) => a - b);
  for (let a = 0, b = 0; b < ts.length; b++) {
    while (ts[b]! - ts[a]! >= 60_000) a++;
    peak = Math.max(peak, b - a + 1);
  }
  const models = [...byModel].map(([m, v]) => `${m.replace(/^gemini-/, '')} ${v.ok}${v.limited ? ` (+${v.limited}×429)` : ''}`).join(' · ');
  lines.push(`🤖 Gemini ${es ? 'hoy' : 'today'}: ${models || (es ? 'sin llamadas' : 'no calls')}${peak ? ` · ${es ? 'pico' : 'peak'} ${peak}/min` : ''}`);
  lines.push(`💸 ${es ? 'Presupuesto' : 'Budget'}: ${k(i.budget.tokens)} / ${k(i.budget.tokenCap)} tokens · US$${i.budget.costUsd.toFixed(2)} / US$${i.budget.costCapUsd.toFixed(2)}`);
  if (i.failures.length) {
    lines.push(`⚠️ ${es ? 'Últimos fallos' : 'Last failures'}:`);
    const t = (at: number) => new Intl.DateTimeFormat('en-GB', { timeZone: i.timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
    for (const f of i.failures) lines.push(`• ${t(f.at)} ${f.code} · req ${f.requestId} — ${f.text.replace(/^\S+\s/, '').slice(0, 80)}`);
  } else lines.push(`✅ ${es ? 'Sin fallos recientes' : 'No recent failures'}`);
  return lines.join('\n');
}
