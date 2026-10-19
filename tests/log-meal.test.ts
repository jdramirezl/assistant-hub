import { afterEach, describe, expect, it } from 'vitest';
import { candidates, choose, servingsFor } from '../src/mcp/log-meal.js';
import { FinanceDirectory } from '../src/mcp/finance-cache.js';
import { createHub, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel, lastToolResult } from './support/scripted-model.js';
import { MFP_REGISTRY, startFakeMason, type FakeMason } from './support/fake-mason.js';
import { startFakeFinance } from './support/fake-finance.js';
import { withUsageScope } from '../src/telemetry/context.js';

const item = (o: Partial<{ query: string; quantity: number; unit: string; kcal_estimate: number; meal: 'breakfast' }> = {}) => ({ query: 'egg', quantity: 2, unit: 'unit', kcal_estimate: 150, meal: 'breakfast' as const, ...o });

describe('serving matching', () => {
  it.each([
    [{ quantity: 2, unit: 'unit' }, '1 large egg', 2],
    [{ quantity: 2, unit: 'unit' }, '100 g', undefined],
    [{ quantity: 150, unit: 'g' }, '100 g', 1.5],
    [{ quantity: 250, unit: 'ml' }, '1 cup (240 ml)', 250 / 240],
    [{ quantity: 1, unit: 'slice' }, '1 slice', 1],
    [{ quantity: 1, unit: 'slices' }, '1 slice', 1],
    [{ quantity: 1, unit: 'cup' }, '100 g', undefined],
    [{ quantity: 1, unit: 'unit' }, '1 breast (172 g)', 1],
    [{ quantity: 2, unit: 'unit' }, '1 arepa (100 g)', 2],
    [{ quantity: 1, unit: 'unit' }, '1 cup', undefined],
  ])('%j with "%s" → %s servings', (it_, label, n) => {
    expect(servingsFor(it_, label)).toBe(n);
  });
});

describe('generic units use the suggested serving', () => {
  it('"a serving of rice" → the option\'s suggested serving only', () => {
    expect(servingsFor({ quantity: 1, unit: 'serving' }, '1 cup', { suggested: true })).toBe(1);
    expect(servingsFor({ quantity: 1, unit: 'porción' }, '100 g', { suggested: false })).toBeUndefined();
  });
});

describe('choose (no guessing)', () => {
  const opts = (list: [string, string, number][], pinned?: string) => list.map(([name, label, calories], i) => ({ option: i + 1, name, pinned: name === pinned, servings: [{ serving: 0, label, calories }] }));
  it('skips the misleading first result and picks the serving that matches the unit', () => {
    const c = candidates(item(), [{ option: 1, name: 'Omelette', servings: [{ serving: 0, label: '1 omelette', calories: 850 }] }, { option: 2, name: 'Egg', servings: [{ serving: 0, label: '100 g', calories: 143 }, { serving: 1, label: '1 large egg', calories: 72 }] }], 1);
    expect(choose(item(), c)).toMatchObject({ name: 'Egg', serving: 1, servings: 2, kcal: 144 });
  });
  it('several different foods within 2× → ambiguous; a pinned one wins', () => {
    const o = opts([['Club', '1 sandwich', 590], ['Ham', '1 sandwich', 350], ['Chicken', '1 sandwich', 450]]);
    const it2 = item({ query: 'sandwich', quantity: 1, kcal_estimate: 600 });
    const two = opts([['Club', '1 sandwich', 590], ['Ham', '1 sandwich', 350]]);
    expect(choose(it2, candidates(it2, two, 1))).toMatchObject({ name: 'Club' }); // only one within 1.35×
    const it3 = item({ query: 'sandwich', quantity: 1, kcal_estimate: 400 });
    expect(choose(it3, candidates(it3, o, 1))).toBeUndefined();
    expect(choose(it3, candidates(it3, opts([['Club', '1 sandwich', 590], ['Ham', '1 sandwich', 350]], 'Club'), 1))).toMatchObject({ name: 'Club' });
  });
  it('tiny foods are not ambiguous over a small absolute difference', () => {
    const it5 = item({ query: 'green salad', quantity: 1, unit: 'cup', kcal_estimate: 50 });
    expect(choose(it5, candidates(it5, opts([['Green salad', '1 cup', 15]]), 1))).toMatchObject({ kcal: 15 });
  });
  it('"a serving" of chicken is the breast, not 100 g', () => {
    const it6 = item({ query: 'chicken breast', quantity: 1, unit: 'serving', kcal_estimate: 250 });
    const o = [{ option: 1, name: 'Chicken breast', suggested_serving: 0, servings: [{ serving: 0, label: '100 g', calories: 165 }, { serving: 1, label: '1 breast (172 g)', calories: 284 }] }];
    expect(choose(it6, candidates(it6, o, 1))).toMatchObject({ label: '1 breast (172 g)', kcal: 284 });
  });
  it('nothing within 2× of the estimate → ambiguous', () => {
    const it4 = item({ quantity: 1, kcal_estimate: 70 });
    expect(choose(it4, candidates(it4, opts([['Lasagna', '1 tray', 1700]]), 1))).toBeUndefined();
  });
});

describe('log_meal through the agent (fake Mason)', () => {
  let mason: FakeMason;
  const hubs: Hub[] = [];
  afterEach(async () => {
    await Promise.all(hubs.splice(0).map((h) => h.stop()));
    await mason?.close();
  });
  const run = async (args: Record<string, unknown>, diary: { meal: string; name: string; calories: number }[] = []) => {
    mason = await startFakeMason(diary);
    let seen = '';
    const sm = scriptedModel([{ tool: 'log_meal', args }, (p) => ((seen = lastToolResult(p)), { text: 'listo' })]);
    const hub = createHub(testConfig(), { model: sm.model as never, registry: MFP_REGISTRY(mason.url) });
    hubs.push(hub);
    const res = await withUsageScope({ requestId: 'r', intent: 'meal', media: 'text', kind: 'chat', domains: ['fitness'] }, () =>
      hub.mastra.getAgentById('assistant').generate('meal', { memory: { thread: 't', resource: 'dev:local' } }),
    );
    const o = JSON.parse(seen);
    return { seen: o.value ?? o, res, calls: sm.calls };
  };

  it('a 2-food meal in one model step: both logged with the right servings, one readback', async () => {
    const { seen, calls } = await run({ items: [item(), { query: 'whole wheat bread', quantity: 1, unit: 'slice', kcal_estimate: 80, meal: 'breakfast' }] }, [{ meal: 'Breakfast', name: 'Coffee, black', calories: 2 }]);
    expect(calls).toHaveLength(2); // log_meal + reply
    expect(mason.diary.map((e) => [e.name, e.calories])).toEqual([['Coffee, black', 2], ['Egg, whole, large', 144], ['Bread, whole wheat', 80]]);
    expect(seen.logged).toHaveLength(2);
    expect(seen.meal_totals).toEqual([{ meal: 'breakfast', items: 3, kcal: 226 }]);
    expect(mason.calls.filter((c) => c.tool === 'fitness_get_day')).toHaveLength(0); // readback from the log result
  });

  it('an ambiguous food is not logged; options come back for the user; confident items still log', async () => {
    const { seen } = await run({ items: [{ query: 'sandwich', quantity: 1, unit: 'unit', kcal_estimate: 400, meal: 'breakfast' }, item()] });
    expect(mason.diary.map((e) => e.name)).toEqual(['Egg, whole, large']);
    expect(seen.ambiguous[0].query).toBe('sandwich');
    expect(seen.ambiguous[0].options.map((o: { name: string }) => o.name)).toEqual(expect.arrayContaining(['Club sandwich', 'Ham and cheese sandwich', 'Chicken sandwich']));
    expect(seen.ambiguous[0].options[0]).toMatchObject({ draft_id: expect.any(String), option: expect.any(Number), serving_index: 0 });
  });

  it('> 800 kcal is never logged by log_meal; it returns log_with for the approval-gated path', async () => {
    const { seen } = await run({ items: [{ query: 'lasagna', quantity: 1, unit: 'tray', kcal_estimate: 1600, meal: 'breakfast' }] });
    expect(mason.diary).toHaveLength(0);
    expect(seen.needs_confirmation[0]).toMatchObject({ kcal: 1700, log_with: { option: 1, serving: 0, quantity: 1 } });
  });

  it('a > 800 kcal item logged via log_with still gets the approval card (guard sees log_meal\'s draft)', async () => {
    mason = await startFakeMason();
    const sm = scriptedModel([
      { tool: 'log_meal', args: { items: [{ query: 'lasagna', quantity: 1, unit: 'tray', kcal_estimate: 1600, meal: 'dinner' }] } },
      (p) => {
        const o = JSON.parse(lastToolResult(p));
        return { tool: 'fitness_log_food', args: (o.value ?? o).needs_confirmation[0].log_with };
      },
    ]);
    const hub = createHub(testConfig(), { model: sm.model as never, registry: MFP_REGISTRY(mason.url) });
    hubs.push(hub);
    const res = await withUsageScope({ requestId: 'r', intent: 'meal', media: 'text', kind: 'chat', domains: ['fitness'] }, () =>
      hub.mastra.getAgentById('assistant').generate('lasaña entera', { memory: { thread: 't8', resource: 'dev:local' } }),
    );
    expect(res.finishReason).toBe('suspended');
    expect(mason.diary).toHaveLength(0);
  });

  it('countable foods with a weight in the label ("1 breast (172 g)") are matched', async () => {
    const { seen } = await run({ items: [{ query: 'arepa', quantity: 2, unit: 'unit', kcal_estimate: 400, meal: 'breakfast' }] });
    expect(seen.logged?.[0]).toMatchObject({ name: 'Arepa, corn', servings: 2, kcal: 440 });
  });

  it('unknown food → failed with the MFP error code, others unaffected', async () => {
    const { seen } = await run({ items: [{ query: 'unicorn', quantity: 1, unit: 'unit', kcal_estimate: 100, meal: 'breakfast' }, item()] });
    expect(seen.failed[0]).toMatchObject({ query: 'unicorn', error: { code: 'MFP_BAD_REQUEST' } });
    expect(mason.diary).toHaveLength(1);
  });
});

describe('finance directory cache', () => {
  it('lists once, serves from cache within the TTL, refreshes after a write', async () => {
    let now = 0;
    const calls: string[] = [];
    const tb = { execute: async (n: string) => (calls.push(n), n === 'finance_list_accounts' ? { result: [{ id: 'a1', name: 'Nequi', currency: 'COP', balance: 5 }] } : { result: [{ id: 'p1', accountId: 'a1', name: 'Disponible' }] }) };
    const dir = new FinanceDirectory(tb, { now: () => now });
    const t = await dir.prompt();
    expect(t).toContain('Nequi (COP) id=a1 balance=5');
    expect(t).toContain('pocket Disponible id=p1');
    await dir.prompt();
    expect(calls).toHaveLength(2);
    dir.invalidate();
    await dir.prompt();
    expect(calls).toHaveLength(4);
    now = 11 * 60_000;
    await dir.prompt();
    expect(calls).toHaveLength(6);
  });

  it('an expense needs no list call: the ids are in the prompt; the cache refreshes after the write', async () => {
    const fin = await startFakeFinance('t');
    const sm = scriptedModel([
      (p) => {
        const sys = JSON.stringify(p);
        return { tool: 'finance_create_movement', args: { accountId: sys.includes('acc-nequi') ? 'acc-nequi' : 'missing', type: 'EgresoNormal', amount: 25000, date: '2026-10-19' } };
      },
      { text: 'listo' },
      { text: 'otra' },
    ]);
    const hub = createHub(testConfig(), {
      model: sm.model as never,
      registry: { servers: { finance: { url: fin.url, headers: { Authorization: { env: 'T', prefix: 'Bearer ' } } } } },
      env: { T: 't' },
    });
    const scope = { requestId: 'r', intent: 'expense' as const, media: 'text' as const, kind: 'chat' as const, domains: ['finance' as const] };
    await withUsageScope(scope, () => hub.mastra.getAgentById('assistant').generate('gasté 25k con Nequi', { memory: { thread: 't', resource: 'dev:local' } }));
    expect(fin.calls.map((c) => c.tool)).toEqual(['finance_list_accounts', 'finance_list_pockets', 'finance_create_movement']); // lists by the hub, not the model
    await withUsageScope(scope, () => hub.mastra.getAgentById('assistant').generate('y ahora?', { memory: { thread: 't', resource: 'dev:local' } }));
    expect(fin.calls.filter((c) => c.tool === 'finance_list_accounts')).toHaveLength(2); // refreshed after the write
    await hub.stop();
    await fin.close();
  });
});
