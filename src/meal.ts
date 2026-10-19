/** MFP meal slots (lowercase, as log_meal takes them). */
export type Meal = 'breakfast' | 'lunch' | 'dinner' | 'snacks';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

/** Spoken/written meal words → slot. Order matters only for readability; all are checked. */
const WORDS: [Meal, RegExp][] = [
  ['breakfast', /\b(desayun\w*|breakfast)\b/],
  ['lunch', /\b(almuerz\w*|almorz\w*|almorc\w*|lunch|comida)\b/],
  ['dinner', /\b(cena|cenas|cene|cenamos|cenaste|cenando|cenar|anoche|dinner|supper)\b/],
  ['snacks', /\b(snacks?|merienda\w*|meriend\w*|onces|tentempie|refrigerio|mecato)\b/],
];

/**
 * The meal the user named in the message, if exactly one is named ("cené arroz" → dinner).
 * Two different meal words ("desayuné huevos y almorcé arroz") → undefined: the model decides
 * per item.
 */
export function mealFromText(text: string): Meal | undefined {
  const found = mealsIn(text);
  return found.length === 1 ? found[0] : undefined;
}

/** Every distinct meal named in the text. */
export function mealsIn(text: string): Meal[] {
  const t = norm(text ?? '');
  return WORDS.filter(([, re]) => re.test(t)).map(([m]) => m);
}

/** Meal by local hour, when no meal word was said. */
export function mealForHour(hour: number): Meal {
  if (hour >= 4 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 16) return 'lunch';
  if (hour >= 18 && hour < 24) return 'dinner';
  return 'snacks';
}

/** Local hour (0–23) in `timezone` at `at`. */
export function localHour(timezone: string, at: number): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(at)) % 24;
}

/** Display name of a language code for the prompt ("es" → "Spanish"). */
export function languageName(code: string | undefined): string | undefined {
  const c = (code ?? '').toLowerCase().slice(0, 2);
  return ({ es: 'Spanish', en: 'English', pt: 'Portuguese', fr: 'French' } as Record<string, string>)[c];
}

/** Words that move the request off "now", so the hour says nothing about the meal. */
const OTHER_TIME = /\b(ayer|antier|anteayer|anoche|manana|yesterday|tomorrow|last|el (lunes|martes|miercoles|jueves|viernes|sabado|domingo)|hace \d+)\b/;

/** The message itself reports eating something. */
const EATING = /\b(comi|me comi|tome|me tome|bebi|me bebi|ate|had|i've had|drank|registra|anota|log)\b/;

/**
 * The meal log_meal must use for this request, decided in code: the meal word the user said,
 * else (a plain "comí X" about now, for today) the local hour. undefined = keep the model's.
 */
export function mealHint(text: string | undefined, opts: { date?: string; timezone: string; now: number }): Meal | undefined {
  if (!text) return undefined;
  const named = mealsIn(text);
  if (named.length) return named.length === 1 ? named[0] : undefined;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: opts.timezone }).format(opts.now);
  if ((opts.date && opts.date !== today) || OTHER_TIME.test(norm(text))) return undefined;
  if (!EATING.test(norm(text))) return undefined; // a follow-up ("sí", "la segunda", "eran 2") keeps the model's meal
  return mealForHour(localHour(opts.timezone, opts.now));
}
