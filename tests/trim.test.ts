import { afterEach, describe, expect, it } from 'vitest';
import { trimForModel, unitsIn, compact } from '../src/mcp/trim.js';
import { createHub, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel, lastToolResult } from './support/scripted-model.js';
import { MFP_REGISTRY, startFakeMason, type FakeMason } from './support/fake-mason.js';

const draft = {
  draft_id: 'd1', query: '2 slices whole wheat bread', day: '2026-10-19', meal: 'breakfast', quantity: 2, targets: {},
  options: [1, 2, 3, 4, 5].map((n) => ({
    option: n, name: `Bread ${n}`, brand: null, verified: true, pinned: n === 5, fits_targets: true, suggested_serving: 1,
    servings: [
      { serving: 0, label: '100 g', calories: 500, protein: null, carbs: null, fat: null, fits_targets: true },
      { serving: 1, label: '1 oz', calories: 140, protein: null, carbs: null, fat: null, fits_targets: true },
      { serving: 2, label: '1 cup', calories: 220, protein: null, carbs: null, fat: null, fits_targets: true },
      { serving: 3, label: '1 loaf', calories: 2000, protein: null, carbs: null, fat: null, fits_targets: true },
      { serving: 4, label: '1 slice', calories: 160, protein: null, carbs: null, fat: null, fits_targets: true },
    ],
  })),
};

describe('trimForModel', () => {
  it('drafts: 3 options (pinned kept), original numbering, servings matching the unit + suggested', () => {
    const t = trimForModel('fitness_draft_food', draft) as { options: { option: number; servings: { serving: number; label: string }[] }[] };
    expect(t.options.map((o) => o.option)).toEqual([1, 2, 5]);
    expect(t.options[0]!.servings.map((s) => s.label)).toEqual(expect.arrayContaining(['1 slice', '1 oz']));
    expect(t.options[0]!.servings.length).toBeLessThanOrEqual(3);
    expect(t.options[0]!.servings.find((s) => s.label === '1 slice')!.serving).toBe(4); // index unchanged
    expect(JSON.stringify(t)).not.toMatch(/fits_targets|"verified"|null/);
    expect(JSON.stringify(t).length).toBeLessThan(JSON.stringify(draft).length / 3);
  });
  it('unit detection', () => {
    expect(unitsIn('2 slices whole wheat bread')).toContain('slice');
    expect(unitsIn('100 g rice')).toContain('g');
    expect(unitsIn('whole wheat bread')).toEqual([]);
  });
  it('log result: no day dump, keeps entry_kcal and meal_total', () => {
    const t = trimForModel('fitness_log_food', { ok: true, logged: 'Egg', serving: '1 large egg', quantity: 2, meal: 'breakfast', date: 'x', food_id: 'f', weight_id: 'w', entry_kcal: 144, meal_total: { meal: 'Breakfast', items: 2, kcal: 146 }, day: { diary: Array(30).fill({ name: 'x' }) } });
    expect(t).toEqual({ ok: true, logged: 'Egg', serving: '1 large egg', quantity: 2, meal: 'breakfast', date: 'x', entry_kcal: 144, meal_total: { meal: 'Breakfast', items: 2, kcal: 146 } });
  });
  it('get_day: compact diary (meal, name, kcal) and non-null totals', () => {
    const t = trimForModel('fitness_get_day', { day: 'd', nutrition: { day: 'd', calories: 300, protein: null, goal_calories: 2200 }, diary: [{ meal: 'Breakfast', name: 'Egg', calories: 144, protein: null, carbs: null, fat: null }], note: null, feel: null });
    expect(t).toEqual({ day: 'd', totals: { calories: 300, goal_calories: 2200 }, diary: [{ meal: 'Breakfast', name: 'Egg', calories: 144 }] });
  });
  it('finance lists: essential fields; unknown shapes kept; errors untouched', () => {
    expect(trimForModel('finance_list_accounts', { result: [{ id: 'a', name: 'Nequi', currency: 'COP', type: 'bank', balance: 1, createdAt: 'x', userId: 'u', icon: 'i' }] })).toEqual({ result: [{ id: 'a', name: 'Nequi', currency: 'COP', type: 'bank', balance: 1 }] });
    expect(trimForModel('finance_list_accounts', { result: [{ weird: 1, shape: 2 }] })).toEqual({ result: [{ weird: 1, shape: 2 }] });
    const err = { error: { code: 'X', message: 'm', retryable: false } };
    expect(trimForModel('fitness_log_food', err)).toBe(err);
    expect(compact({ a: null, b: [], c: {}, d: 0, e: false })).toEqual({ d: 0, e: false });
  });
});

describe('guards still see the full result', () => {
  let mason: FakeMason;
  const hubs: Hub[] = [];
  afterEach(async () => {
    await Promise.all(hubs.splice(0).map((h) => h.stop()));
    await mason?.close();
  });
  it('a trimmed-away option is still priced by the 800 kcal guard, and the model sees the meal total', async () => {
    mason = await startFakeMason([{ meal: 'Breakfast', name: 'Coffee, black', calories: 2 }]);
    let draftSeen = '';
    let logSeen = '';
    const sm = scriptedModel([
      { tool: 'fitness_draft_food', args: { query: 'egg', quantity: 2, meal: 'breakfast' } },
      (p) => ((draftSeen = lastToolResult(p)), { tool: 'fitness_log_food', args: { draft_id: 'd1', option: 2, serving: 1 } }),
      (p) => ((logSeen = lastToolResult(p)), { text: 'ok' }),
    ]);
    const hub = createHub(testConfig(), { model: sm.model as never, registry: MFP_REGISTRY(mason.url) });
    hubs.push(hub);
    await hub.mastra.getAgentById('assistant').generate('2 huevos', { memory: { thread: 't', resource: 'dev:local' } });
    expect(draftSeen).not.toMatch(/fits_targets/);
    expect(logSeen).toContain('meal_total');
    expect(logSeen).not.toContain('"day"');
    expect(mason.diary.at(-1)!.calories).toBe(144);
  });
});

describe('history trimming', () => {
  let mason: FakeMason;
  const hubs: Hub[] = [];
  afterEach(async () => {
    await Promise.all(hubs.splice(0).map((h) => h.stop()));
    await mason?.close();
  });
  it('the next message carries earlier replies but not earlier tool calls/results', async () => {
    mason = await startFakeMason();
    const sm = scriptedModel([{ tool: 'fitness_get_day', args: {} }, { text: 'Hoy: nada registrado.' }, { text: 'ok' }]);
    const hub = createHub(testConfig(), { model: sm.model as never, registry: MFP_REGISTRY(mason.url) });
    hubs.push(hub);
    const agent = hub.mastra.getAgentById('assistant');
    await agent.generate('¿qué comí hoy?', { memory: { thread: 'h', resource: 'dev:local' } });
    await agent.generate('gracias', { memory: { thread: 'h', resource: 'dev:local' } });
    const msgs = sm.calls.at(-1)!.prompt as { role: string; content: unknown }[];
    expect(JSON.stringify(msgs)).toContain('Hoy: nada registrado.');
    expect(msgs.some((m) => m.role === 'tool')).toBe(false);
    expect(JSON.stringify(msgs.filter((m) => m.role !== 'system'))).not.toContain('fitness_get_day');
  });
});
