import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import { KCAL_CONFIRM_THRESHOLD } from './nutrition.js';
import { normalizeUnit, standardPortion } from './common-foods.js';

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
  if (close.length === 1) return close[0];
  return undefined;
}

export interface LogMealResult {
  logged: { query: string; name: string; serving: string; servings: number; kcal: number; meal: string; source: string }[];
  ambiguous: { query: string; quantity: number; unit: string; kcal_estimate: number; reason: string; options: { name: string; serving: string; kcal: number; draft_id?: string; option?: number; serving_index?: number; servings?: number }[] }[];
  needs_confirmation: { query: string; name: string; kcal: number; log_with: Rec }[];
  failed: { query: string; error: unknown }[];
  meal_totals: { meal: string; items: number; kcal: number }[];
  note: string;
}

/** Shared-shape error of a result, also for Mastra's {error: true, message} validation errors. */
const errOf = (v: unknown) => {
  if (!v || typeof v !== 'object' || !('error' in (v as Rec))) return undefined;
  const e = (v as Rec).error;
  return e === true ? { code: 'BAD_ARGS', message: String((v as Rec).message ?? 'invalid arguments').split('\n')[0], retryable: false } : e;
};

export interface LogMealOptions {
  /** The meal decided in code for this request (spoken word / hour); overrides the model's. */
  mealHint?: (date: string | undefined) => Item['meal'] | undefined;
}

export function createLogMeal(toolbox: MealToolbox, log: (m: string) => void = () => {}, opts: LogMealOptions = {}) {
  async function logOne(item: Item, date: string | undefined, out: LogMealResult): Promise<Rec | undefined> {
    const meal = item.meal;
    // 2. draft (draft quantity 1: we convert the user's quantity into servings ourselves)
    const d = (await toolbox.execute('fitness_draft_food', { query: item.query, quantity: 1, meal, ...(date ? { date } : {}) }, { raw: true })) as Rec;
    if (errOf(d)) return void out.failed.push({ query: item.query, error: errOf(d) });
    const options = (d.options as Option[] | undefined) ?? [];
    const draftQty = Number(d.quantity ?? 1);
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
    if (!pick) {
      const shown = (cands.length ? cands : options.flatMap((o) => o.servings.slice(0, 1).map((s) => ({ option: o.option, name: o.name, serving: s.serving, label: s.label, servings: 1, kcal: Math.round(Number(s.calories ?? 0)), pinned: false }))))
        .sort((a, b) => Math.abs(Math.log((a.kcal + 1) / (item.kcal_estimate + 1))) - Math.abs(Math.log((b.kcal + 1) / (item.kcal_estimate + 1))))
        .slice(0, 3);
      out.ambiguous.push({
        query: item.query,
        quantity: item.quantity,
        unit: item.unit,
        kcal_estimate: item.kcal_estimate,
        reason: !cands.length ? `no serving matches "${item.unit}"` : cands.some((c) => plausible(c.kcal, item.kcal_estimate)) ? 'several different foods match' : 'no match within 2× of your estimate',
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
    const r = (await toolbox.execute('fitness_log_food', { ...args, pin: true }, { raw: true })) as Rec;
    if (errOf(r)) return void out.failed.push({ query: item.query, error: errOf(r) });
    out.logged.push({ query: item.query, name: pick.name, serving: pick.label, servings: pick.servings, kcal: pick.kcal, meal, source: pick.pinned ? 'pinned' : 'draft' });
    return r;
  }

  return createTool({
    id: 'log_meal',
    description:
      'Log one or more foods to MyFitnessPal in ONE call (use this for every meal; do not draft/log item by item). ' +
      'For each item give the English food name, the user\'s quantity and unit, and your own kcal estimate. The hub picks the matching food and serving, ' +
      'logs the confident items and returns per-item kcal and meal totals. Items it is unsure about come back in "ambiguous" with options: ask the user, ' +
      'then call log_meal again with a more specific query. Items in "needs_confirmation" (> 800 kcal) must be logged with fitness_log_food using log_with (the user approves).',
    inputSchema: LogMealInput,
    execute: async ({ items: given, date }) => {
      const hint = opts.mealHint?.(date);
      const items = hint ? given.map((i) => ({ ...i, meal: hint })) : given;
      if (hint && given.some((i) => i.meal !== hint)) log(`[log_meal] meal ${[...new Set(given.map((i) => i.meal))].join('/')} → ${hint} (from the user's words / local time)`);
      const out: LogMealResult = { logged: [], ambiguous: [], needs_confirmation: [], failed: [], meal_totals: [], note: '' };
      let last: Rec | undefined;
      for (const item of items) {
        try {
          last = (await logOne(item, date, out)) ?? last;
        } catch (err) {
          out.failed.push({ query: item.query, error: { code: 'TOOL_ERROR', message: (err as Error).message, retryable: false } });
        }
      }
      // readback: meal totals from the last write's refreshed day (or one read if nothing was written)
      const day = ((last?.day as Rec | undefined) ?? (out.logged.length ? undefined : null)) as Rec | null | undefined;
      const diary = ((day ?? ((await toolbox.execute('fitness_get_day', date ? { date } : {}, { raw: true })) as Rec))?.diary ?? []) as { meal?: string; calories?: number }[];
      const meals = [...new Set(items.map((i) => i.meal))];
      out.meal_totals = meals.map((m) => {
        const e = diary.filter((x) => String(x.meal ?? '').toLowerCase() === m);
        return { meal: m, items: e.length, kcal: Math.round(e.reduce((a, x) => a + Number(x.calories ?? 0), 0)) };
      });
      out.note = out.ambiguous.length ? 'Ask the user to choose for the ambiguous items (show name, serving, kcal); nothing was logged for them.' : '';
      log(`[log_meal] logged ${out.logged.length}, ambiguous ${out.ambiguous.length}, confirm ${out.needs_confirmation.length}, failed ${out.failed.length}`);
      return Object.fromEntries(Object.entries(out).filter(([, v]) => (Array.isArray(v) ? v.length : v)));
    },
  });
}
