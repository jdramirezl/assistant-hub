/** Coarse request intent, from keywords only (no model call). Also used by the tool router. */
export type Intent = 'meal' | 'mfp-other' | 'mfp-read' | 'expense' | 'finance-read' | 'cines' | 'plan' | 'mixed' | 'chat';
export type Media = 'text' | 'photo' | 'voice' | 'pdf';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

const MONEY = /(\$|\b\d+(?:[.,]\d+)?\s?(k|mil|millon(?:es)?|lucas?|pesos|cop|mxn|usd|eur)\b|\bgast|\bpague|\bpagu|\bcompr|\bcobr|transfer|\bpasa\b|\bpase\b|nequi|bancolombia|daviplata|\bnu\b|nu mexico|tarjeta|cuenta|saldo|balance|movimiento|ingres|salario|sueldo|me pagaron|plata|dinero|presupuesto|factura|recibo|\bspent\b|\bpaid\b|\bexpense|\bincome|\bsalary|\bbudget|\baccount|transaction)/;
const FINANCE_READ = /(cuanto (gaste|llevo gastado|tengo|me queda)|en que gaste|\bsaldo|\bbalance\b|resumen de gastos|how much (did i )?spen|how much do i have|mis gastos|ultimos (gastos|movimientos)|list(a|ar)? (de )?(gastos|movimientos))/;
const FOOD = /(comi\b|\bcomer\b|desayun|almorc|almuerz|\bcene\b|\bcena\b|merienda|snack|onces|\bkcal|calori|proteina|macro|huevo|tostad|\bpan\b|arepa|arroz|pollo|pechuga|carne|cafe|leche|fruta|banan|manzana|aguacate|lasan|pastel|ensalada|\bate\b|breakfast|lunch|dinner|\bmeal\b|\bfood\b|\begg|\btoast|myfitnesspal|\bmfp\b|\bpeso\b|\bpese\b|\bweigh|\bagua\b|\bwater\b|ejercicio|exercise|\bgym\b|diario|diary)/;
const FOOD_READ = /(que comi|cuantas calorias|calorias llevo|what did i eat|how many calories|mi diario|my diary)/;
/** Cinema: listings, showtimes, seats, tickets (Cinépolis). "F7,F8" = seats. */
const CINES = /(pelicula|\bpeli\b|\bpelis\b|\bcine\b|\bcines\b|cinepolis|cartelera|\bfuncion|\bfunciones\b|boleto|\bentradas?\b|\bhorarios?\b|asiento|butaca|estreno|preventa|\bimax\b|\bvip\b|\b4dx\b|subtitulad|doblad|\btoreo\b|plaza carso|\bcarso\b|satelite|miyana|\bmovie|\bcinema\b|showtime|\bseats?\b|\btickets?\b|donde (pasan|dan|proyectan|ponen)|quiero ver (?!mis|mi |el saldo|cuanto|que|lo que|como)|vamos a ver|ir al cine|^\s*[a-n]\d{1,2}(\s*[,y ]\s*[a-n]?\d{1,2})*\s*$|\b[a-n]\d{1,2}\s*(,|y)\s*[a-n]?\d{1,2}\b|\b(compra|aparta|reserva|apartame|resérvame)\w*\b.{0,20}\b[a-n]\d{1,2}\b)/;
/** Money words that really mean the finance app (not "compra los boletos"). */
const FINANCE_WORDS = /(\bgast|\bpague|\bpagu|nequi|bancolombia|daviplata|\bnu\b|cuenta|saldo|transfer|ingres|salario|presupuesto|\bspent\b|\bpaid\b)/;
const DELETE_ALL = /(borra|elimina|quita|delete|remove|clear).{0,40}\b(todo|todos|todas|all|everything)\b/;

export function mediaOf(parts: { mediaType?: string; mimeType?: string }[] = []): Media {
  const types = parts.map((p) => p.mediaType ?? p.mimeType ?? '');
  if (types.some((t) => t.startsWith('audio/'))) return 'voice';
  if (types.some((t) => t.startsWith('image/'))) return 'photo';
  if (types.some((t) => t === 'application/pdf')) return 'pdf';
  return 'text';
}

export function classifyIntent(text: string, media: Media = 'text'): Intent {
  const t = norm(text ?? '');
  const money = MONEY.test(t);
  const food = FOOD.test(t);
  if (DELETE_ALL.test(t)) return 'plan';
  if (CINES.test(t) && !FINANCE_WORDS.test(t) && !(food && !money)) return 'cines';
  if (media !== 'text' && !t.trim()) return 'mixed'; // a photo/voice note with no caption: unknown domain
  if (money && food) {
    // "gasté 25k en almuerzo": a food word inside an expense is still an expense
    const eats = /(comi\b|desayune|almorce|cene\b|registra.*(desayuno|almuerzo|cena)|\bate\b|\blog\b)/.test(t);
    return eats ? 'mixed' : FINANCE_READ.test(t) ? 'finance-read' : 'expense';
  }
  if (money) return FINANCE_READ.test(t) ? 'finance-read' : 'expense';
  if (food) {
    if (FOOD_READ.test(t)) return 'mfp-read';
    if (/(borra|elimina|quita|cambia|corrige|delete|remove|\bpeso\b|\bpese\b|weigh|\bagua\b|water|ejercicio|exercise)/.test(t)) return 'mfp-other';
    return 'meal';
  }
  if (media === 'voice' || media === 'photo' || media === 'pdf') return 'mixed';
  return 'chat';
}

export type Domain = 'fitness' | 'finance' | 'cines';
/** Every domain, in prompt order (new domains go LAST so earlier prefixes stay byte-identical). */
export const ALL_DOMAINS: readonly Domain[] = ['fitness', 'finance', 'cines'];
/** What an unclear message gets: cines only when the conversation was just about it (sticky). */
export const DEFAULT_DOMAINS: readonly Domain[] = ['fitness', 'finance'];

/** Is this text about the cinema? */
export const isCines = (text: string) => CINES.test(norm(text ?? ''));

/**
 * Which app tools a message needs. Keyword rules only. Unclear messages (greetings, short
 * replies like "sí" or "la segunda", media without a caption, voice notes) get every domain.
 */
export function domainsFor(text: string, media: Media = 'text', recent?: readonly Domain[]): Domain[] {
  const t = norm(text ?? '');
  const unclear = () => [...DEFAULT_DOMAINS, ...(recent?.includes('cines') ? (['cines'] as const) : [])];
  if (media === 'voice' || (media !== 'text' && !t.trim())) return unclear();
  const out: Domain[] = [];
  const money = MONEY.test(t);
  const food = FOOD.test(t);
  if (CINES.test(t)) out.push('cines');
  // a food word inside an expense ("gasté 25k en almuerzo") is still only finance
  const eats = /(comi\b|desayune|almorce|cene\b|registra.*(desayuno|almuerzo|cena)|\bate\b|\blog\b|onces|merienda)/.test(t);
  if (food && (!money || eats)) out.push('fitness');
  // "compra 2 boletos" is a cines purchase, not a finance movement (unless finance words are there)
  if (money && !(out.includes('cines') && !FINANCE_WORDS.test(t))) out.push('finance');
  return out.length ? out : unclear();
}
