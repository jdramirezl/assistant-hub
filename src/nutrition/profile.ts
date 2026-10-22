/**
 * The owner's nutrition profile: day targets, a small food dictionary, saved recipes and long
 * context sections. It is PRIVATE health data: it lives outside git (NUTRITION_PROFILE_PATH,
 * mode 0600) and its contents are never logged — only counts. The repo has the schema and a
 * generic example (docs/nutrition-profile.example.json).
 */
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';

export type DayType = 'rest' | 'gimnasia' | 'pesas';
export const DAY_TYPES: readonly DayType[] = ['rest', 'gimnasia', 'pesas'];

/** The KvStore subset the nutrition module uses (tests pass an in-memory one). */
export interface NutritionKv {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
}

const Range = z.tuple([z.number().nonnegative(), z.number().nonnegative()]);
const DayTypeSchema = z.enum(['rest', 'gimnasia', 'pesas']);

export const FoodSchema = z.object({
  /** How Alfred names it to the user (Spanish is fine). */
  name: z.string().min(1),
  /** Words the user or the model may use (Spanish and English). */
  aliases: z.array(z.string().min(1)).default([]),
  /** The MyFitnessPal search for it (brand + name when it matters: "Fini chicle sandia"). */
  query: z.string().min(1),
  /** The user's unit for one of it: unit, spray, scoop, pack, g… */
  unit: z.string().min(1),
  /** What one user unit is in MFP terms (an arepa = 40 g of dry Harina PAN). */
  per_unit: z.object({ quantity: z.number().positive(), unit: z.string().min(1) }).optional(),
  /** MFP grams per user gram (120 g of arepa masa = 40 g of flour → 0.3333). */
  per_gram: z.number().positive().optional(),
  /** kcal per user unit. */
  kcal: z.number().nonnegative(),
  protein: z.number().nonnegative().optional(),
  /** Quantity when the user gives none (spray: 5 pumps). */
  default_quantity: z.number().positive().optional(),
  /** Any other unit the user says means default_quantity of this unit (spray: "1 tbsp" → 5 pumps). */
  only_unit: z.boolean().optional(),
  /** Usually cooked with spray (eggs, arepa): a meal with it gets the spray if none was logged. */
  spray: z.boolean().optional(),
  /** A drink (the implied 0-kcal drink is skipped when a meal has one). */
  drink: z.boolean().optional(),
});
export type Food = z.infer<typeof FoodSchema>;

export const RecipeItemSchema = z.object({
  query: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().min(1),
  kcal: z.number().nonnegative(),
  protein: z.number().nonnegative().optional(),
});
export type RecipeItem = z.infer<typeof RecipeItemSchema>;

export const RecipeSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  /** What ONE portion is ("1 plato (470 g)", "1 caja", "1 burrito"). */
  portion: z.string().optional(),
  /** Ingredients of ONE portion (each logged as its own MFP entry). */
  items: z.array(RecipeItemSchema).min(1),
});
export type Recipe = z.infer<typeof RecipeSchema>;

export const ProfileSchema = z.object({
  version: z.literal(1),
  targets: z.object({
    rest: z.object({ kcal: Range }),
    gimnasia: z.object({ kcal: Range }),
    pesas: z.object({ kcal: Range }),
    protein: Range,
  }),
  /** The usual week, as a HINT only (Alfred asks when unsure). */
  schedule: z.partialRecord(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), DayTypeSchema).optional(),
  defaults: z
    .object({
      /** Implied 0-kcal drink when a meal names none: food names from `foods`. */
      drinks: z.object({ breakfast: z.string().optional(), other: z.string().optional() }).optional(),
      /** Implied spray for cooked foods: a food name from `foods`. */
      spray: z.string().optional(),
    })
    .default({}),
  foods: z.array(FoodSchema).default([]),
  recipes: z.array(RecipeSchema).default([]),
  /** Long context, by section; loaded only for planning/advice questions and the digest. */
  context: z.record(z.string(), z.string()).default({}),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** Validate; the error names the bad fields only (never the values: they are health data). */
export function parseProfile(raw: unknown): Profile {
  const r = ProfileSchema.safeParse(raw);
  if (!r.success) throw new Error(`invalid nutrition profile: ${r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'} (${i.code})`).join(', ')}`);
  return r.data;
}

/** The profile at `path`, or undefined (missing/invalid → nutrition features off, logged once). */
export function loadProfile(path: string | undefined, log: (m: string) => void = () => {}): Profile | undefined {
  if (!path) return undefined;
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) log(`[nutrition] warning: the profile file is readable by others (mode ${mode.toString(8)}); chmod 600 it`);
    const p = parseProfile(JSON.parse(readFileSync(path, 'utf8')));
    log(`[nutrition] profile loaded: ${p.foods.length} foods, ${p.recipes.length} recipes, ${Object.keys(p.context).length} context sections`);
    return p;
  } catch (e) {
    const msg = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : e instanceof SyntaxError ? 'not valid JSON' : (e as Error).message;
    log(`[nutrition] profile not loaded (${msg}); nutrition features off`);
    return undefined;
  }
}
