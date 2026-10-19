/**
 * Standard portions for common foods, so log_meal does not ask about "arroz" or "un plato de
 * arroz" when the serving is clear. Used only when the user's unit matches none of MFP's
 * servings (or is generic): the item is retried with the standard unit. The 2× estimate check
 * and the 800 kcal guard still apply to the result.
 */
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim();

/** Spanish / informal units → the English unit MFP servings use. */
const UNIT_ALIASES: Record<string, string> = {
  taza: 'cup', tazas: 'cup', vaso: 'cup', vasos: 'cup', pocillo: 'cup', mug: 'cup', glass: 'cup',
  cucharada: 'tbsp', cucharadas: 'tbsp', tablespoon: 'tbsp', cucharadita: 'tsp', cucharaditas: 'tsp', teaspoon: 'tsp',
  rebanada: 'slice', rebanadas: 'slice', tajada: 'slice', tajadas: 'slice', rodaja: 'slice',
  unidad: 'unit', unidades: 'unit', pieza: 'unit', piezas: 'unit', each: 'unit',
  plato: 'plate', platos: 'plate', porcion: 'portion', porciones: 'portion', racion: 'portion', tazon: 'bowl', bol: 'bowl',
  gramos: 'g', gramo: 'g', grams: 'g', mililitros: 'ml',
};

export function normalizeUnit(unit: string): string {
  const u = norm(unit);
  return UNIT_ALIASES[u] ?? u;
}

/** A portion: quantity of a standard unit per one of the user's unit. */
type Portion = [quantity: number, unit: string];
interface Common {
  match: RegExp;
  /** Standard portion when the unit is generic, unknown or missing. */
  standard: Portion;
  /** Portions for specific vague units (plate, bowl…). */
  by?: Record<string, Portion>;
}

/** Keyed by the ENGLISH query log_meal gets. Conservative: only foods with one obvious portion. */
const COMMON: Common[] = [
  { match: /\b(rice|arroz)\b/, standard: [1, 'cup'], by: { plate: [1.5, 'cup'], bowl: [1.5, 'cup'] } },
  { match: /\b(beans|frijoles|lentils|lentejas)\b/, standard: [1, 'cup'] },
  { match: /\b(pasta|spaghetti|noodles)\b/, standard: [1, 'cup'], by: { plate: [2, 'cup'], bowl: [2, 'cup'] } },
  { match: /\b(oatmeal|oats?|avena)\b/, standard: [1, 'cup'] },
  { match: /\b(soup|sopa)\b/, standard: [1, 'cup'], by: { plate: [1.5, 'cup'], bowl: [1.5, 'cup'] } },
  { match: /\b(salad|ensalada)\b/, standard: [1, 'cup'], by: { plate: [2, 'cup'], bowl: [2, 'cup'] } },
  { match: /\b(milk|leche|juice|jugo|coffee|cafe|tea|te)\b/, standard: [1, 'cup'] },
  { match: /\b(chicken breast|chicken|pechuga|pollo)\b/, standard: [1, 'breast'] },
  { match: /\b(eggs?|huevos?)\b/, standard: [1, 'unit'] },
  { match: /\b(bread|toast|pan|tostadas?)\b/, standard: [1, 'slice'] },
  { match: /\b(arepas?|bananas?|banano|apples?|manzanas?|oranges?|naranjas?|potato(es)?|papas?)\b/, standard: [1, 'unit'] },
];

const VAGUE = new Set(['', 'serving', 'portion', 'plate', 'bowl', 'helping', 'some', 'un poco', 'unit']);

/**
 * The standard-portion version of an item, or undefined if the food isn't common or the unit
 * is a real measure we must not reinterpret (g, ml, cup…). `unit` is already normalized.
 */
export function standardPortion(query: string, quantity: number, unit: string): { quantity: number; unit: string; specific: boolean } | undefined {
  const q = norm(query);
  const c = COMMON.find((x) => x.match.test(q));
  if (!c) return undefined;
  const u = normalizeUnit(unit);
  const specific = c.by?.[u];
  const p = specific ?? (VAGUE.has(u) ? c.standard : undefined);
  if (!p) return undefined;
  if (p[1] === u) return undefined; // nothing new to try
  // specific: this food's own size for that unit (a plate of rice = 1.5 cups), tried FIRST
  return { quantity: Math.round(quantity * p[0] * 1000) / 1000, unit: p[1], specific: !!specific };
}
