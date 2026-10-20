/**
 * `/velocidad`: where response time goes (request_timings), answered without a model call.
 * Latency is the ACTIVE time (handler start → final reply, minus polling loops such as waiting
 * for PayPal at the Mac), so a purchase waiting for the user does not count as "slow".
 */
import type { Lang } from './errors.js';
import { CATEGORIES, type Category, type TimingRow } from '../telemetry/timing.js';

export type Bucket = 'finance' | 'mfp' | 'cines' | 'voice' | 'chat';
export const BUCKETS: readonly Bucket[] = ['mfp', 'finance', 'cines', 'voice', 'chat'];

/** Intent group of a request (a voice note is "voice" whatever it was about). */
export function bucketOf(r: Pick<TimingRow, 'intent' | 'media'>): Bucket {
  if (r.media === 'voice') return 'voice';
  const i = r.intent;
  if (/cines/.test(i)) return 'cines';
  if (i === 'expense' || i === 'finance-read' || /-finance$/.test(i)) return 'finance';
  if (i === 'meal' || i.startsWith('mfp') || /-fitness$/.test(i)) return 'mfp';
  return 'chat';
}

/** Nearest-rank percentile of sorted values. */
export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

export interface LatencyStats {
  n: number;
  p50: number;
  p95: number;
  byBucket: Partial<Record<Bucket, { n: number; p50: number; p95: number }>>;
  /** Share of active time per category (0..100), summed over all requests. */
  share: Record<Exclude<Category, 'poll'>, number>;
  pollMs: number;
}

const ACTIVE: readonly Exclude<Category, 'poll'>[] = CATEGORIES.filter((c): c is Exclude<Category, 'poll'> => c !== 'poll');

export function latencyStats(rows: readonly TimingRow[]): LatencyStats {
  const all = rows.map((r) => r.activeMs).sort((a, b) => a - b);
  const byBucket: LatencyStats['byBucket'] = {};
  for (const b of BUCKETS) {
    const v = rows.filter((r) => bucketOf(r) === b).map((r) => r.activeMs).sort((a, c) => a - c);
    if (v.length) byBucket[b] = { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95) };
  }
  const sums = Object.fromEntries(ACTIVE.map((c) => [c, rows.reduce((a, r) => a + r.byCategory[c], 0)])) as Record<Exclude<Category, 'poll'>, number>;
  const tot = ACTIVE.reduce((a, c) => a + sums[c], 0);
  const share = Object.fromEntries(ACTIVE.map((c) => [c, tot ? (100 * sums[c]) / tot : 0])) as LatencyStats['share'];
  return { n: rows.length, p50: percentile(all, 50), p95: percentile(all, 95), byBucket, share, pollMs: rows.reduce((a, r) => a + r.byCategory.poll, 0) };
}

const sec = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

const NAMES: Record<Lang, Record<Bucket | Exclude<Category, 'poll'>, string>> = {
  es: { mfp: 'comidas', finance: 'finanzas', cines: 'cine', voice: 'voz', chat: 'charla', gemini: 'Gemini', pacer: 'espera de cuota', tools: 'apps', telegram: 'Telegram', hub: 'hub' },
  en: { mfp: 'meals', finance: 'finance', cines: 'cinema', voice: 'voice', chat: 'chat', gemini: 'Gemini', pacer: 'quota pacing', tools: 'apps', telegram: 'Telegram', hub: 'hub' },
};

function block(title: string, s: LatencyStats, lang: Lang): string[] {
  const es = lang === 'es';
  const n = NAMES[lang];
  if (!s.n) return [title, es ? 'Sin solicitudes.' : 'No requests.'];
  const lines = [title, `${s.n} ${es ? 'solicitudes' : 'requests'} · p50 ${sec(s.p50)} · p95 ${sec(s.p95)}`];
  for (const b of BUCKETS) {
    const v = s.byBucket[b];
    if (v) lines.push(`• ${n[b]} (${v.n}): p50 ${sec(v.p50)} · p95 ${sec(v.p95)}`);
  }
  const parts = ACTIVE.filter((c) => s.share[c] >= 0.5)
    .sort((a, b) => s.share[b] - s.share[a])
    .map((c) => `${n[c]} ${Math.round(s.share[c])}%`);
  lines.push(`${es ? 'El tiempo se fue en' : 'Time went to'}: ${parts.join(' · ')}`);
  if (s.pollMs) lines.push(`${es ? 'Esperas de pago (no cuentan)' : 'Payment waits (not counted)'}: ${sec(s.pollMs)}`);
  return lines;
}

export interface VelocidadInput {
  lang: Lang;
  address: string;
  timezone: string;
  day: readonly TimingRow[];
  week: readonly TimingRow[];
}

export function formatVelocidad(i: VelocidadInput): string {
  const es = i.lang === 'es';
  const n = NAMES[i.lang];
  const head = es ? `🐢 Velocidad, ${i.address}. Medida, no adivinada.` : `🐢 Speed, ${i.address}. Measured, not guessed.`;
  const week = latencyStats(i.week);
  const lines = [head, ...block(es ? '— Últimas 24 h —' : '— Last 24 h —', latencyStats(i.day), i.lang), ...block(es ? '— 7 días —' : '— 7 days —', week, i.lang)];
  const slow = [...i.week].sort((a, b) => b.activeMs - a.activeMs).slice(0, 5);
  if (slow.length) {
    lines.push(es ? '— Las 5 más lentas (7 d) —' : '— 5 slowest (7 d) —');
    const t = (at: number) => new Intl.DateTimeFormat('en-GB', { timeZone: i.timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at).replace(',', '');
    for (const r of slow) {
      const d = r.dominant;
      const what = d.category === 'poll' ? d.category : n[d.category as Exclude<Category, 'poll'>] ?? d.category;
      const extra = d.category === 'gemini' ? ` (${r.geminiCalls} ${es ? 'llamadas' : 'calls'}${r.geminiRetries ? `, ${r.geminiRetries} ${es ? 'reintentos' : 'retries'}` : ''})` : d.label ? ` (${d.label})` : '';
      lines.push(`• ${t(r.ts)} req ${r.requestId} · ${n[bucketOf(r)]} · ${sec(r.activeMs)} — ${what} ${sec(d.ms)}${extra}`);
    }
  }
  return lines.join('\n');
}
