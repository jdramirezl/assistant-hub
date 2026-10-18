import type { KvStore } from './kv.js';

/** Sunday 19:00 in the hub timezone. */
export const DIGEST_CRON = '0 19 * * 0';
const FIRE_WEEKDAY = 0; // Sunday
const FIRE_HOUR = 19;

/** One app's contribution to the weekly digest (finance, fitness, …). */
export interface DigestSection {
  id: string;
  title: string;
  /** Return a short plain-text summary of the period, or null when there is nothing to report. */
  collect(ctx: { periodStart: number; periodEnd: number }): Promise<string | null>;
}

export interface DigestResult {
  status: 'sent' | 'skipped';
  period: string;
  text?: string;
}

export interface DigestOptions {
  kv: KvStore;
  sections: DigestSection[];
  /** Turns the collected sections into the message (runs on the report model). */
  compose: (prompt: string) => Promise<string>;
  notify: (text: string) => Promise<void>;
  timezone: string;
  now?: () => number;
  log?: (m: string) => void;
}

/** Wall-clock parts of `at` in `timezone`. */
function localParts(at: number, timezone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
      weekday: 'short',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!);
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, min: +p.minute!, s: +p.second!, weekday };
}

/** UTC ms for a local wall-clock time in `timezone` (correct across DST for zones that have it). */
function zonedTime(y: number, m: number, d: number, h: number, timezone: string): number {
  let guess = Date.UTC(y, m - 1, d, h);
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, timezone);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
    guess += Date.UTC(y, m - 1, d, h) - asUtc;
  }
  return guess;
}

/** Most recent scheduled fire time (Sunday 19:00 local) at or before `now`. */
export function lastScheduledFire(now: number, timezone: string): number {
  const p = localParts(now, timezone);
  let daysBack = (p.weekday - FIRE_WEEKDAY + 7) % 7;
  if (daysBack === 0 && p.h < FIRE_HOUR) daysBack = 7;
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d - daysBack));
  return zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), FIRE_HOUR, timezone);
}

const WEEK = 7 * 24 * 60 * 60 * 1000;
const KEEP = 60 * 24 * 60 * 60 * 1000;
const LAST_RUN_KEY = 'digest:last_period';

const REPORT_PROMPT = (period: string, body: string) =>
  [
    `Write the user's weekly digest for the week ending ${period}.`,
    'Format for Telegram: a short title line, then 3–8 bullet points, then at most 2 concrete suggestions.',
    'Use the language the user prefers (default Spanish). Only use the numbers given below; never invent data.',
    'If an app is marked unavailable, mention it in one short line at the end.',
    '',
    body,
  ].join('\n');

/**
 * Weekly digest: runs every app section, composes the result on the report model and sends
 * it. Each weekly period is sent at most once (claimed before sending), so the scheduler,
 * the startup catch-up and a retry can't double-send.
 */
export class Digest {
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly opts: DigestOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  /** Identifier of the current weekly period: the local date of its Sunday fire. */
  periodKey(at = this.now()): string {
    const fire = lastScheduledFire(at, this.opts.timezone);
    const p = localParts(fire, this.opts.timezone);
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  }

  async run({ trigger, force = false }: { trigger: string; force?: boolean }): Promise<DigestResult> {
    const period = this.periodKey();
    const claimed = await this.opts.kv.setIfNotExists(`digest:sent:${period}`, { trigger, at: this.now() }, KEEP);
    if (!claimed && !force) {
      this.log(`[digest] ${period} already sent; skipping (${trigger})`);
      return { status: 'skipped', period };
    }
    await this.opts.kv.set(LAST_RUN_KEY, period);

    const periodEnd = lastScheduledFire(this.now(), this.opts.timezone);
    const ctx = { periodStart: periodEnd - WEEK, periodEnd };
    const parts: string[] = [];
    let withData = 0;
    for (const section of this.opts.sections) {
      try {
        const text = await section.collect(ctx);
        if (text) {
          parts.push(`## ${section.title}\n${text}`);
          withData++;
        }
      } catch (err) {
        this.log(`[digest] section ${section.id} failed: ${(err as Error).message}`);
        parts.push(`## ${section.title}\n(unavailable this week)`);
      }
    }

    const text =
      withData === 0
        ? `🗓️ Weekly digest (${period}): no apps reported data yet. Connect finance or fitness to get a real summary.`
        : await this.opts.compose(REPORT_PROMPT(period, parts.join('\n\n')));
    await this.opts.notify(text);
    this.log(`[digest] ${period} sent (${trigger})`);
    return { status: 'sent', period, text };
  }

  /** True when the last completed period is older than the current one. */
  async isMissed(): Promise<boolean> {
    const last = await this.opts.kv.get<string>(LAST_RUN_KEY);
    if (last === null) {
      // First boot: record a baseline instead of sending a digest straight away.
      await this.opts.kv.set(LAST_RUN_KEY, this.periodKey());
      return false;
    }
    return last < this.periodKey();
  }

  /** At startup: send the digest the Mac slept through. Returns whether one was sent. */
  async catchUp(): Promise<boolean> {
    if (!(await this.isMissed())) return false;
    return (await this.run({ trigger: 'catch-up' })).status === 'sent';
  }
}
