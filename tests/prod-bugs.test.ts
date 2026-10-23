/** Regression tests for the first real voice notes on the server Mac (hub e496959). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHub, optionalAccountId, type Hub } from '../src/hub.js';
import { McpToolbox } from '../src/mcp/toolbox.js';
import { parseRegistry } from '../src/mcp/registry.js';
import { testConfig } from './helpers.js';
import { scriptedModel, lastToolResult, type Turn } from './support/scripted-model.js';
import { MockTelegram, textUpdate, voiceUpdate } from './support/mock-telegram.js';
import { MFP_REGISTRY, startFakeMason, type FakeMason } from './support/fake-mason.js';
import { startFakeFinance, type FakeFinance } from './support/fake-finance.js';

const ME = 42;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

describe('bug 1: Mason restarted (MCP "Session not found")', () => {
  it('the toolbox re-initializes and retries the call once, without marking the app down', async () => {
    const mason = await startFakeMason();
    closers.push(mason.close);
    const logs: string[] = [];
    const tb = new McpToolbox(parseRegistry(MFP_REGISTRY(mason.url)), {}, { log: (m) => logs.push(m) });
    closers.push(() => tb.close());
    expect(await tb.execute('fitness_get_day', {})).toMatchObject({ diary: [] });
    mason.restart();
    expect(await tb.execute('fitness_get_day', {})).toMatchObject({ diary: [] });
    expect(logs.join('\n')).toMatch(/session lost .* retrying fitness_get_day once/);
    expect(logs.join('\n')).not.toMatch(/mfp: down/);
    expect(tb.status().mfp).toMatchObject({ state: 'up' });
    // a write after a restart (rejected before dispatch) also goes through, exactly once
    mason.restart();
    await tb.execute('fitness_log_food', { query: 'egg', quantity: 1, meal: 'breakfast' });
    expect(mason.diary).toHaveLength(1);
  });

  it('parallel calls on the dead session reconnect once and all succeed', async () => {
    const mason = await startFakeMason();
    closers.push(mason.close);
    const logs: string[] = [];
    const tb = new McpToolbox(parseRegistry(MFP_REGISTRY(mason.url)), {}, { log: (m) => logs.push(m) });
    closers.push(() => tb.close());
    await tb.getTools();
    mason.restart();
    const out = await Promise.all([1, 2, 3].map(() => tb.execute('fitness_get_day', {})));
    for (const o of out) expect(o).toMatchObject({ diary: [] });
    expect(logs.join('\n')).not.toMatch(/mfp: down/);
  });
});

describe('bugs 2 + 4: the mixed voice note (meal + 3 expenses from a pocket)', () => {
  let tg: MockTelegram;
  let mason: FakeMason;
  let fin: FakeFinance;
  async function boot(script: Turn[], transcript = '') {
    tg = await new MockTelegram().start();
    closers.push(() => tg.stop());
    mason = await startFakeMason();
    closers.push(mason.close);
    fin = await startFakeFinance('t');
    closers.push(fin.close);
    const sm = scriptedModel(script);
    const tm = scriptedModel([{ text: JSON.stringify({ transcript, language: 'es' }) }]);
    const logs: string[] = [];
    const hub: Hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME) }), {
      model: sm.model as never,
      transcribeModel: tm.model,
      registry: { servers: { ...MFP_REGISTRY(mason.url).servers, finance: { url: fin.url, headers: { Authorization: { env: 'T', prefix: 'Bearer ' } } } } },
      env: { T: 't' },
      telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: (m) => logs.push(m) },
    });
    closers.push(() => hub.stop());
    await hub.start();
    return { sm, logs, hub };
  }
  const mov = (amount: number) => ({ tool: 'finance_create_movement', args: { pocketId: 'pk-nequi-main', type: 'EgresoNormal', amount, date: '2026-10-19', description: 'x' } });

  it('accountId is filled from the pocket; pockets are listed with their accountId; a Mason restart is transparent', async () => {
    const { sm, logs } = await boot(
      [{ calls: [{ tool: 'log_meal', args: { items: [{ query: 'rice', quantity: 1, unit: 'cup', kcal_estimate: 200, meal: 'lunch' }] } }, mov(18000), mov(5000), mov(12000)] }, { text: 'Listo: almuerzo y 3 gastos.' }],
      'almorcé arroz y pagué 18 mil, 5 mil y 12 mil del bolsillo Principal de Nequi',
    );
    mason.restart(); // like mfpctl restart while the hub keeps running
    tg.addFile('v', { path: 'v.oga', mime: 'audio/ogg', bytes: Buffer.from('OggS fake audio') });
    tg.push(voiceUpdate(ME, 'v'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('Listo'), 10_000);
    expect(tg.outgoingText(ME)).toMatch(/📥 Nota recibida, Master Julian\. Transcribiendo…/); // voice notes are acknowledged
    const creates = fin.calls.filter((c) => c.tool === 'finance_create_movement');
    expect(creates.map((c) => [c.input.accountId, c.input.amount])).toEqual([
      ['acc-nequi', 18000],
      ['acc-nequi', 5000],
      ['acc-nequi', 12000],
    ]);
    expect(mason.diary).toHaveLength(1);
    expect(logs.join('\n')).not.toMatch(/mfp: down/);
    expect(JSON.stringify(sm.calls[0]!.prompt)).toMatch(/pocket Principal id=pk-nequi-main accountId=acc-nequi/);
  });

  it('a validation error goes back to the model as a tool result, and the model gets another step', async () => {
    const { sm } = await boot([
      { tool: 'finance_create_movement', args: { pocketId: 'pk-unknown', type: 'EgresoNormal', amount: 1000, date: '2026-10-19' } },
      { tool: 'log_meal', args: { items: [{ query: 'egg', quantity: 1, unit: 'unit', kcal_estimate: -5, meal: 'breakfast' }] } },
      () => ({ text: 'corrijo los datos' }),
    ]);
    tg.push(textUpdate(ME, 'gasté 1000 en Nequi y comí un huevo'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('corrijo'), 10_000);
    expect(sm.calls).toHaveLength(3);
    expect(JSON.stringify(sm.calls[1]!.prompt)).toMatch(/pk-unknown is not a pocket id/); // checked against the cached pockets
    expect(JSON.stringify(sm.calls[2]!.prompt)).toMatch(/kcal_estimate/);
  });

  it('kcal_estimate 0 is valid (gum, water, black coffee)', async () => {
    const { sm } = await boot([
      { tool: 'log_meal', args: { items: [{ query: 'egg', quantity: 1, unit: 'unit', kcal_estimate: 70, meal: 'snacks' }, { query: 'coffee', quantity: 1, unit: 'cup', kcal_estimate: 0, meal: 'snacks' }] } },
      (p) => ({ text: `ok ${lastToolResult(p).slice(0, 300)}` }),
    ]);
    tg.push(textUpdate(ME, 'de merienda un huevo y un café negro'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('ok '), 10_000);
    expect(JSON.stringify(sm.calls[1]!.prompt)).not.toMatch(/validation failed/i);
    expect(mason.diary.map((e) => e.name)).toEqual(['Egg, whole, large', 'Coffee, black']);
  });
});

describe('schema handling', () => {
  it('accountId becomes optional only when the tool has a pocketId', () => {
    expect(optionalAccountId({ properties: { accountId: {}, pocketId: {} }, required: ['accountId', 'amount'] })).toMatchObject({ required: ['amount'] });
    expect(optionalAccountId({ properties: { accountId: {} }, required: ['accountId'] })).toMatchObject({ required: ['accountId'] });
  });

  it('no "unknown format" warnings on tool calls', async () => {
    const warn = vi.spyOn(console, 'warn');
    // the replica serves finance-app's exact tool definitions (format: uuid)
    const { startFinanceReplica, ACCOUNTS, POCKETS } = await import('./replay/replica.js');
    const fin = await startFinanceReplica({ diary: [], pins: [], actions: [], calls: [], movements: [] }, '2026-10-19', 't');
    closers.push(fin.close);
    const reg = parseRegistry({ servers: { finance: { url: fin.url, headers: { Authorization: { env: 'T', prefix: 'Bearer ' } } } } });
    const tb = new McpToolbox(reg, { T: 't' }, { log: () => {} });
    closers.push(() => tb.close());
    const tools = (await tb.getTools()) as Record<string, { execute(i: unknown, c: unknown): Promise<unknown> }>;
    const r = await tools.finance_create_movement!.execute({ accountId: ACCOUNTS[0]!.id, pocketId: POCKETS[0]!.id, type: 'EgresoNormal', amount: 1, displayedDate: '2026-10-19' }, {});
    expect(r).toMatchObject({ amount: 1 });
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/unknown format/);
    warn.mockRestore();
  });
});
