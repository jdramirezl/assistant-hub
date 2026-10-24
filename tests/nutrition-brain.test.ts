import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadProfile, parseProfile } from '../src/nutrition/profile.js';
import { FoodBook } from '../src/nutrition/book.js';
import { matchDish, isCompositeDish } from '../src/nutrition/dishes.js';
import { brandOf, optionIsBrand } from '../src/nutrition/brands.js';
import { DayPlanner, dayTypeFromText } from '../src/nutrition/day.js';
import { contextFor } from '../src/nutrition/context.js';
import { dictionaryPrompt, STYLE_RULES } from '../src/nutrition/prompt.js';
import { MemoryKv } from './support/memory-kv.js';

const EXAMPLE = join(import.meta.dirname, '..', 'docs', 'nutrition-profile.example.json');
const profile = () => loadProfile(EXAMPLE)!;

describe('profile', () => {
  it('the committed example parses and has no personal sections', () => {
    const p = profile();
    expect(p.foods.length).toBeGreaterThan(3);
    expect(p.recipes.length).toBeGreaterThan(0);
    expect(p.targets.rest.kcal[0]).toBeGreaterThan(0);
  });
  it('a missing or invalid file is not fatal (features off) and its contents are never in the error', () => {
    const logs: string[] = [];
    expect(loadProfile('/nonexistent/profile.json', (m) => logs.push(m))).toBeUndefined();
    expect(() => parseProfile({ version: 1, targets: 'secret-weight-64.4' })).toThrow();
    try {
      parseProfile({ version: 1, targets: 'secret-weight-64.4' });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('64.4');
    }
  });
});

describe('food book', () => {
  const book = () => new FoodBook(profile(), new MemoryKv());
  it('dictionary hit by name or alias, Spanish or English', async () => {
    const b = book();
    expect((await b.food('huevos'))?.query).toMatch(/egg/i);
    expect((await b.food('eggs'))?.query).toMatch(/egg/i);
    expect((await b.food('large eggs'))?.query).toMatch(/egg/i);
    expect(await b.food('tamal de rajas')).toBeUndefined();
  });
  it('an arepa of 120 g of masa is 40 g of dry flour', async () => {
    const b = book();
    const r = b.toItem((await b.food('arepa'))!, 120, 'g');
    expect(r).toMatchObject({ quantity: 40, unit: 'g' });
    expect(r.kcal_estimate).toBeCloseTo(149, 0);
    // the MFP entry named directly ("Harina PAN 40 g"): those grams are flour already, not masa
    const flour = (await b.food('Harina PAN'))!;
    expect(b.namesMfpEntry(flour, 'Harina PAN')).toBe(true);
    expect(b.namesMfpEntry(flour, 'arepa')).toBe(false);
    expect(b.toItem(flour, 40, 'g', { mfpGrams: true })).toMatchObject({ quantity: 40, unit: 'g', kcal_estimate: 149 });
    const one = b.toItem((await b.food('arepa'))!, 1, 'unit');
    expect(one).toMatchObject({ quantity: 40, unit: 'g' });
  });
  it('spray: pumps, never tbsp of oil; default 5', async () => {
    const b = book();
    const s = (await b.food('cooking spray'))!;
    expect(b.toItem(s, 1, 'tbsp')).toMatchObject({ quantity: 5, unit: 'spray' });
    expect(b.toItem(s, 4, 'spray')).toMatchObject({ quantity: 4, unit: 'spray' });
  });
  it('recipes expand into their ingredients × portions', async () => {
    const b = book();
    const r = (await b.recipe('chicken soup'))!;
    expect(r).toBeTruthy();
    const items = b.expandRecipe(r, 2);
    expect(items.length).toBe(r.items.length);
    expect(items[0]!.quantity).toBe(r.items[0]!.quantity * 2);
    expect(await b.recipe('sopa')).toBeTruthy();
  });
  it('learned foods persist and a food logged on 3 different days is proposed once', async () => {
    const kv = new MemoryKv();
    const b = new FoodBook(profile(), kv);
    const it_ = { query: 'tamal de rajas', quantity: 1, unit: 'unit', kcal: 280 };
    expect(await b.seen(it_, '2026-10-01')).toBeUndefined();
    expect(await b.seen(it_, '2026-10-01')).toBeUndefined(); // same day twice: still 1 day
    expect(await b.seen(it_, '2026-10-05')).toBeUndefined();
    const p = await b.seen(it_, '2026-10-09');
    expect(p).toMatchObject({ query: 'tamal de rajas', days: 3 });
    expect(await b.seen(it_, '2026-10-10')).toBeUndefined(); // proposed once
    await b.learn({ name: 'Tamal de rajas', aliases: ['tamal'], query: 'tamal de rajas', unit: 'unit', kcal: 280 });
    expect((await new FoodBook(profile(), kv).food('tamal'))?.kcal).toBe(280);
  });
});

describe('dish templates (proactive decomposition)', () => {
  it('burrito de pastor → tortilla, pastor, papa, queso, cebolla, grasa', () => {
    const d = matchDish('burrito al pastor')!;
    expect(d.components.map((c) => c.query).join(' | ')).toMatch(/tortilla.*pastor.*potato.*cheese.*onion.*oil/is);
    const total = d.components.reduce((a, c) => a + c.kcal, 0);
    expect(total).toBeGreaterThan(500);
    expect(total).toBeLessThan(700);
  });
  it('bandeja paisa → its parts', () => {
    const d = matchDish('bandeja paisa')!;
    expect(d.components.length).toBeGreaterThanOrEqual(7);
    expect(d.components.map((c) => c.query).join(' ')).toMatch(/rice.*beans/i);
  });
  it('a composite dish with no template must be decomposed; its components are not', () => {
    expect(isCompositeDish('tacos de suadero')).toBe(true);
    expect(isCompositeDish('flour tortilla, burrito size')).toBe(false);
    expect(isCompositeDish('egg')).toBe(false);
    expect(isCompositeDish('hamburger')).toBe(true);
  });
});

describe('branded classifier', () => {
  it('chains and packaged products are recognized; street dishes are not', () => {
    expect(brandOf("McDonald's Big Mac")).toMatchObject({ brand: "McDonald's", chain: true });
    expect(brandOf('big mac')?.brand).toBe("McDonald's");
    expect(brandOf("un Hershey's")).toMatchObject({ brand: "Hershey's", chain: false });
    expect(brandOf('Wingstop boneless')?.chain).toBe(true);
    expect(brandOf('burrito al pastor')).toBeUndefined();
    expect(brandOf('tacos de suadero')).toBeUndefined();
  });
  it('an option is the brand by its brand field or name, not by a copycat name', () => {
    const b = brandOf('big mac')!;
    expect(optionIsBrand(b, { name: 'Big Mac', brand: "McDonald's" })).toBe(true);
    expect(optionIsBrand(b, { name: "McDonald's - Big Mac", brand: null })).toBe(true);
    expect(optionIsBrand(b, { name: 'Big Mac copycat (homemade)', brand: null })).toBe(false);
  });
});

describe('day targets', () => {
  it('reads explicit statements', () => {
    expect(dayTypeFromText('hoy tengo gimnasia')).toBe('gimnasia');
    expect(dayTypeFromText('hoy no entreno')).toBe('rest');
    expect(dayTypeFromText('hoy hice pesas')).toBe('pesas');
    expect(dayTypeFromText('¿me cabe un Cornetto?')).toBeUndefined();
  });
  it('told > calendar > schedule hint; targets per type', async () => {
    const kv = new MemoryKv();
    const p = profile();
    const planner = new DayPlanner(p, kv, { calendar: async (d) => (d === '2026-10-24' ? 'pesas' : undefined) });
    const wed = await planner.dayType('2026-10-21'); // Wednesday
    expect(wed.source).toBe(p.schedule?.wed ? 'schedule' : 'unknown');
    expect((await planner.dayType('2026-10-24')).source).toBe('calendar');
    await planner.set('2026-10-21', 'rest');
    expect(await planner.dayType('2026-10-21')).toMatchObject({ type: 'rest', source: 'told' });
    expect(planner.target('gimnasia').kcal[1]).toBeGreaterThanOrEqual(planner.target('rest').kcal[1]);
  });
});

describe('prompt pieces', () => {
  it('style rules stay small (~300 tokens)', () => {
    expect(STYLE_RULES.join('\n').length / 4).toBeLessThan(380);
  });
  it('the dictionary prompt lists names and kcal, never targets or context', async () => {
    const b = new FoodBook(profile(), new MemoryKv());
    const s = await dictionaryPrompt(b);
    expect(s).toMatch(/Cornetto/);
    expect(s).toMatch(/208/);
    expect(s).not.toMatch(/target|weight|peso/i);
  });
  it('long context is loaded only for planning/advice questions', () => {
    const p = profile();
    expect(contextFor(p, '¿qué ceno hoy?')).toMatch(/##/);
    expect(contextFor(p, 'registra 2 huevos')).toBe('');
    expect(contextFor(p, 'ayúdame con el meal prep de la semana')).toMatch(/meal/i);
  });
});
