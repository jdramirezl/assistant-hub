import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createLogMeal, type MealNutrition } from '../src/mcp/log-meal.js';
import { loadProfile, type Profile } from '../src/nutrition/profile.js';
import { FoodBook } from '../src/nutrition/book.js';
import { DayPlanner } from '../src/nutrition/day.js';
import { MemoryKv } from './support/memory-kv.js';

type Rec = Record<string, unknown>;
const EXAMPLE = loadProfile(join(import.meta.dirname, '..', 'docs', 'nutrition-profile.example.json'))!;
const TODAY = '2026-10-21';

/** MFP-like catalog: keyword → foods with servings (kcal for ONE serving). */
const CATALOG: [RegExp, { name: string; brand?: string; verified?: boolean; servings: [string, number][] }[]][] = [
  [/egg, fried/i, [{ name: 'Egg, fried', servings: [['1 large egg', 90]] }]],
  [/\beggs?\b/i, [{ name: 'Egg omelette, restaurant', servings: [['1 omelette', 850]] }, { name: 'Egg, whole, large', servings: [['100 g', 143], ['1 large egg', 72]] }]],
  [/harina pan/i, [{ name: 'Harina PAN, arepa flour', servings: [['100 g', 373]] }]],
  [/cooking spray/i, [{ name: 'Cooking spray', servings: [['1 spray', 2.4]] }]],
  [/clight/i, [{ name: 'Clight', servings: [['1 serving (2 g)', 5]] }]],
  [/coca-cola zero|coke zero/i, [{ name: 'Coca-Cola Zero', servings: [['1 can (355 ml)', 0]] }]],
  [/coca/i, [{ name: 'Coca-Cola', servings: [['1 can (355 ml)', 140]] }]],
  [/melon/i, [{ name: 'Melon, honeydew', servings: [['1 cup', 61]] }]],
  [/flour tortilla/i, [{ name: 'Flour tortilla, burrito size', servings: [['1 tortilla', 220]] }]],
  [/corn tortilla/i, [{ name: 'Corn tortilla', servings: [['1 tortilla', 52]] }]],
  [/pastor/i, [{ name: 'Al pastor pork', servings: [['100 g', 210]] }]],
  [/potato, fried/i, [{ name: 'Potato, fried cubes', servings: [['100 g', 150]] }]],
  [/potato/i, [{ name: 'Potato, raw', servings: [['100 g', 77]] }]],
  [/oaxaca/i, [{ name: 'Oaxaca cheese', servings: [['100 g', 320]] }]],
  [/onion/i, [{ name: 'Onion, raw', servings: [['100 g', 40]] }]],
  [/vegetable oil/i, [{ name: 'Vegetable oil', servings: [['1 tsp', 40]] }]],
  [/chicken breast/i, [{ name: 'Chicken breast, raw', servings: [['100 g', 120]] }]],
  [/carrot/i, [{ name: 'Carrot, raw', servings: [['100 g', 41]] }]],
  [/rice/i, [{ name: 'Rice, white, cooked', servings: [['1 cup', 205]] }]],
  [/tamal/i, [{ name: 'Tamal de rajas', servings: [['1 tamal', 280]] }]],
  [/cornetto/i, [{ name: 'Cornetto Chocolate', servings: [['1 cone', 208]] }]],
  [/big mac/i, [{ name: 'Big Mac copycat (homemade)', servings: [['1 burger', 700]] }, { name: 'Big Mac', brand: "McDonald's", verified: true, servings: [['1 sandwich', 590]] }]],
  [/fries/i, [{ name: 'French fries, homemade', servings: [['1 cup', 300]] }, { name: 'French Fries, medium', brand: "McDonald's", verified: true, servings: [['1 medium', 320]] }]],
  [/hershey/i, [{ name: "Hershey's Milk Chocolate Bar", brand: "Hershey's", verified: true, servings: [['1 bar (43 g)', 220]] }]],
  [/whopper/i, [{ name: 'Burger, homemade', servings: [['1 burger', 600]] }]],
  [/hamburguesa|burger/i, [{ name: 'Hamburger, plain', servings: [['1 burger', 500]] }, { name: 'Smash burger', brand: 'Shake Shack', verified: true, servings: [['1 burger', 550]] }]],
];

function fakeMfp(diary: { meal: string; name: string; calories: number }[] = []) {
  const drafts = new Map<string, { options: { name: string; brand?: string; verified?: boolean; servings: [string, number][] }[] }>();
  const calls: { tool: string; args: Rec }[] = [];
  const day = () => ({ day: TODAY, nutrition: { calories: diary.reduce((a, e) => a + e.calories, 0), protein: 42 }, diary: diary.map((e) => ({ ...e })) });
  const toolbox = {
    async execute(tool: string, args: Rec) {
      calls.push({ tool, args });
      if (tool === 'fitness_get_day') return day();
      if (tool === 'fitness_draft_food') {
        const hit = CATALOG.find(([re]) => re.test(String(args.query)));
        if (!hit) return { error: { code: 'MFP_NOT_FOUND', message: `no food for ${args.query}`, retryable: false } };
        const id = `d${drafts.size + 1}`;
        drafts.set(id, { options: hit[1] });
        return { draft_id: id, quantity: 1, options: hit[1].map((o, i) => ({ option: i + 1, name: o.name, brand: o.brand ?? null, verified: !!o.verified, suggested_serving: 0, servings: o.servings.map(([label, kcal], s) => ({ serving: s, label, calories: kcal })) })) };
      }
      if (tool === 'fitness_log_food') {
        const d = drafts.get(String(args.draft_id))!;
        const o = d.options[Number(args.option) - 1]!;
        const [, kcal] = o.servings[Number(args.serving)]!;
        diary.push({ meal: String(args.meal).replace(/^./, (c) => c.toUpperCase()), name: o.name, calories: Math.round(kcal * Number(args.quantity)) });
        return { ok: true, logged: o.name, meal: args.meal, day: day() };
      }
      throw new Error(`unexpected ${tool}`);
    },
  };
  return { toolbox, calls, diary, logs: () => calls.filter((c) => c.tool === 'fitness_log_food') };
}

function setup(opts: { profile?: Profile; text?: string; diary?: { meal: string; name: string; calories: number }[]; kv?: MemoryKv } = {}) {
  const profile = opts.profile ?? EXAMPLE;
  const kv = opts.kv ?? new MemoryKv();
  const mfp = fakeMfp(opts.diary);
  const nutrition: MealNutrition = { book: new FoodBook(profile, kv), planner: new DayPlanner(profile, kv), defaults: profile.defaults, userText: () => opts.text, today: () => TODAY };
  const logs: string[] = [];
  const tool = createLogMeal(mfp.toolbox, (m) => logs.push(m), { nutrition }) as unknown as { execute(i: unknown, c: unknown): Promise<Rec> };
  return { run: (items: Rec[]) => tool.execute({ items }, {}), mfp, logs, kv };
}
const names = (r: Rec) => ((r.logged ?? []) as { name: string }[]).map((l) => l.name);

describe('log_meal with the nutrition brain', () => {
  it('"desayuné 2 huevos con arepa y melón": dictionary hits + spray + Clight, with the day total', async () => {
    const s = setup({ text: 'desayuné 2 huevos con arepa y melón' });
    const r = await s.run([
      { query: 'eggs', quantity: 2, unit: 'unit', kcal_estimate: 150, meal: 'breakfast' },
      { query: 'arepa', quantity: 1, unit: 'unit', kcal_estimate: 220, meal: 'breakfast' },
      { query: 'honeydew melon', quantity: 1, unit: 'cup', kcal_estimate: 60, meal: 'breakfast' },
    ]);
    expect(names(r)).toEqual(['Egg, whole, large', 'Harina PAN, arepa flour', 'Melon, honeydew', 'Cooking spray', 'Clight']);
    const kcal = Object.fromEntries((r.logged as { name: string; kcal: number }[]).map((l) => [l.name, l.kcal]));
    expect(kcal).toMatchObject({ 'Egg, whole, large': 144, 'Harina PAN, arepa flour': 149, 'Cooking spray': 12, Clight: 5 });
    expect((r.assumed as string[]).join(' | ')).toMatch(/spray.*\|.*bebida: water enhancer/);
    expect(r.day_total).toMatchObject({ kcal: 371, protein_g: 42, day_type: 'gimnasia', day_type_source: 'schedule' });
  });

  it('burrito de pastor ×2 → components ×2 (no spray: eaten out), lunch drink Coke Zero', async () => {
    const s = setup({ text: 'almorcé 2 burritos de pastor con papa y queso' });
    const r = await s.run([{ query: 'burrito al pastor', quantity: 2, unit: 'unit', kcal_estimate: 1150, meal: 'lunch' }]);
    expect(names(r)).toEqual(['Flour tortilla, burrito size', 'Al pastor pork', 'Potato, fried cubes', 'Oaxaca cheese', 'Onion, raw', 'Vegetable oil', 'Coca-Cola Zero']);
    expect(r.dishes).toEqual([{ name: 'burrito de pastor', portions: 2, components: 6, kcal: expect.any(Number) }]);
    const d = (r.dishes as { kcal: number }[])[0]!.kcal;
    expect(d).toBeGreaterThan(1000);
    expect(d).toBeLessThan(1350);
    expect(s.mfp.logs()[0]!.args.quantity).toBe(2); // 2 tortillas
  });

  it('"cené sopa": the saved recipe expands into its ingredients', async () => {
    const s = setup({ text: 'cené sopa' });
    const r = await s.run([{ query: 'chicken soup', quantity: 1, unit: 'serving', kcal_estimate: 300, meal: 'dinner' }]);
    expect(names(r)).toEqual(['Chicken breast, raw', 'Potato, raw', 'Carrot, raw', 'Onion, raw', 'Coca-Cola Zero']);
    expect((r.logged as { part_of?: string }[]).slice(0, 4).every((l) => l.part_of === 'sopa de pollo')).toBe(true);
  });

  it('a whole dish with no template is sent back to be decomposed (nothing logged)', async () => {
    const s = setup({ text: 'almorcé tacos de suadero' });
    const r = await s.run([{ query: 'tacos de suadero', quantity: 3, unit: 'unit', kcal_estimate: 600, meal: 'lunch' }]);
    expect(r.decompose).toEqual([{ query: 'tacos de suadero', meal: 'lunch' }]);
    expect(s.mfp.logs()).toHaveLength(0);
    expect(String(r.note)).toMatch(/components/);
  });

  it('a drink the user named: no default drink; a fat already logged: no spray', async () => {
    const s = setup({ text: 'almorcé arroz con huevo frito y una coca', diary: [{ meal: 'Lunch', name: 'Cooking spray', calories: 12 }] });
    const r = await s.run([
      { query: 'rice', quantity: 1, unit: 'cup', kcal_estimate: 200, meal: 'lunch' },
      { query: 'eggs', quantity: 1, unit: 'unit', kcal_estimate: 80, meal: 'lunch' },
      { query: 'Coca-Cola', quantity: 1, unit: 'can', kcal_estimate: 140, meal: 'lunch' },
    ]);
    expect(names(r)).toEqual(['Rice, white, cooked', 'Egg, whole, large', 'Coca-Cola']);
    expect(r.assumed).toBeUndefined();
  });

  it('snacks get no implied drink', async () => {
    const s = setup({ text: 'me comí un Cornetto' });
    const r = await s.run([{ query: 'Cornetto', quantity: 1, unit: 'unit', kcal_estimate: 250, meal: 'snacks' }]);
    expect(names(r)).toEqual(['Cornetto Chocolate']);
  });

  it('a duplicate in the meal is reported', async () => {
    const s = setup({ text: 'desayuné 2 huevos y un clight', diary: [{ meal: 'Breakfast', name: 'Egg, whole, large', calories: 144 }] });
    const r = await s.run([
      { query: 'eggs', quantity: 2, unit: 'unit', kcal_estimate: 150, meal: 'breakfast' },
      { query: 'clight', quantity: 1, unit: 'unit', kcal_estimate: 5, meal: 'breakfast' },
    ]);
    expect(r.possible_duplicates).toEqual(['Egg, whole, large']);
  });

  it('a one-off food is only counted; on its 3rd different day it is proposed', async () => {
    const kv = new MemoryKv();
    const item = { query: 'tamal de rajas', quantity: 1, unit: 'unit', kcal_estimate: 280, meal: 'snacks' };
    expect((await setup({ kv, text: 'un tamal' }).run([item])).dictionary_proposal).toBeUndefined();
    // logged on two earlier days: today is the third → proposed
    const kv2 = new MemoryKv();
    await kv2.set('nutrition:seen', { 'tamal de rajas': { query: 'tamal de rajas', quantity: 1, unit: 'unit', kcal: 280, days: ['2026-10-10', '2026-10-15'] } });
    const r = await setup({ kv: kv2, text: 'un tamal' }).run([item]);
    expect(r.dictionary_proposal).toMatchObject({ query: 'tamal de rajas', days: 3 });
  });

  it('the 800 kcal guard and 2× check hold for a recipe total', async () => {
    const big: Profile = { ...EXAMPLE, recipes: [{ name: 'pasta box', aliases: ['pasta box'], items: [{ query: 'rice', quantity: 2, unit: 'cup', kcal: 300 }, { query: 'chicken breast', quantity: 300, unit: 'g', kcal: 260 }, { query: 'Oaxaca cheese', quantity: 60, unit: 'g', kcal: 160 }] }] };
    const s = setup({ profile: big, text: 'almorcé una pasta box' });
    const r = await s.run([{ query: 'pasta box', quantity: 1, unit: 'serving', kcal_estimate: 700, meal: 'lunch' }]);
    // 410 + 360 + 192 = 962 kcal for one portion expected at 720 → confirm, nothing of it logged
    expect(names(r).filter((n) => n !== 'Coca-Cola Zero')).toEqual([]);
    expect((r.ambiguous as { query: string; reason: string }[])[0]).toMatchObject({ query: 'pasta box', reason: expect.stringMatching(/over 800/) });
  });

  it('branded: "una Big Mac y papas medianas" → 2 branded entries + the lunch Coke Zero, never parts', async () => {
    const s = setup({ text: 'me comí una Big Mac y papas medianas' });
    const r = await s.run([
      { query: "McDonald's Big Mac", quantity: 1, unit: 'unit', kcal_estimate: 560, meal: 'lunch' },
      { query: "McDonald's French Fries, medium", quantity: 1, unit: 'medium', kcal_estimate: 320, meal: 'lunch' },
    ]);
    expect(names(r)).toEqual(['Big Mac', 'French Fries, medium', 'Coca-Cola Zero']);
    expect(r.decompose).toBeUndefined();
  });

  it('a packaged product ("un Hershey\'s") is one entry; snacks get no drink', async () => {
    const s = setup({ text: "un Hershey's" });
    const r = await s.run([{ query: "Hershey's milk chocolate bar", quantity: 1, unit: 'bar', kcal_estimate: 210, meal: 'snacks' }]);
    expect(names(r)).toEqual(["Hershey's Milk Chocolate Bar"]);
  });

  it('a chain item MFP does not have falls back to components (not_in_mfp)', async () => {
    const s = setup({ text: 'almorcé un Whopper' });
    const r = await s.run([{ query: 'Burger King Whopper', quantity: 1, unit: 'unit', kcal_estimate: 660, meal: 'lunch' }]);
    expect(r.decompose).toEqual([{ query: 'Burger King Whopper', meal: 'lunch', not_in_mfp: true }]);
    expect(s.mfp.logs()).toHaveLength(0);
  });

  it('an unbranded whole dish with a verified branded MFP entry is one entry; without one it is decomposed', async () => {
    const s = setup({ text: 'cené una hamburguesa' });
    const r = await s.run([{ query: 'hamburger', quantity: 1, unit: 'unit', kcal_estimate: 550, meal: 'dinner' }]);
    expect(names(r)).toEqual(['Smash burger', 'Coca-Cola Zero']);
  });

  it('without a profile, log_meal behaves as before (no extras)', async () => {
    const mfp = fakeMfp();
    const tool = createLogMeal(mfp.toolbox, () => {}, {}) as unknown as { execute(i: unknown, c: unknown): Promise<Rec> };
    const r = await tool.execute({ items: [{ query: 'eggs', quantity: 2, unit: 'unit', kcal_estimate: 150, meal: 'breakfast' }] }, {});
    expect(names(r)).toEqual(['Egg, whole, large']);
    expect(r.day_total).toBeUndefined();
  });
});
