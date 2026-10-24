/**
 * The owner's food dictionary and saved recipes (seeded from the private profile, grown at
 * runtime in the hub's database), plus "seen" counts so Alfred can PROPOSE saving a food that
 * keeps coming back. One-off foods are only counted, never saved on their own.
 */
import { normalizeUnit } from '../mcp/common-foods.js';
import type { Food, NutritionKv, Profile, Recipe, RecipeItem } from './profile.js';

const LEARNED_KEY = 'nutrition:foods';
const LEARNED_RECIPES_KEY = 'nutrition:recipes';
const SEEN_KEY = 'nutrition:seen';
/** Distinct days a food must be logged on before Alfred proposes saving it. */
export const PROPOSE_AFTER_DAYS = 3;
const MAX_SEEN = 300;

export const normFood = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** Words, plurals folded ("huevos" → "huevo", "eggs" → "egg"). */
const tokens = (s: string) => normFood(s).split(' ').filter(Boolean).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));

/** Words that do not change which food it is ("2 large scrambled eggs" is still eggs). */
const NEUTRAL = new Set(['large', 'medium', 'small', 'whole', 'fresh', 'scrambled', 'fried', 'boiled', 'cooked', 'raw', 'grande', 'mediano', 'pequeno', 'revuelto', 'frito', 'cocido', 'crudo', 'de', 'of', 'the', 'a', 'un', 'una', 'el', 'la', 'con', 'with', 'plain', 'regular', 'normal', 'generic', 'can', 'lata', 'glass', 'vaso', 'cup', 'taza', 'unit', 'piece', 'pieza', 'serving', 'porcion']);

/** Does `query` name the food `phrase` (all its words, extras only neutral)? */
function names(query: string, phrase: string): boolean {
  const q = tokens(query);
  const p = tokens(phrase);
  if (!p.length || !q.length) return false;
  if (q.join(' ') === p.join(' ')) return true;
  if (!p.every((w) => q.includes(w))) return false;
  return q.filter((w) => !p.includes(w)).every((w) => NEUTRAL.has(w) || /^\d+$/.test(w));
}

const COUNT = new Set(['unit', 'units', 'piece', 'pieces', 'whole', 'item', 'serving', 'portion', 'plate', 'bowl', '']);
const MASS = new Set(['g', 'gr', 'gram', 'grams', 'ml']);

export interface BookItem {
  query: string;
  quantity: number;
  unit: string;
  kcal_estimate: number;
  protein?: number;
}

export interface SeenProposal {
  query: string;
  quantity: number;
  unit: string;
  kcal: number;
  days: number;
}

export class FoodBook {
  constructor(
    private readonly profile: Profile | undefined,
    private readonly kv: NutritionKv,
  ) {}

  get enabled(): boolean {
    return !!this.profile;
  }

  async foods(): Promise<Food[]> {
    const learned = (await this.kv.get<Food[]>(LEARNED_KEY)) ?? [];
    return [...(this.profile?.foods ?? []), ...learned];
  }

  async recipes(): Promise<Recipe[]> {
    const learned = (await this.kv.get<Recipe[]>(LEARNED_RECIPES_KEY)) ?? [];
    return [...(this.profile?.recipes ?? []), ...learned];
  }

  /** The dictionary food a query names, or undefined. */
  async food(query: string): Promise<Food | undefined> {
    if (!this.profile) return undefined;
    const all = await this.foods();
    // exact first, then by words (longest phrase wins: "coca cola zero" before "cola")
    const exact = all.find((f) => [f.name, f.query, ...f.aliases].some((a) => normFood(a) === normFood(query)));
    if (exact) return exact;
    let best: { f: Food; len: number } | undefined;
    for (const f of all) {
      for (const a of [f.name, f.query, ...f.aliases]) {
        if (names(query, a) && (!best || tokens(a).length > best.len)) best = { f, len: tokens(a).length };
      }
    }
    return best?.f;
  }

  async byName(name: string): Promise<Food | undefined> {
    return (await this.foods()).find((f) => normFood(f.name) === normFood(name));
  }

  /** The saved recipe a query names, or undefined. */
  async recipe(query: string): Promise<Recipe | undefined> {
    if (!this.profile) return undefined;
    const all = await this.recipes();
    return all.find((r) => [r.name, ...r.aliases].some((a) => normFood(a) === normFood(query))) ?? all.find((r) => [r.name, ...r.aliases].some((a) => names(query, a)));
  }

  /**
   * Did the query name the MFP entry itself ("Harina PAN blanca 40 g") rather than the user's
   * thing ("arepa 120 g")? Then grams are already MFP grams (dry flour), not masa.
   */
  namesMfpEntry(food: Food, query: string): boolean {
    return names(query, food.query) && ![food.name, ...food.aliases].some((a) => names(query, a));
  }

  /** A dictionary food in log_meal terms (MFP query, quantity and unit; kcal from the dictionary). */
  toItem(food: Food, quantity: number, unit: string, opts: { mfpGrams?: boolean } = {}): BookItem {
    const u = normalizeUnit(unit);
    const own = normalizeUnit(food.unit);
    const per = (n: number) => (food.per_unit ? { quantity: round(n * food.per_unit.quantity), unit: food.per_unit.unit } : { quantity: round(n), unit: food.unit });
    const out = (n: number, mfp: { quantity: number; unit: string }) => ({ query: food.query, ...mfp, kcal_estimate: round(n * food.kcal), ...(food.protein !== undefined ? { protein: round(n * food.protein) } : {}) });
    if (food.only_unit && u !== own) return out(food.default_quantity ?? 1, per(food.default_quantity ?? 1));
    if (MASS.has(u) && !MASS.has(own)) {
      // grams of the user's thing: arepa masa → flour grams; else grams the food is weighed in
      const g = food.per_gram && !opts.mfpGrams ? quantity * food.per_gram : quantity;
      const base = food.per_unit && MASS.has(normalizeUnit(food.per_unit.unit)) ? food.per_unit.quantity : undefined;
      if (base) return out(g / base, { quantity: round(g), unit: food.per_unit!.unit });
    }
    const n = COUNT.has(u) && quantity === 1 && food.default_quantity && !food.per_unit ? food.default_quantity : quantity;
    return out(n, per(n));
  }

  expandRecipe(recipe: Recipe, portions: number): (BookItem & { from: string })[] {
    return recipe.items.map((i: RecipeItem) => ({ query: i.query, quantity: round(i.quantity * portions), unit: i.unit, kcal_estimate: round(i.kcal * portions), ...(i.protein !== undefined ? { protein: round(i.protein * portions) } : {}), from: recipe.name }));
  }

  /** Save a food (the user agreed to a proposal). Replaces one with the same name. */
  async learn(food: Food): Promise<void> {
    const learned = ((await this.kv.get<Food[]>(LEARNED_KEY)) ?? []).filter((f) => normFood(f.name) !== normFood(food.name));
    await this.kv.set(LEARNED_KEY, [...learned, { ...food, aliases: food.aliases ?? [] }]);
    const seen = (await this.kv.get<Record<string, SeenRec>>(SEEN_KEY)) ?? {};
    const key = normFood(food.query);
    if (seen[key]) {
      seen[key]!.proposed = true;
      await this.kv.set(SEEN_KEY, seen);
    }
  }

  async learnRecipe(recipe: Recipe): Promise<void> {
    const learned = ((await this.kv.get<Recipe[]>(LEARNED_RECIPES_KEY)) ?? []).filter((r) => normFood(r.name) !== normFood(recipe.name));
    await this.kv.set(LEARNED_RECIPES_KEY, [...learned, { ...recipe, aliases: recipe.aliases ?? [] }]);
  }

  /**
   * Count a logged food that is NOT in the dictionary. On its PROPOSE_AFTER_DAYS-th distinct day
   * it is proposed (once); a food logged once a year never is.
   */
  async seen(item: { query: string; quantity: number; unit: string; kcal: number }, day: string): Promise<SeenProposal | undefined> {
    if (!this.profile) return undefined;
    const seen = (await this.kv.get<Record<string, SeenRec>>(SEEN_KEY)) ?? {};
    const key = normFood(item.query);
    const rec: SeenRec = seen[key] ?? { query: item.query, quantity: item.quantity, unit: item.unit, kcal: item.kcal, days: [] };
    if (!rec.days.includes(day)) rec.days = [...rec.days, day].slice(-10);
    Object.assign(rec, { quantity: item.quantity, unit: item.unit, kcal: item.kcal });
    let proposal: SeenProposal | undefined;
    if (!rec.proposed && rec.days.length >= PROPOSE_AFTER_DAYS) {
      rec.proposed = true;
      proposal = { query: rec.query, quantity: rec.quantity, unit: rec.unit, kcal: rec.kcal, days: rec.days.length };
    }
    seen[key] = rec;
    const keys = Object.keys(seen);
    if (keys.length > MAX_SEEN) for (const k of keys.slice(0, keys.length - MAX_SEEN)) delete seen[k];
    await this.kv.set(SEEN_KEY, seen);
    return proposal;
  }
}

interface SeenRec {
  query: string;
  quantity: number;
  unit: string;
  kcal: number;
  days: string[];
  proposed?: boolean;
}

const round = (n: number) => Math.round(n * 100) / 100;
