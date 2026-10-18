import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { KvStore } from '../src/kv.js';
import { Digest, DIGEST_CRON, lastScheduledFire, type DigestSection } from '../src/digest.js';
import { createHub, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel } from './support/scripted-model.js';
import { MockTelegram } from './support/mock-telegram.js';

const TZ = 'America/Bogota';
const at = (iso: string) => Date.parse(iso);

function kv(now: () => number) {
  const d = mkdtempSync(join(tmpdir(), 'hub-digest-'));
  return new KvStore(createClient({ url: `file:${join(d, 'd.db')}` }), now);
}

describe('lastScheduledFire (Sunday 19:00 Bogota)', () => {
  it('is today 19:00 when it is Sunday after 19:00', () => {
    // Sun 2026-10-18 19:30 Bogota = 2026-10-19T00:30Z
    expect(lastScheduledFire(at('2026-10-19T00:30:00Z'), TZ)).toBe(at('2026-10-19T00:00:00Z'));
  });
  it('is last Sunday when it is Sunday before 19:00', () => {
    // Sun 2026-10-18 18:59 Bogota → previous Sunday 2026-10-11 19:00 Bogota = 2026-10-12T00:00Z
    expect(lastScheduledFire(at('2026-10-18T23:59:00Z'), TZ)).toBe(at('2026-10-12T00:00:00Z'));
  });
  it('is the previous Sunday mid-week', () => {
    // Wed 2026-10-21 10:00 Bogota
    expect(lastScheduledFire(at('2026-10-21T15:00:00Z'), TZ)).toBe(at('2026-10-19T00:00:00Z'));
  });
  it('matches the declared cron', () => {
    expect(DIGEST_CRON).toBe('0 19 * * 0');
  });
});

describe('Digest', () => {
  function make(now: () => number, sections: DigestSection[] = []) {
    const sent: string[] = [];
    const compose = vi.fn(async (prompt: string) => `RESUMEN(${prompt.length})`);
    const digest = new Digest({
      kv: kv(now),
      sections,
      compose,
      notify: async (t) => void sent.push(t),
      timezone: TZ,
      now,
      log: () => {},
    });
    return { digest, sent, compose };
  }

  it('with no app sections, sends a short skeleton message without calling the model', async () => {
    const { digest, sent, compose } = make(() => at('2026-10-19T00:01:00Z'));
    const res = await digest.run({ trigger: 'schedule' });
    expect(res.status).toBe('sent');
    expect(sent[0]).toMatch(/no apps/i);
    expect(compose).not.toHaveBeenCalled();
  });

  it('collects per-app sections and composes them on the report model', async () => {
    const fake: DigestSection = { id: 'finance', title: 'Finance', collect: async () => 'spent 300k COP this week' };
    const broken: DigestSection = { id: 'fitness', title: 'Fitness', collect: async () => { throw new Error('MFP down'); } };
    const { digest, sent, compose } = make(() => at('2026-10-19T00:01:00Z'), [fake, broken]);
    const res = await digest.run({ trigger: 'manual', force: true });
    expect(res.status).toBe('sent');
    expect(compose).toHaveBeenCalledTimes(1);
    const prompt = compose.mock.calls[0]![0];
    expect(prompt).toContain('spent 300k COP this week');
    expect(prompt).toMatch(/## Fitness\n\(unavailable/);
    expect(sent[0]).toMatch(/^RESUMEN/);
  });

  it('sends at most once per weekly period unless forced', async () => {
    const now = at('2026-10-19T00:01:00Z');
    const { digest, sent } = make(() => now);
    expect((await digest.run({ trigger: 'schedule' })).status).toBe('sent');
    expect((await digest.run({ trigger: 'catch-up' })).status).toBe('skipped');
    expect((await digest.run({ trigger: 'manual', force: true })).status).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('detects a missed run and catches up exactly once', async () => {
    let now = at('2026-10-18T20:00:00Z'); // Sun 15:00 Bogota: before this week's fire
    const { digest, sent } = make(() => now);
    await digest.run({ trigger: 'schedule' }); // covers the 2026-10-11 period
    expect(await digest.isMissed()).toBe(false);

    now = at('2026-10-20T13:00:00Z'); // Tue: the Mac was asleep on Sunday 19:00
    expect(await digest.isMissed()).toBe(true);
    expect(await digest.catchUp()).toBe(true);
    expect(await digest.catchUp()).toBe(false);
    expect(sent).toHaveLength(2);
  });

  it('never catches up on a brand-new install (no history)', async () => {
    const { digest, sent } = make(() => at('2026-10-20T13:00:00Z'));
    expect(await digest.catchUp()).toBe(false);
    expect(sent).toHaveLength(0);
    expect(await digest.isMissed()).toBe(false); // baseline recorded
  });
});

describe('weekly-digest workflow in the hub', () => {
  const hubs: Hub[] = [];
  let tg: MockTelegram | undefined;
  afterEach(async () => {
    await Promise.all(hubs.splice(0).map((h) => h.stop()));
    await tg?.stop();
    tg = undefined;
  });

  it('is registered with the Sunday 19:00 America/Bogota schedule', () => {
    const hub = createHub(testConfig(), { registry: { servers: {} } });
    hubs.push(hub);
    const wf = hub.mastra.getWorkflow('weeklyDigest');
    expect(wf.getScheduleConfigs()).toEqual([expect.objectContaining({ cron: '0 19 * * 0', timezone: 'America/Bogota' })]);
  });

  it('a manual run delivers the digest to Telegram via sendMessage', async () => {
    tg = await new MockTelegram().start();
    const fake: DigestSection = { id: 'echo', title: 'Echo', collect: async () => '3 echoes' };
    const { model } = scriptedModel([{ text: 'Tu semana: 3 echoes 👍' }]);
    const hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: '42' }), {
      model: model as never,
      registry: { servers: {} },
      digestSections: [fake],
      telegram: { apiBaseUrl: tg.url, log: () => {} },
    });
    hubs.push(hub);
    const res = await hub.runDigest({ force: true, trigger: 'manual' });
    expect(res).toMatchObject({ status: 'sent' });
    expect(tg.sent('sendMessage').map((c) => c.body)).toContainEqual(expect.objectContaining({ chat_id: '42', text: 'Tu semana: 3 echoes 👍' }));
  });

  it('falls back to the log when Telegram is not configured', async () => {
    const logs: string[] = [];
    const hub = createHub(testConfig(), { registry: { servers: {} }, telegram: { log: (m) => logs.push(m) } });
    hubs.push(hub);
    await hub.runDigest({ force: true, trigger: 'manual' });
    expect(logs.join('\n')).toMatch(/\[notify\].*no apps/i);
  });
});

describe('startup catch-up', () => {
  it('hub.start() sends the digest the Mac slept through', async () => {
    let now = at('2026-10-18T20:00:00Z'); // Sun 15:00 Bogota
    const cfg = testConfig();
    const logs: string[] = [];
    const mk = () => createHub(cfg, { registry: { servers: {} }, now: () => now, telegram: { log: (m) => logs.push(m) } });
    const first = mk();
    await first.start(); // first boot: baseline only, nothing sent
    expect(logs.join('\n')).not.toMatch(/\[notify\]/);
    await first.stop();

    now = at('2026-10-20T13:00:00Z'); // Tuesday: Sunday 19:00 was missed
    const second = mk();
    await second.start();
    expect(logs.join('\n')).toMatch(/\[digest\] 2026-10-18 sent \(catch-up\)/);
    await second.stop();
  });
});
