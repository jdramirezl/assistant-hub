/**
 * Day targets by day type (rest / gimnasia / pesas), never hard-coded dates. Whether today is a
 * training day comes from, in order: what the user said (stored per date), a calendar (hook for
 * a future Calendar MCP), the usual weekly schedule (a HINT: Alfred asks lightly when it matters).
 */
import type { DayType, NutritionKv, Profile } from './profile.js';

export type DayTypeSource = 'told' | 'calendar' | 'schedule' | 'unknown';
export interface DayInfo {
  date: string;
  type?: DayType;
  source: DayTypeSource;
}
/** Future Calendar MCP: the day type for a date, or undefined when the calendar does not say. */
export type CalendarDayType = (date: string) => Promise<DayType | undefined>;

const KEY = (date: string) => `nutrition:daytype:${date}`;
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

/** An explicit statement about TODAY's training in the user's message, or undefined. */
export function dayTypeFromText(text: string | undefined): DayType | undefined {
  const t = norm(text ?? '');
  if (!/\bhoy\b|\btoday\b/.test(t)) return undefined;
  if (/\b(no (voy a |tengo |hay |hice |fui a )?(entren\w*|gimnasia|gym|pesas)|descanso|dia libre|rest day|no training)\b/.test(t)) return 'rest';
  if (/\b(pesas|weights|lifting)\b/.test(t) && /\b(tengo|hay|voy|hice|fui|toca|entren\w*|have|did)\b/.test(t)) return 'pesas';
  if (/\b(gimnasia|gym|entreno|entrene|entrenamiento|training)\b/.test(t) && /\b(tengo|hay|voy|hice|fui|toca|si|entren\w*|have|did)\b/.test(t)) return 'gimnasia';
  return undefined;
}

export class DayPlanner {
  constructor(
    private readonly profile: Profile,
    private readonly kv: NutritionKv,
    private readonly opts: { calendar?: CalendarDayType } = {},
  ) {}

  async dayType(date: string): Promise<DayInfo> {
    const told = await this.kv.get<DayType>(KEY(date));
    if (told) return { date, type: told, source: 'told' };
    const cal = await this.opts.calendar?.(date).catch(() => undefined);
    if (cal) return { date, type: cal, source: 'calendar' };
    const dow = DOW[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
    const hint = this.profile.schedule?.[dow];
    return hint ? { date, type: hint, source: 'schedule' } : { date, source: 'unknown' };
  }

  async set(date: string, type: DayType): Promise<void> {
    await this.kv.set(KEY(date), type, 3 * 86_400_000);
  }

  target(type: DayType): { kcal: [number, number]; protein: [number, number] } {
    return { kcal: this.profile.targets[type].kcal, protein: this.profile.targets.protein };
  }

  /** Day total vs target, for the readback after logging and "¿me cabe esto?". */
  async readback(date: string, totals: { kcal: number; protein?: number }): Promise<Record<string, unknown>> {
    const info = await this.dayType(date);
    const type = info.type ?? 'rest';
    const t = this.target(type);
    return {
      kcal: Math.round(totals.kcal),
      ...(totals.protein !== undefined ? { protein_g: Math.round(totals.protein) } : {}),
      target_kcal: t.kcal[0] === t.kcal[1] ? t.kcal[0] : `${t.kcal[0]}–${t.kcal[1]}`,
      target_protein_g: `${t.protein[0]}–${t.protein[1]}`,
      left_kcal: Math.round(t.kcal[1] - totals.kcal),
      day_type: type,
      day_type_source: info.type ? info.source : 'assumed rest',
    };
  }
}

const fmt = (r: [number, number]) => (r[0] === r[1] ? `~${r[0]}` : `${r[0]}–${r[1]}`);
const NAMES: Record<DayType, string> = { rest: 'rest day', gimnasia: 'gimnasia (gymnastics training)', pesas: 'weights' };

/** "## Now" lines: today's targets and whether the day type is known. */
export async function targetsNote(planner: DayPlanner, profile: Profile, today: string): Promise<string> {
  const info = await planner.dayType(today);
  const t = profile.targets;
  const known =
    info.source === 'told' || info.source === 'calendar'
      ? `Today is a ${NAMES[info.type!]} (${info.source === 'told' ? 'the user said so' : 'from the calendar'}).`
      : info.source === 'schedule'
        ? `Today is usually a ${NAMES[info.type!]} (weekly schedule, a HINT, not confirmed).`
        : 'Today\'s training is unknown.';
  return [
    `Day targets: rest ${fmt(t.rest.kcal)} kcal; gimnasia ${fmt(t.gimnasia.kcal)}; weights ${fmt(t.pesas.kcal)}; protein ${fmt(t.protein)} g every day. ${known}`,
    info.source === 'told' || info.source === 'calendar'
      ? ''
      : 'When the answer depends on it ("¿me cabe…?", the day total), assume the likely type, say so, and ask lightly in one short line whether they train today; when they tell you, call set_day_type.',
  ]
    .filter(Boolean)
    .join('\n');
}
