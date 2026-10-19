import { afterEach, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel } from './support/scripted-model.js';
import { MockTelegram, textUpdate } from './support/mock-telegram.js';
import { startFakeFinance, type FakeFinance } from './support/fake-finance.js';
import { SAVE_CLAIM } from '../src/guards/false-save.js';

const ME = 42;
let tg: MockTelegram;
let fin: FakeFinance;
const hubs: Hub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.stop()));
  await tg?.stop();
  await fin?.close();
});

async function boot(script: Parameters<typeof scriptedModel>[0]) {
  tg = await new MockTelegram().start();
  fin = await startFakeFinance('t');
  const sm = scriptedModel(script);
  const hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME) }), {
    model: sm.model as never,
    registry: { servers: { finance: { url: fin.url, headers: { Authorization: { env: 'T', prefix: 'Bearer ' } } } } },
    env: { T: 't' },
    telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: () => {} },
  });
  hubs.push(hub);
  await hub.start();
  return sm;
}
const settle = () => new Promise((r) => setTimeout(r, 600));
const CLAIM = 'Muy bien, Amo Julián. Queda registrado: $25.000 COP en Nequi (Almuerzo).';

describe('false save guard', () => {
  it('"gasté 25k en almuerzo con Nequi" → no tool call → text-only claim, twice: the user sees "no lo guardé", never the claim', async () => {
    const sm = await boot([{ text: CLAIM }, { text: CLAIM }]);
    tg.push(textUpdate(ME, 'gasté 25k en almuerzo con Nequi'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('no lo guardé'));
    await settle();
    expect(tg.outgoingText(ME)).toMatch(/⚠️ Le pido disculpas, Amo Julián: no lo guardé\. ¿Lo registro\?/);
    expect(tg.outgoingText(ME)).not.toContain('Queda registrado');
    expect(sm.calls).toHaveLength(2); // one retry with feedback
    expect(JSON.stringify(sm.calls[1]!.prompt)).toMatch(/no write tool succeeded/);
    expect(fin.calls.some((c) => c.tool === 'finance_create_movement')).toBe(false);
  });

  it('the retry lets the model actually save it; then the claim is fine', async () => {
    const sm = await boot([
      { text: CLAIM },
      { tool: 'finance_create_movement', args: { accountId: 'acc-nequi', type: 'EgresoNormal', amount: 25000, date: '2026-10-19' } },
      { text: CLAIM },
    ]);
    tg.push(textUpdate(ME, 'gasté 25k en almuerzo con Nequi'));
    await tg.waitFor(() => fin.calls.some((c) => c.tool === 'finance_create_movement'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('Queda registrado'));
    expect(tg.outgoingText(ME)).not.toContain('no lo guardé');
    expect(sm.calls).toHaveLength(3);
  });

  it('a failed write (VALIDATION_ERROR) does not count as saved', async () => {
    const sm = await boot([
      { tool: 'finance_create_movement', args: { accountId: 'acc-nequi', type: 'EgresoNormal', amount: 25000, date: 'hoy' } },
      { text: CLAIM },
      { text: CLAIM },
    ]);
    tg.push(textUpdate(ME, 'gasté 25k en almuerzo con Nequi'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('no lo guardé'));
    expect(tg.outgoingText(ME)).not.toContain('Queda registrado');
    expect(sm.calls).toHaveLength(3);
  });

  it('questions and reads are not touched', async () => {
    const sm = await boot([{ text: '¿En qué cuenta lo registro, Amo Julián?' }, { text: 'Este mes gastó 120.000 COP; registré todo bien.' }]);
    tg.push(textUpdate(ME, 'gasté 25k en almuerzo'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('¿En qué cuenta'));
    tg.push(textUpdate(ME, '¿cuánto gasté este mes?')); // finance-read: not a write intent
    await tg.waitFor(() => tg.outgoingText(ME).includes('120.000'));
    await settle();
    expect(tg.outgoingText(ME)).not.toContain('no lo guardé');
    expect(sm.calls).toHaveLength(2);
  });

  it('claim detection', () => {
    for (const t of ['Queda registrado', 'He anotado el gasto', 'Listo ✅', 'Logged your breakfast', 'Eliminé 3 entradas']) expect(SAVE_CLAIM.test(t)).toBe(true);
    for (const t of ['¿Cuál prefiere?', 'Este mes gastó 120.000 COP']) expect(SAVE_CLAIM.test(t)).toBe(false);
  });
});

describe('false save guard: reads are never touched', () => {
  it('"¿qué comí hoy?" answered with "hoy ha registrado…" keeps the reply', async () => {
    const sm = await boot([{ text: 'Hoy ha registrado 3 alimentos en el desayuno: 279 kcal.' }]);
    tg.push(textUpdate(ME, '¿qué comí hoy?'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('279 kcal'));
    expect(tg.outgoingText(ME)).not.toContain('no lo guardé');
    expect(sm.calls).toHaveLength(1);
  });
});

describe('false save guard: other MyFitnessPal writes', () => {
  it('"tomé 500 ml de agua" answered with "Agua registrada" and no tool → not saved notice', async () => {
    const sm = await boot([{ text: 'Muy bien, amo Julián. Agua registrada: 500 ml.' }, { text: 'Agua registrada.' }]);
    tg.push(textUpdate(ME, 'tomé 500 ml de agua'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('no lo guardé'));
    expect(tg.outgoingText(ME)).not.toContain('Agua registrada');
    expect(sm.calls).toHaveLength(2);
  });
});
