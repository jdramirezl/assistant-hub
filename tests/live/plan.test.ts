// Opt-in: real Gemini must batch a whole-day delete into ONE propose_plan. `npm run test:live`
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../../src/hub.js';
import { testConfig } from '../helpers.js';
import { MFP_REGISTRY, startFakeMason, type DiaryEntry, type FakeMason } from '../support/fake-mason.js';

const DAY: DiaryEntry[] = [
  ...['Coffee, black', 'Egg, whole, large', 'Bread, whole wheat', 'Butter', 'Orange juice'].map((name, i) => ({ meal: 'Breakfast', name, calories: 50 + i })),
  ...['Arepa, corn', 'Chicken breast', 'Rice, white', 'Beans', 'Avocado', 'Soda'].map((name, i) => ({ meal: 'Lunch', name, calories: 100 + i })),
  ...['Apple', 'Almonds'].map((name, i) => ({ meal: 'Snacks', name, calories: 80 + i })),
  ...['Pasta', 'Tomato sauce', 'Parmesan', 'Red wine'].map((name, i) => ({ meal: 'Dinner', name, calories: 200 + i })),
];

describe.skipIf(!process.env.GOOGLE_API_KEY)('live Gemini: batch approval', () => {
  let mason: FakeMason;
  let hub: Hub;
  beforeAll(async () => {
    mason = await startFakeMason(DAY);
    hub = createHub(testConfig({ GOOGLE_API_KEY: process.env.GOOGLE_API_KEY! }), { registry: MFP_REGISTRY(mason.url) });
  });
  afterAll(async () => {
    await hub.stop();
    await mason.close();
  });

  it('"borra todo lo de hoy" → one plan with all 17 deletes, nothing deleted yet', async () => {
    const res = await hub.mastra.getAgentById('assistant').generate('borra todo lo que tengo registrado hoy en MyFitnessPal', { memory: { thread: 'live-plan', resource: 'dev:local' } });
    const open = await hub.plans.store.open('dev:local');
    expect(mason.calls.filter((c) => c.tool === 'fitness_delete_food'), res.text).toHaveLength(0);
    expect(res.text).toMatch(/[áéíóúñ¿]|\b(el|la|de|su|plan listo)\b/i);
    expect(open, `${res.finishReason}: ${res.text} / calls: ${mason.calls.map((c) => c.tool).join(',')}`).toHaveLength(1);
    const actions = open[0]!.groups.flatMap((g) => g.actions);
    expect(actions).toHaveLength(17);
    expect(actions.every((a) => a.tool === 'fitness_delete_food')).toBe(true);
    console.log(`[live] plan "${open[0]!.title}": ${open[0]!.groups.map((g) => `${g.label}(${g.actions.length})`).join(', ')}\n[live] reply: ${res.text}`);
  }, 180_000);
});
