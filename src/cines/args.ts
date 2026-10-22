/**
 * Cinépolis argument hygiene, in code (the model gets these wrong live):
 * - dates: relative words (hoy, mañana, viernes…) are resolved by the hub to YYYY-MM-DD in the
 *   user's timezone; a YYYY-MM-DD in the past or > 60 days ahead (e.g. the wrong year) never
 *   reaches the server.
 * - filters the user did not ask for (vip:"exclude", format) are dropped; vip:"exclude" never
 *   applies when the user names a VIP-only cinema (Miyana).
 * - the cinemas the user named, so a filtered recommendation can be completed with what really
 *   exists there.
 */
type Rec = Record<string, unknown>;
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
export const MAX_DAYS_AHEAD = 60;

const WEEKDAYS: Record<string, number> = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

/** Today in the timezone as YYYY-MM-DD and its weekday (0 = Sunday). */
function today(timezone: string, now: number): { ymd: string; dow: number } {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return { ymd, dow };
}
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** "hoy", "mañana", "pasado mañana", "viernes", "el sábado", "tomorrow" → YYYY-MM-DD; undefined if not relative. */
export function resolveRelativeDate(word: string, timezone: string, now: number): string | undefined {
  const w = norm(word).trim().replace(/^(el|este|this|next|proximo|el proximo)\s+/, '');
  const t = today(timezone, now);
  if (/^(hoy|today|esta noche|tonight)$/.test(w)) return t.ymd;
  if (/^(manana|tomorrow)$/.test(w)) return addDays(t.ymd, 1);
  if (/^pasado manana$/.test(w)) return addDays(t.ymd, 2);
  const d = WEEKDAYS[w];
  if (d === undefined) return undefined;
  return addDays(t.ymd, (d - t.dow + 7) % 7); // today if it is that weekday
}

export type DateCheck = { date: string } | { error: string } | undefined;

/** A cines `date` argument: relative words resolved, wrong years refused (with the right date). */
export function checkDate(value: unknown, timezone: string, now: number): DateCheck {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const v = value.trim();
  const rel = resolveRelativeDate(v, timezone, now);
  if (rel) return { date: rel };
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined; // let the server parse other forms
  const t = today(timezone, now);
  const diff = daysBetween(t.ymd, v);
  if (diff >= 0 && diff <= MAX_DAYS_AHEAD) return undefined;
  // most often the wrong year: suggest the same month/day this year (or next, if already past)
  let fixed = `${t.ymd.slice(0, 4)}-${m[2]}-${m[3]}`;
  if (daysBetween(t.ymd, fixed) < 0) fixed = `${Number(t.ymd.slice(0, 4)) + 1}-${m[2]}-${m[3]}`;
  const hint = daysBetween(t.ymd, fixed) <= MAX_DAYS_AHEAD ? ` Did you mean ${fixed}?` : '';
  return { error: `date ${v} is ${diff < 0 ? 'in the past' : `more than ${MAX_DAYS_AHEAD} days ahead`} (today is ${t.ymd}).${hint} Use "hoy", "mañana", a weekday ("viernes") or a YYYY-MM-DD from the next ${MAX_DAYS_AHEAD} days.` };
}

const CINEMA_WORDS: [RegExp, string][] = [
  [/\btoreo\b/, 'toreo'],
  [/\bmiyana\b/, 'miyana'],
  [/\bcarso\b/, 'carso'],
  [/\bsatelite\b/, 'satelite'],
];
/** Cinemas the user named in the message. */
export const namedCinemas = (text: string | undefined) => CINEMA_WORDS.filter(([re]) => re.test(norm(text ?? ''))).map(([, n]) => n);

const ASKED_VIP = /\bvip\b/;
const ASKED_FORMAT = /\b(imax|4dx|xe|screenx|3d|2d|regular|macro ?xe|premium)\b/;

/** Drop filters the user did not ask for. Returns the cleaned args and what was dropped. */
export function sanitizeFilters(tool: string, args: Rec, userText: string | undefined): { args: Rec; dropped: string[] } {
  if (tool !== 'cines_best_showtime' && tool !== 'cines_showtimes') return { args, dropped: [] };
  const t = norm(userText ?? '');
  const out = { ...args };
  const dropped: string[] = [];
  if (out.vip !== undefined && out.vip !== 'any') {
    const keep = ASKED_VIP.test(t) && !(out.vip === 'exclude' && /\bmiyana\b/.test(t));
    if (!keep || (out.vip === 'exclude' && /\bmiyana\b/.test(t))) {
      dropped.push(`vip=${String(out.vip)}`);
      delete out.vip;
    }
  }
  if (out.format !== undefined && !ASKED_FORMAT.test(t) && !(String(out.format).toUpperCase() === 'VIP' && ASKED_VIP.test(t))) {
    dropped.push(`format=${String(out.format)}`);
    delete out.format;
  }
  return { args: out, dropped };
}

const WEEKDAY_WORDS = 'lunes|martes|miercoles|jueves|viernes|sabado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const RANGE_TOOLS = new Set(['cines_listings', 'cines_showtimes', 'cines_find_movie']);

/**
 * A date range in the user's words ("hasta el domingo", "este fin de semana", "esta semana",
 * "los próximos 5 días") → {date, dateTo} (YYYY-MM-DD), or undefined.
 */
export function rangeFromText(text: string | undefined, timezone: string, now: number): { date: string; dateTo: string } | undefined {
  const t = norm(text ?? '');
  const today_ = today(timezone, now);
  const until = t.match(new RegExp(`\\bhasta (?:el |la |este |el proximo )?(${WEEKDAY_WORDS}|pasado manana|manana)\\b`));
  if (until) {
    const to = resolveRelativeDate(until[1]!, timezone, now);
    if (to) return { date: today_.ymd, dateTo: to };
  }
  if (/\b(fin de semana|finde|weekend)\b/.test(t)) {
    const sat = today_.dow === 0 ? today_.ymd : addDays(today_.ymd, (6 - today_.dow + 7) % 7);
    return { date: sat, dateTo: today_.dow === 0 ? today_.ymd : addDays(sat, 1) };
  }
  if (/\b(esta semana|this week)\b/.test(t)) return { date: today_.ymd, dateTo: addDays(today_.ymd, (7 - today_.dow) % 7) };
  const n = t.match(/\b(?:los )?proximos (\d{1,2}) dias\b|\bnext (\d{1,2}) days\b/);
  if (n) {
    const days = Math.min(21, Number(n[1] ?? n[2]));
    if (days > 1) return { date: today_.ymd, dateTo: addDays(today_.ymd, days - 1) };
  }
  return undefined;
}

/**
 * Range arguments (cines-mx-mcp 6d7c617: dateTo/days): dateTo words resolved and checked like
 * `date`; a range the user asked for but the model left out is added; a range listing covers all
 * cinemas unless the user named some.
 */
export function sanitizeRange(tool: string, args: Rec, userText: string | undefined, timezone: string, now: number): { args: Rec; changes: string[]; error?: string } {
  if (!RANGE_TOOLS.has(tool)) return { args, changes: [] };
  const out = { ...args };
  const changes: string[] = [];
  if (out.dateTo !== undefined) {
    const d = checkDate(out.dateTo, timezone, now);
    if (d && 'error' in d) return { args, changes, error: `dateTo: ${d.error}` };
    if (d) out.dateTo = d.date;
  }
  const asked = rangeFromText(userText, timezone, now);
  if (asked && out.dateTo === undefined && out.days === undefined) {
    const start = typeof out.date === 'string' ? checkDate(out.date, timezone, now) : undefined;
    const startYmd = start && 'date' in start ? start.date : (out.date as string | undefined);
    if (!startYmd || startYmd === today(timezone, now).ymd || startYmd === asked.date) {
      out.date = asked.date;
      out.dateTo = asked.dateTo;
      changes.push(`dateTo=${asked.dateTo} (the user asked for a range)`);
    }
  }
  if (tool === 'cines_listings' && out.dateTo !== undefined && out.dateTo !== out.date && out.cinema !== undefined && !namedCinemas(userText).length) {
    changes.push(`cinema=${String(out.cinema)} dropped (a range covers all cinemas)`);
    delete out.cinema;
  }
  return { args: out, changes };
}
