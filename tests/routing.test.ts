import { afterEach, describe, expect, it } from 'vitest';
import { domainsFor } from '../src/telemetry/intent.js';
import { buildInstructions } from '../src/agents/assistant.js';
import { createHub, toolsForDomains, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel } from './support/scripted-model.js';
import { MockTelegram, textUpdate, voiceUpdate } from './support/mock-telegram.js';
import { MFP_REGISTRY, startFakeMason, type FakeMason } from './support/fake-mason.js';
import { startFakeFinance } from './support/fake-finance.js';

describe('domainsFor (keyword router, no model call)', () => {
  it.each([
    ['registra 2 huevos y una tostada en el desayuno', ['fitness']],
    ['¿qué comí hoy?', ['fitness']],
    ['borra todo el desayuno de hoy', ['fitness']],
    ['hoy pesé 78.5 kg', ['fitness']],
    ['gasté 25k en almuerzo con Nequi', ['finance']],
    ['¿cuánto gasté este mes?', ['finance']],
    ['pasa 200 mil de Bancolombia a Nequi', ['finance']],
    ['almorcé una arepa con queso y pagué 18 mil con Nequi', ['fitness', 'finance']],
    ['hola Alfred', ['fitness', 'finance']],
    ['sí, la segunda', ['fitness', 'finance']],
  ])('%s → %j', (text, domains) => {
    expect(domainsFor(text)).toEqual(domains);
  });
  it('voice notes and captionless media get everything; a captioned receipt follows the caption', () => {
    expect(domainsFor('', 'voice')).toEqual(['fitness', 'finance']);
    expect(domainsFor('', 'photo')).toEqual(['fitness', 'finance']);
    expect(domainsFor('registra este gasto, lo pagué con Nequi', 'photo')).toEqual(['finance']);
  });
});

describe('per-domain prompt and tools', () => {
  it('domain rules are only included for their domain', () => {
    const fin = buildInstructions('America/Bogota', new Date(), { domains: ['finance'] });
    const fit = buildInstructions('America/Bogota', new Date(), { domains: ['fitness'] });
    expect(fin).toContain('EgresoNormal');
    expect(fin).not.toContain('fitness_draft_food');
    expect(fit).toContain('fitness_draft_food');
    expect(fit).not.toContain('EgresoNormal');
    expect(buildInstructions('America/Bogota')).toMatch(/fitness_draft_food[\s\S]*EgresoNormal/);
    for (const t of [fin, fit]) expect(t).toContain('propose_plan'); // batch rule is shared
  });
  it('toolsForDomains keeps non-app tools', () => {
    const t = { fitness_get_day: 1, finance_list_accounts: 2, propose_plan: 3, other: 4 };
    expect(Object.keys(toolsForDomains(t, ['finance']))).toEqual(['finance_list_accounts', 'propose_plan', 'other']);
    expect(toolsForDomains(t, undefined)).toBe(t);
  });
});

describe('through Telegram', () => {
  let tg: MockTelegram;
  let mason: FakeMason;
  const closers: (() => Promise<void>)[] = [];
  const hubs: Hub[] = [];
  afterEach(async () => {
    await Promise.all(hubs.splice(0).map((h) => h.stop()));
    for (const c of closers.splice(0)) await c();
  });
  async function boot(script: Parameters<typeof scriptedModel>[0]) {
    tg = await new MockTelegram().start();
    closers.push(() => tg.stop());
    mason = await startFakeMason();
    closers.push(mason.close);
    const fin = await startFakeFinance('t');
    closers.push(fin.close);
    const sm = scriptedModel(script);
    const hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: '42' }), {
      model: sm.model as never,
      registry: { servers: { ...MFP_REGISTRY(mason.url).servers, finance: { url: fin.url, headers: { Authorization: { env: 'T', prefix: 'Bearer ' } } } } },
      env: { T: 't' },
      telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: () => {} },
    });
    hubs.push(hub);
    await hub.start();
    return sm;
  }
  it('an expense gets only finance tools (+ propose_plan); a meal only fitness tools', async () => {
    const sm = await boot([{ text: 'ok' }, { text: 'ok' }]);
    tg.push(textUpdate(42, 'gasté 25k en almuerzo con Nequi'));
    await tg.waitFor(() => sm.calls.length === 1);
    tg.push(textUpdate(42, 'comí 2 huevos'));
    await tg.waitFor(() => sm.calls.length === 2);
    const [a, b] = sm.calls.map((c) => c.tools);
    expect(a!.some((t) => t.startsWith('fitness_'))).toBe(false);
    expect(a).toEqual(expect.arrayContaining(['finance_create_movement', 'propose_plan']));
    expect(b!.some((t) => t.startsWith('finance_'))).toBe(false);
    expect(b).toEqual(expect.arrayContaining(['fitness_log_food', 'propose_plan']));
  });
  it('a voice note gets every tool', async () => {
    const sm = await boot([{ text: 'ok' }]);
    tg.addFile('v', { path: 'v.oga', mime: 'audio/ogg', bytes: Buffer.from('OggS') });
    tg.push(voiceUpdate(42, 'v'));
    await tg.waitFor(() => sm.calls.length === 1);
    expect(sm.calls[0]!.tools).toEqual(expect.arrayContaining(['fitness_log_food', 'finance_create_movement']));
  });
});
