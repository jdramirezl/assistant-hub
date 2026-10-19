import { afterEach, describe, expect, it } from 'vitest';
import { NutritionTracker, KCAL_CONFIRM_THRESHOLD } from '../src/mcp/nutrition.js';
import { buildInstructions } from '../src/agents/assistant.js';
import { createHub, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel, lastToolResult } from './support/scripted-model.js';
import { MFP_REGISTRY, startFakeMason, type FakeMason } from './support/fake-mason.js';

const draft = {
  draft_id: 'd1',
  quantity: 1,
  options: [
    { option: 1, suggested_serving: 0, servings: [{ serving: 0, label: '1 tray', calories: 1700 }, { serving: 1, label: '1 cup', calories: 300 }] },
    { option: 2, suggested_serving: 1, servings: [{ serving: 0, label: '100 g', calories: 143 }, { serving: 1, label: '1 large egg', calories: 72 }] },
  ],
};

describe('NutritionTracker (estimate before logging)', () => {
  const t = new NutritionTracker();
  t.recordResult('fitness_draft_food', {}, draft);
  t.recordResult('fitness_search_food', {}, { results: [{ food_id: 'f9', weight_id: 'w9', calories: 450 }] });

  it('uses the draft serving calories (whole entry) and scales an overridden quantity', () => {
    expect(t.estimateLogKcal({ draft_id: 'd1', option: 1, serving: 1 })).toBe(300);
    expect(t.estimateLogKcal({ draft_id: 'd1', option: 2 })).toBe(72); // suggested serving
    expect(t.estimateLogKcal({ draft_id: 'd1', option: 2, serving: 0, quantity: 6 })).toBe(858);
  });
  it('uses search calories × quantity for food_id + weight_id', () => {
    expect(t.estimateLogKcal({ food_id: 'f9', weight_id: 'w9', quantity: 2 })).toBe(900);
  });
  it('is unknown for a bare query (pinned food)', () => {
    expect(t.estimateLogKcal({ query: 'eggs' })).toBeUndefined();
  });
  it(`needs confirmation above ${KCAL_CONFIRM_THRESHOLD} kcal only`, () => {
    expect(t.needsConfirmation({ draft_id: 'd1', option: 1, serving: 0 })).toBe(true);
    expect(t.needsConfirmation({ draft_id: 'd1', option: 1, serving: 1 })).toBe(false);
    expect(t.needsConfirmation({ query: 'eggs' })).toBe(false);
  });
  it('annotates a log result with entry kcal and the meal total (readback)', () => {
    const res = t.annotateLog({ draft_id: 'd1', option: 2 }, {
      ok: true, logged: 'Egg, whole, large', meal: 'breakfast',
      day: { diary: [ { meal: 'Breakfast', name: 'Coffee, black', calories: 2 }, { meal: 'Breakfast', name: 'Egg, whole, large', calories: 72 }, { meal: 'Lunch', name: 'Arepa', calories: 220 } ] },
    }) as Record<string, unknown>;
    expect(res.entry_kcal).toBe(72);
    expect(res.meal_total).toEqual({ meal: 'Breakfast', items: 2, kcal: 74 });
    expect(res.warning).toBeUndefined();
  });
  it('warns after the fact when an unestimated entry turns out > 800 kcal', () => {
    const res = t.annotateLog({ query: 'lasagna' }, { ok: true, logged: 'Lasagna, family tray', meal: 'dinner', day: { diary: [{ meal: 'Dinner', name: 'Lasagna, family tray', calories: 1700 }] } }) as Record<string, unknown>;
    expect(res.entry_kcal).toBe(1700);
    expect(String(res.warning)).toMatch(/1700 kcal.*confirm/i);
  });
});

describe('fitness prompt rules', () => {
  const t = buildInstructions('America/Bogota');
  it('search in English, serving unit, estimate first, 2× check, readback', () => {
    expect(t).toMatch(/search.*in English/i);
    expect(t).toMatch(/serving.*unit/i);
    expect(t).toMatch(/estimat/i);
    expect(t).toMatch(/2×|twice/);
    expect(t).toMatch(/meal_total/);
  });
});

describe('through the hub with fake Mason', () => {
  let mason: FakeMason;
  const hubs: Hub[] = [];
  afterEach(async () => {
    await Promise.all(hubs.splice(0).map((h) => h.stop()));
    await mason?.close();
  });
  const mem = (t: string) => ({ memory: { thread: t, resource: 'dev:local' } });

  it('an oversized serving (> 800 kcal) stops for approval, whatever the model decided', async () => {
    mason = await startFakeMason();
    const sm = scriptedModel([
      { tool: 'fitness_draft_food', args: { query: 'lasagna', meal: 'dinner' } },
      { tool: 'fitness_log_food', args: { draft_id: 'd1', option: 1, serving: 0 } },
    ]);
    const hub = createHub(testConfig(), { model: sm.model as never, registry: MFP_REGISTRY(mason.url) });
    hubs.push(hub);
    const res = await hub.mastra.getAgentById('assistant').generate('log lasagna for dinner', mem('n1'));
    expect(res.finishReason).toBe('suspended');
    expect(mason.diary).toHaveLength(0);
  });

  it('"2 of X" with a big serving (quantity × serving > 800) also stops', async () => {
    mason = await startFakeMason();
    const sm = scriptedModel([
      { tool: 'fitness_draft_food', args: { query: 'egg', meal: 'breakfast' } },
      { tool: 'fitness_log_food', args: { draft_id: 'd1', option: 1, serving: 0, quantity: 2 } },
    ]);
    const hub = createHub(testConfig(), { model: sm.model as never, registry: MFP_REGISTRY(mason.url) });
    hubs.push(hub);
    const res = await hub.mastra.getAgentById('assistant').generate('2 huevos', mem('n2'));
    expect(res.finishReason).toBe('suspended');
  });

  it('a normal meal logs without approval and the result carries the readback', async () => {
    mason = await startFakeMason([{ meal: 'Breakfast', name: 'Coffee, black', calories: 2 }]);
    let seen = '';
    const sm = scriptedModel([
      { tool: 'fitness_draft_food', args: { query: 'egg', quantity: 2, meal: 'breakfast' } },
      { tool: 'fitness_log_food', args: { draft_id: 'd1', option: 2, serving: 1 } },
      (p) => ((seen = lastToolResult(p)), { text: 'Desayuno registrado' }),
    ]);
    const hub = createHub(testConfig(), { model: sm.model as never, registry: MFP_REGISTRY(mason.url) });
    hubs.push(hub);
    const res = await hub.mastra.getAgentById('assistant').generate('comí 2 huevos al desayuno', mem('n3'));
    expect(res.finishReason).not.toBe('suspended');
    expect(mason.diary.at(-1)).toMatchObject({ name: 'Egg, whole, large', calories: 144 });
    expect(seen).toContain('"meal_total"');
    expect(seen).toContain('"kcal":146');
    expect(seen).toContain('"items":2');
  });
});
