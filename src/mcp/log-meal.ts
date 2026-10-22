import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import { KCAL_CONFIRM_THRESHOLD } from './nutrition.js';
import { normalizeUnit, standardPortion } from './common-foods.js';
import type { FoodBook } from '../nutrition/book.js';
import type { DayPlanner } from '../nutrition/day.js';
import type { Food, Profile } from '../nutrition/profile.js';
import { dishKcal, isCompositeDish, matchDish, portionsInText, repeatsComponent, type Dish } from '../nutrition/dishes.js';
import { brandOf, optionIsBrand, type Brand } from '../nutrition/brands.js';

/**
 * Hub-side composite tool: log a whole meal in ONE model step. For each item, in code:
 * draft → serving matching the unit → 2× estimate check and the 800 kcal guard → log (pinned)
 * → one readback. Uncertain items are NOT guessed: they come back as `ambiguous` with the top
 * options so the assistant asks; confident items are logged.
 *
 * Frequent foods: every log is pinned in Mason (query → food + serving), including the
 * option the user picks after an `ambiguous` answer. The next draft for that query lists the
 * pinned food first and `choose` prefers it, so a confirmed choice is reused.
 */
type Rec = Record<string, unknown>;
export interface MealToolbox {
  execute(name: string, args: Rec, opts?: { raw?: boolean }): Promise<unknown>;
}

export const ItemSchema = z.object({
  query: z.string().min(1).describe('Food in ENGLISH, as MyFitnessPal names it (e.g. "egg", "whole wheat bread", "arepa")'),
  quantity: z.number().positive().describe('How many units the user said (2 eggs → 2; 150 g → 150)'),
  unit: z.string().min(1).describe('The user\'s unit: "unit"/"piece" for countable items (egg, arepa, banana), or slice, cup, g, ml, tbsp, serving…'),
  kcal_estimate: z.number().min(0).describe('YOUR estimate of the kcal for the whole item (quantity × unit), before looking it up; 0 is fine (water, gum, black coffee, diet soda)'),
  meal: z.enum(['breakfast', 'lunch', 'dinner', 'snacks']),
});
export const LogMealInput = z.object({
  items: z.array(ItemSchema).min(1).max(12),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD, default today'),
});
type Item = z.infer<typeof ItemSchema>;

interface Serving {
  serving: number;
  label: string;
  calories?: number;
}
interface Option {
  option: number;
  name: string;
  brand?: string | null;
  verified?: boolean;
  pinned?: boolean;
  suggested_serving?: number;
  servings: Serving[];
}

const COUNT_UNITS = new Set(['unit', 'units', 'piece', 'pieces', 'pc', 'whole', 'item', 'items', 'unidad', 'unidades', 'pieza']);
const MASS = /(\d+(?:[.,]\d+)?)\s*(g|gr|gram|grams|ml)\b/i;
const MEASURE = /\b(g|gr|gram|ml|oz|cup|cups|tbsp|tsp|lb|kg|l)\b/i;
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim();

/**
 * How many of this serving the user's quantity+unit is, or undefined if the serving doesn't
 * match the unit. 150 g with a "100 g" serving → 1.5; 2 units with "1 large egg" → 2.
 */
const GENERIC_UNITS = new Set(['serving', 'portion', 'porcion', 'racion', 'plate', 'plato', 'helping']);

export function servingsFor(item: Pick<Item, 'quantity' | 'unit'>, label: string, opts: { suggested?: boolean } = {}): number | undefined {
  const unit = norm(item.unit).replace(/s$/, '');
  const full = norm(label);
  if (GENERIC_UNITS.has(unit)) return opts.suggested ? item.quantity : undefined; // "a serving" = MFP's suggested serving
  const l = full.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(); // "1 breast (172 g)" → "1 breast"
  if (unit === 'g' || unit === 'gr' || unit === 'gram' || unit === 'ml') {
    const m = full.match(MASS); // "1 cup (240 ml)" counts as 240 ml
    if (!m) return undefined;
    const size = Number(m[1]!.replace(',', '.'));
    const sameKind = (m[2]!.toLowerCase() === 'ml') === (unit === 'ml');
    return sameKind && size > 0 ? item.quantity / size : undefined;
  }
  const startsWithOne = /^1(\.0)?\s/.test(l) || /^one\s/.test(l);
  if (COUNT_UNITS.has(unit) || COUNT_UNITS.has(`${unit}s`)) {
    return startsWithOne && !MEASURE.test(l) ? item.quantity : undefined;
  }
  // named unit: slice, cup, tbsp, serving, egg, arepa, container…
  return l.includes(unit) && startsWithOne ? item.quantity : undefined;
}

export interface Candidate {
  option: number;
  name: string;
  serving: number;
  label: string;
  servings: number;
  kcal: number;
  pinned: boolean;
}

/** Candidates whose serving matches the unit, with kcal for the whole item. */
export function candidates(item: Item, options: Option[], draftQuantity: number): Candidate[] {
  const out: Candidate[] = [];
  for (const o of options) {
    // a generic unit ("a serving", "una porción") means MFP's suggested serving, unless that is a
    // measure (100 g) and the food has a countable one ("1 breast (172 g)"): a portion of chicken is a breast
    const countable = o.servings.find((s) => /^1\s/.test(norm(s.label).replace(/\([^)]*\)/g, '').trim()) && !MEASURE.test(norm(s.label).replace(/\([^)]*\)/g, '')));
    const suggestedServing = o.servings.find((s) => s.serving === (o.suggested_serving ?? 0));
    const generic = suggestedServing && MEASURE.test(norm(suggestedServing.label).replace(/\([^)]*\)/g, '')) && countable ? countable : suggestedServing;
    for (const s of o.servings) {
      const n = servingsFor(item, s.label, { suggested: s === generic });
      if (n === undefined || typeof s.calories !== 'number') continue;
      const perServing = s.calories / (draftQuantity || 1);
      out.push({ option: o.option, name: o.name, serving: s.serving, label: s.label, servings: Math.round(n * 1000) / 1000, kcal: Math.round(perServing * n), pinned: !!o.pinned });
      break; // first matching serving per option
    }
  }
  return out;
}

const within = (a: number, b: number, f: number) => a <= b * f && a >= b / f;
/**
 * Within 2× of the estimate, or close in absolute terms (a 15 kcal salad vs a 40 kcal guess is
 * fine), or both small (a 35 kcal bowl of salad vs a 100 kcal guess: a miss costs < 150 kcal).
 */
const plausible = (kcal: number, est: number) => within(kcal, est, 2) || Math.abs(kcal - est) <= 60 || (kcal < 80 && est <= 150);

/** Pick confidently, or return undefined (→ ask the user). */
export function choose(item: Item, cands: Candidate[]): Candidate | undefined {
  const est = item.kcal_estimate;
  const ok = cands.filter((c) => plausible(c.kcal, est));
  if (!ok.length) return undefined;
  const pinned = ok.find((c) => c.pinned);
  if (pinned) return pinned;
  if (ok.length === 1) return ok[0];
  const close = ok.filter((c) => within(c.kcal, est, 1.35));
  const spread = Math.max(...ok.map((c) => c.kcal)) / Math.min(...ok.map((c) => c.kcal));
  if (spread <= 1.3) return ok[0]; // all plausible options agree: take MFP's top one
  const near = ok.filter((c) => Math.abs(c.kcal - est) <= 15);
  if (near.length === 1) return near[0]; // e.g. black coffee estimated 0: 2 kcal, not 60
  if (close.length === 1) return close[0];
  return undefined;
}

export interface LogMealResult {
  logged: { query: string; name: string; serving: string; servings: number; kcal: number; meal: string; source: string; part_of?: string }[];
  ambiguous: { query: string; quantity: number; unit: string; kcal_estimate: number; reason: string; part_of?: string; options: { name: string; serving: string; kcal: number; draft_id?: string; option?: number; serving_index?: number; servings?: number }[] }[];
  needs_confirmation: { query: string; name: string; kcal: number; log_with: Rec }[];
  failed: { query: string; error: unknown }[];
  /** Whole dishes the hub refused: the model must log their components instead. */
  decompose: { query: string; meal: string; not_in_mfp?: boolean }[];
  /** Extras the hub added (spray, the implied drink), in the user's words. */
  assumed: string[];
  /** Dishes/recipes logged as components, with their totals. */
  dishes: { name: string; portions: number; components: number; kcal: number }[];
  meal_totals: { meal: string; items: number; kcal: number }[];
  /** Names logged in this meal more than once (the user may have logged it already). */
  possible_duplicates: string[];
  day_total?: Record<string, unknown>;
  dictionary_proposal?: { query: string; quantity: number; unit: string; kcal: number; days: number; note: string };
  note: string;
}

/** Shared-shape error of a result, also for Mastra's {error: true, message} validation errors. */
const errOf = (v: unknown) => {
  if (!v || typeof v !== 'object' || !('error' in (v as Rec))) return undefined;
  const e = (v as Rec).error;
  return e === true ? { code: 'BAD_ARGS', message: String((v as Rec).message ?? 'invalid arguments').split('\n')[0], retryable: false } : e;
};

/** The nutrition brain behind log_meal (only with a profile; without it log_meal is unchanged). */
export interface MealNutrition {
  book: FoodBook;
  planner?: DayPlanner;
  defaults: Profile['defaults'];
  /** The user's message (implied drink / "I cooked it" detection). */
  userText: () => string | undefined;
  /** Today, YYYY-MM-DD (local). */
  today: () => string;
}

export interface LogMealOptions {
  /** The meal decided in code for this request (spoken word / hour); overrides the model's. */
  mealHint?: (date: string | undefined) => Item['meal'] | undefined;
  nutrition?: MealNutrition;
}

type Source = 'model' | 'dictionary' | 'recipe' | 'dish' | 'extra';
interface Planned {
  item: Item;
  source: Source;
  group?: { name: string; portions: number };
  food?: Food;
  /** A branded / chain product: ONE entry of that brand (never decomposed). */
  brand?: Brand;
  /** A whole unbranded dish with no template: one entry only if MFP has a verified branded one. */
  composite?: boolean;
}
interface Picked {
  planned: Planned;
  pick: Candidate;
  args: Rec;
}

const norm2 = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
/** A drink, by its MFP/model name. */
const DRINK = /\b(coffee|cafe|tinto|juice|jugo|soda|cola|coke|clight|water|agua|milk|leche|tea|shake|batido|smoothie|beer|cerveza|wine|vino|lemonade|limonada|refresco|gaseosa|drink|bebida|malteada|kombucha|electrolit|gatorade|powerade|sprite|pepsi)\b/;
/** The user mentioned a drink (then no default one). */
const SAID_DRINK = /\b(cafe|tinto|jugo|agua|gaseosa|coca|cola|soda|clight|leche|un te|aromatica|cerveza|vino|batido|malteada|limonada|refresco|bebida|tome|sin bebida|nada de tomar|coffee|juice|water|drink|tea|milk|beer)\b/;
const FAT = /\b(spray|oil|aceite|butter|mantequilla|ghee|manteca|lard)\b/;
/** The user cooked it at home (then the usual spray). */
const COOKED = /\b(cocine|hice|prepare|frei|frito|frita|fritos|fritas|revuelt\w*|a la plancha|asad[oa]s?|sofrit\w*|en la sarten|saltead\w*|en sarten|cooked|fried|scrambled|made)\b/;
const OUT = /\b(restaurante|pedi|domicilio|rappi|compre|en la calle|callejer\w*|puesto|food truck|me invitaron|ordered|takeout)\b/;
const VAGUE_UNITS = new Set(['serving', 'portion', 'plate', 'bowl', 'unit', 'whole', 'piece', 'helping', 'box', 'caja', 'tray']);

export function createLogMeal(toolbox: MealToolbox, log: (m: string) => void = () => {}, opts: LogMealOptions = {}) {
  const nut = opts.nutrition?.book.enabled ? opts.nutrition : undefined;

  /** Classify each item: recipe, dictionary food, brand (one entry), known dish (components), whole dish, plain. */
  /**
   * The user named a known dish but the model listed its parts itself (often without the
   * cooking fat, with its own portions): use the dish's components instead.
   */
  function ownDish(items: Item[]): Item[] {
    const text = nut!.userText() ?? '';
    const d = matchDish(text);
    if (!d || items.some((i) => matchDish(i.query))) return items;
    const parts = items.filter((i) => repeatsComponent(d, i.query));
    if (parts.length < 2) return items;
    const portions = portionsInText(d, text) ?? 1;
    log(`[log_meal] the user said "${d.name}": ${parts.length} parts the model listed → the dish's components × ${portions}`);
    return [{ query: d.name, quantity: portions, unit: 'serving', kcal_estimate: Math.round(dishKcal(d) * portions), meal: parts[0]!.meal }, ...items.filter((i) => !parts.includes(i))];
  }

  async function plan(given: Item[]): Promise<Planned[]> {
    if (!nut) return given.map((item) => ({ item, source: 'model' as const }));
    const items = ownDish(given);
    const planned: Planned[] = [];
    // a known dish in the message: its parts the user also named ("con papa y queso") are in it
    const dishes = items.map((i) => ({ meal: i.meal, dish: matchDish(i.query) })).filter((x): x is { meal: Item['meal']; dish: Dish } => !!x.dish);
    for (const item of items) {
      const of = !matchDish(item.query) && dishes.find((x) => x.meal === item.meal && repeatsComponent(x.dish, item.query));
      if (of) {
        log(`[log_meal] "${item.query}" is already part of ${of.dish.name}: not logged twice`);
        continue;
      }
      const unit = normalizeUnit(item.unit);
      const recipe = VAGUE_UNITS.has(unit) || /^(recipe|receta)$/.test(unit) ? await nut.book.recipe(item.query) : undefined;
      if (recipe) {
        for (const i of nut.book.expandRecipe(recipe, item.quantity)) planned.push({ item: { query: i.query, quantity: i.quantity, unit: i.unit, kcal_estimate: i.kcal_estimate, meal: item.meal }, source: 'recipe', group: { name: recipe.name, portions: item.quantity } });
        log(`[log_meal] recipe "${recipe.name}" × ${item.quantity} → ${recipe.items.length} ingredients`);
        continue;
      }
      const food = await nut.book.food(item.query);
      if (food) {
        const b = nut.book.toItem(food, item.quantity, item.unit);
        planned.push({ item: { query: b.query, quantity: b.quantity, unit: b.unit, kcal_estimate: b.kcal_estimate, meal: item.meal }, source: 'dictionary', food });
        continue;
      }
      // classifier: a brand or chain item has fixed, published nutrition → one entry, never parts
      const brand = brandOf(item.query);
      if (brand) {
        planned.push({ item, source: 'model', brand });
        continue;
      }
      const dish = matchDish(item.query);
      if (dish) {
        for (const c of dish.components) planned.push({ item: { query: c.query, quantity: Math.round(c.quantity * item.quantity * 100) / 100, unit: c.unit, kcal_estimate: Math.round(c.kcal * item.quantity), meal: item.meal }, source: 'dish', group: { name: dish.name, portions: item.quantity } });
        log(`[log_meal] dish "${dish.name}" × ${item.quantity} → ${dish.components.length} components`);
        continue;
      }
      if (isCompositeDish(item.query)) {
        planned.push({ item, source: 'model', composite: true });
        continue;
      }
      planned.push({ item, source: 'model' });
    }
    return planned;
  }

  /** Draft + choose: a confident pick, or the item is reported (ambiguous / failed / confirm). */
  async function resolve(p: Planned, date: string | undefined, out: LogMealResult): Promise<Picked | undefined> {
    const item = p.item;
    const meal = item.meal;
    // 2. draft (draft quantity 1: we convert the user's quantity into servings ourselves)
    const d = (await toolbox.execute('fitness_draft_food', { query: item.query, quantity: 1, meal, ...(date ? { date } : {}) }, { raw: true })) as Rec;
    if (errOf(d) && p.composite) {
      log(`[log_meal] "${item.query}" is a whole dish (no MFP entry): sent back to be decomposed`);
      out.decompose.push({ query: item.query, meal });
      return undefined;
    }
    if (errOf(d)) return void out.failed.push({ query: item.query, error: errOf(d) });
    let options = (d.options as Option[] | undefined) ?? [];
    const draftQty = Number(d.quantity ?? 1);
    const decompose = (notInMfp: boolean, why: string) => {
      log(`[log_meal] "${item.query}" ${why}: sent back to be decomposed`);
      out.decompose.push({ query: item.query, meal, ...(notInMfp ? { not_in_mfp: true } : {}) });
      return undefined;
    };
    if (p.brand) {
      const mine = options.filter((o) => optionIsBrand(p.brand!, o));
      if (mine.length) options = mine;
      else if (p.brand.chain) return decompose(true, `(${p.brand.brand}) is not in MFP`);
    }
    if (p.composite) {
      // a whole dish: one entry only for a verified branded MFP item with a fixed serving
      const fixed = options.filter((o) => o.verified && !!o.brand);
      if (!fixed.length) return decompose(false, 'is a whole dish');
      options = fixed;
    }
    const asked = { ...item, unit: normalizeUnit(item.unit) }; // "taza" → cup, "rebanada" → slice
    const std = standardPortion(item.query, item.quantity, asked.unit);
    const stdItem = std ? { ...asked, quantity: std.quantity, unit: std.unit } : undefined;
    // a common food's own size for a vague unit ("un plato de arroz" = 1.5 cups) comes first;
    // otherwise MFP's servings first and the standard portion before asking ("arroz" → 1 cup)
    // …unless MFP has a serving with the user's own unit ("1 bowl" of salad): that wins
    const native = options.some((o) => o.servings.some((sv) => servingsFor(asked, sv.label) !== undefined));
    const tries = !stdItem ? [asked] : std!.specific && !native ? [stdItem, asked] : [asked, stdItem];
    let cands: Candidate[] = [];
    let pick: Candidate | undefined;
    for (const t of tries) {
      const c = candidates(t, options, draftQty);
      if (!cands.length) cands = c;
      pick = choose(t, c);
      if (pick) {
        if (t === stdItem) log(`[log_meal] ${item.quantity} ${item.unit} of a common food → ${std!.quantity} ${std!.unit}`);
        break;
      }
    }
    if (!pick && p.composite) return decompose(false, 'is a whole dish (no verified branded MFP match)');
    if (!pick) {
      const shown = (cands.length ? cands : options.flatMap((o) => o.servings.slice(0, 1).map((s) => ({ option: o.option, name: o.name, serving: s.serving, label: s.label, servings: 1, kcal: Math.round(Number(s.calories ?? 0)), pinned: false }))))
        .sort((a, b) => Math.abs(Math.log((a.kcal + 1) / (item.kcal_estimate + 1))) - Math.abs(Math.log((b.kcal + 1) / (item.kcal_estimate + 1))))
        .slice(0, 3);
      log(`[log_meal] ambiguous "${item.query}" ${item.quantity} ${item.unit} (estimate ${item.kcal_estimate} kcal): ${shown.map((c) => `${c.label} ${c.kcal}`).join(', ') || 'no options'}`);
      out.ambiguous.push({
        query: item.query,
        quantity: item.quantity,
        unit: item.unit,
        kcal_estimate: item.kcal_estimate,
        reason: !cands.length ? `no serving matches "${item.unit}"` : cands.some((c) => plausible(c.kcal, item.kcal_estimate)) ? 'several different foods match' : 'no match within 2× of your estimate',
        ...(p.group ? { part_of: p.group.name } : {}),
        options: shown.map((c) => ({ name: c.name, serving: c.label, kcal: c.kcal, draft_id: String(d.draft_id), option: c.option, serving_index: c.serving, servings: c.servings })),
      });
      return undefined;
    }
    const args = { draft_id: d.draft_id, option: pick.option, serving: pick.serving, quantity: pick.servings, meal, ...(date ? { date } : {}) };
    // 3. hard guard: > 800 kcal goes through the normal approval card (fitness_log_food)
    if (pick.kcal > KCAL_CONFIRM_THRESHOLD) {
      out.needs_confirmation.push({ query: item.query, name: pick.name, kcal: pick.kcal, log_with: args });
      return undefined;
    }
    return { planned: p, pick, args };
  }

  async function commit(x: Picked, out: LogMealResult): Promise<Rec | undefined> {
    const r = (await toolbox.execute('fitness_log_food', { ...x.args, pin: true }, { raw: true })) as Rec;
    if (errOf(r)) return void out.failed.push({ query: x.planned.item.query, error: errOf(r) });
    const p = x.planned;
    out.logged.push({ query: p.item.query, name: x.pick.name, serving: x.pick.label, servings: x.pick.servings, kcal: x.pick.kcal, meal: p.item.meal, source: x.pick.pinned ? 'pinned' : p.source === 'model' ? 'draft' : p.source, ...(p.group ? { part_of: p.group.name } : {}) });
    return r;
  }

  /**
   * Dish/recipe totals: the 2× check and the 800 kcal guard also apply to a whole decomposed
   * dish (per portion). A group that fails is not logged at all; the model asks.
   */
  function checkGroups(picked: Picked[], planned: Planned[], out: LogMealResult): Picked[] {
    const groups = [...new Set(planned.filter((p) => p.group).map((p) => p.group!.name))];
    let keep = picked;
    for (const g of groups) {
      const members = planned.filter((p) => p.group?.name === g);
      const portions = members[0]!.group!.portions || 1;
      const got = picked.filter((x) => x.planned.group?.name === g);
      const total = got.reduce((a, x) => a + x.pick.kcal, 0);
      const expected = got.reduce((a, x) => a + x.planned.item.kcal_estimate, 0);
      const perPortion = total / portions;
      const reason = !plausible(total, expected)
        ? `the components add up to ${total} kcal, not within 2× of the expected ${expected} kcal`
        : perPortion > KCAL_CONFIRM_THRESHOLD && expected / portions <= KCAL_CONFIRM_THRESHOLD
          ? `one portion is ${Math.round(perPortion)} kcal (over ${KCAL_CONFIRM_THRESHOLD}); confirm with the user`
          : undefined;
      if (reason) {
        log(`[log_meal] dish "${g}" not logged: ${reason}`);
        keep = keep.filter((x) => x.planned.group?.name !== g);
        out.ambiguous.push({ query: g, quantity: portions, unit: 'serving', kcal_estimate: expected, reason, part_of: g, options: got.map((x) => ({ name: x.pick.name, serving: x.pick.label, kcal: x.pick.kcal })) });
        continue;
      }
      out.dishes.push({ name: g, portions, components: got.length, kcal: total });
    }
    return keep;
  }

  const diaryOf = (r: Rec | undefined) => (((r?.day as Rec | undefined)?.diary ?? []) as { meal?: string; name?: string; calories?: number }[]);
  const inMeal = <T extends { meal?: string }>(diary: T[], meal: string): T[] => diary.filter((x) => String(x.meal ?? '').toLowerCase() === meal);

  /** The usual extras for a meal: spray for home-cooked foods, the implied 0-kcal drink. */
  async function extras(planned: Planned[], meal: Item['meal'], date: string | undefined, last: Rec | undefined, out: LogMealResult): Promise<Rec | undefined> {
    if (!nut || !last) return last;
    const text = norm2(nut.userText() ?? '');
    const mine = planned.filter((p) => p.item.meal === meal);
    const diary = inMeal(diaryOf(last), meal);
    const add = async (foodName: string | undefined, why: (f: Food, kcal: number) => string) => {
      const f = foodName ? await nut.book.byName(foodName) : undefined;
      if (!f) return;
      const b = nut.book.toItem(f, f.default_quantity ?? 1, f.unit);
      const p: Planned = { item: { query: b.query, quantity: b.quantity, unit: b.unit, kcal_estimate: b.kcal_estimate, meal }, source: 'extra', food: f };
      const x = await resolve(p, date, out);
      const r = x && (await commit(x, out));
      if (r) {
        last = r;
        out.assumed.push(why(f, x!.pick.kcal));
      }
    };
    // spray: a dictionary food usually cooked with it, or the user said they cooked (not eaten out)
    const cooked = mine.some((p) => p.food?.spray) || (COOKED.test(text) && mine.some((p) => p.source === 'model' || p.source === 'dictionary'));
    const hasFat = mine.some((p) => FAT.test(norm2(p.item.query))) || diary.some((e) => FAT.test(norm2(String(e.name ?? ''))));
    if (cooked && !hasFat && !OUT.test(text) && nut.defaults.spray) {
      await add(nut.defaults.spray, (f, kcal) => `${f.name}: ${f.default_quantity ?? 1} ${f.unit} (~${kcal} kcal)`);
    }
    // the implied drink: breakfast/lunch/dinner with no drink in the message or the meal
    const drinkNamed = mine.some((p) => p.food?.drink || DRINK.test(norm2(p.item.query))) || diary.some((e) => DRINK.test(norm2(String(e.name ?? '')))) || SAID_DRINK.test(text);
    const d = nut.defaults.drinks;
    const drink = meal === 'breakfast' ? d?.breakfast : meal === 'snacks' ? undefined : d?.other;
    if (drink && !drinkNamed) await add(drink, (f, kcal) => `bebida: ${f.name} (${kcal} kcal), porque no mencionó bebida`);
    return last;
  }

  return createTool({
    id: 'log_meal',
    description:
      'Log one or more foods to MyFitnessPal in ONE call (use this for every meal; do not draft/log item by item). ' +
      'For each item give the English food name, the user\'s quantity and unit, and your own kcal estimate. The hub picks the matching food and serving, ' +
      'logs the confident items and returns per-item kcal and meal totals. Items it is unsure about come back in "ambiguous" with options: ask the user, ' +
      'then call log_meal again with a more specific query. Items in "needs_confirmation" (> 800 kcal) must be logged with fitness_log_food using log_with (the user approves).' +
      (opts.nutrition?.book.enabled ? ' Complex dishes: one item per component (or a known dish/recipe name). "decompose": call again with the components. "assumed": extras the hub added (tell the user in one line).' : ''),
    inputSchema: LogMealInput,
    execute: async ({ items: given, date }) => {
      const hint = opts.mealHint?.(date);
      const items = hint ? given.map((i) => ({ ...i, meal: hint })) : given;
      if (hint && given.some((i) => i.meal !== hint)) log(`[log_meal] meal ${[...new Set(given.map((i) => i.meal))].join('/')} → ${hint} (from the user's words / local time)`);
      const out: LogMealResult = { logged: [], ambiguous: [], needs_confirmation: [], failed: [], decompose: [], assumed: [], dishes: [], meal_totals: [], possible_duplicates: [], note: '' };
      const planned = await plan(items);
      const picked: Picked[] = [];
      for (const p of planned) {
        try {
          const x = await resolve(p, date, out);
          if (x) picked.push(x);
        } catch (err) {
          out.failed.push({ query: p.item.query, error: { code: 'TOOL_ERROR', message: (err as Error).message, retryable: false } });
        }
      }
      let last: Rec | undefined;
      for (const x of checkGroups(picked, planned, out)) {
        try {
          last = (await commit(x, out)) ?? last;
        } catch (err) {
          out.failed.push({ query: x.planned.item.query, error: { code: 'TOOL_ERROR', message: (err as Error).message, retryable: false } });
        }
      }
      const meals = [...new Set(items.map((i) => i.meal))];
      for (const m of meals) {
        try {
          last = await extras(planned, m, date, last, out);
        } catch (err) {
          log(`[log_meal] extras for ${m} failed: ${(err as Error).message}`);
        }
      }
      // readback: meal totals from the last write's refreshed day (or one read if nothing was written)
      const day = ((last?.day as Rec | undefined) ?? (out.logged.length ? undefined : null)) as Rec | null | undefined;
      const dayRec = (day ?? ((await toolbox.execute('fitness_get_day', date ? { date } : {}, { raw: true })) as Rec)) as Rec | undefined;
      const diary = (dayRec?.diary ?? []) as { meal?: string; name?: string; calories?: number }[];
      out.meal_totals = meals.map((m) => {
        const e = inMeal(diary, m);
        return { meal: m, items: e.length, kcal: Math.round(e.reduce((a, x) => a + Number(x.calories ?? 0), 0)) };
      });
      if (nut) {
        const justLogged = new Set(out.logged.map((l) => l.name));
        for (const m of meals) {
          const names = inMeal(diary, m).map((e) => String(e.name ?? ''));
          for (const n of new Set(names)) if (justLogged.has(n) && names.filter((x) => x === n).length > 1) out.possible_duplicates.push(n);
        }
        const totals = (dayRec?.nutrition ?? {}) as Rec;
        const kcal = typeof totals.calories === 'number' ? totals.calories : diary.reduce((a, x) => a + Number(x.calories ?? 0), 0);
        if (nut.planner && out.logged.length) out.day_total = await nut.planner.readback(date ?? nut.today(), { kcal, ...(typeof totals.protein === 'number' ? { protein: totals.protein } : {}) });
        // a food that keeps coming back (logged on 3 different days) → propose saving it
        for (const l of out.logged.filter((x) => x.source === 'draft' || x.source === 'pinned')) {
          const p = planned.find((q) => q.item.query === l.query && q.source === 'model');
          if (!p) continue;
          const proposal = await nut.book.seen({ query: p.item.query, quantity: p.item.quantity, unit: p.item.unit, kcal: l.kcal }, date ?? nut.today());
          if (proposal && !out.dictionary_proposal) out.dictionary_proposal = { ...proposal, note: `logged on ${proposal.days} different days: offer to save it (save_food) in one line` };
        }
      }
      const notes = [
        out.ambiguous.length ? 'Ask the user to choose for the ambiguous items (show name, serving, kcal); nothing was logged for them.' : '',
        out.decompose.length ? `Not logged: ${out.decompose.map((x) => `"${x.query}"`).join(', ')} (a whole dish${out.decompose.some((x) => x.not_in_mfp) ? '; not_in_mfp = the chain item is not in MFP: tell the user in one line' : ''}). Call log_meal again now with its components (standard portions), without asking.` : '',
        out.possible_duplicates.length ? 'possible_duplicates: these were already in this meal; tell the user and offer to remove the extra one.' : '',
      ].filter(Boolean);
      out.note = notes.join(' ');
      log(`[log_meal] logged ${out.logged.length}, ambiguous ${out.ambiguous.length}, confirm ${out.needs_confirmation.length}, failed ${out.failed.length}${out.decompose.length ? `, decompose ${out.decompose.length}` : ''}${out.assumed.length ? `, assumed ${out.assumed.length}` : ''}`);
      return Object.fromEntries(Object.entries(out).filter(([, v]) => (Array.isArray(v) ? v.length : v)));
    },
  });
}
