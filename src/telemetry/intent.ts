/** Coarse request intent, from keywords only (no model call). Also used by the tool router. */
export type Intent = 'meal' | 'mfp-other' | 'mfp-read' | 'expense' | 'finance-read' | 'plan' | 'mixed' | 'chat';
export type Media = 'text' | 'photo' | 'voice' | 'pdf';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

const MONEY = /(\$|\b\d+(?:[.,]\d+)?\s?(k|mil|millon(?:es)?|lucas?|pesos|cop|mxn|usd|eur)\b|\bgast|\bpague|\bpagu|\bcompr|\bcobr|transfer|\bpasa\b|\bpase\b|nequi|bancolombia|daviplata|\bnu\b|nu mexico|tarjeta|cuenta|saldo|balance|movimiento|ingres|salario|sueldo|me pagaron|plata|dinero|presupuesto|factura|recibo|\bspent\b|\bpaid\b|\bexpense|\bincome|\bsalary|\bbudget|\baccount|transaction)/;
const FINANCE_READ = /(cuanto (gaste|llevo gastado|tengo|me queda)|en que gaste|\bsaldo|\bbalance\b|resumen de gastos|how much (did i )?spen|how much do i have|mis gastos|ultimos (gastos|movimientos)|list(a|ar)? (de )?(gastos|movimientos))/;
const FOOD = /(comi\b|\bcomer\b|desayun|almorc|almuerz|\bcene\b|\bcena\b|merienda|snack|onces|\bkcal|calori|proteina|macro|huevo|tostad|\bpan\b|arepa|arroz|pollo|pechuga|carne|cafe|leche|fruta|banan|manzana|aguacate|lasan|pastel|ensalada|\bate\b|breakfast|lunch|dinner|\bmeal\b|\bfood\b|\begg|\btoast|myfitnesspal|\bmfp\b|\bpeso\b|\bpese\b|\bweigh|\bagua\b|\bwater\b|ejercicio|exercise|\bgym\b|diario|diary)/;
const FOOD_READ = /(que comi|cuantas calorias|calorias llevo|what did i eat|how many calories|mi diario|my diary)/;
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

export type Domain = 'fitness' | 'finance';
export const ALL_DOMAINS: readonly Domain[] = ['fitness', 'finance'];

/**
 * Which app tools a message needs. Keyword rules only. Unclear messages (greetings, short
 * replies like "sí" or "la segunda", media without a caption, voice notes) get every domain.
 */
export function domainsFor(text: string, media: Media = 'text'): Domain[] {
  const t = norm(text ?? '');
  if (media === 'voice' || (media !== 'text' && !t.trim())) return [...ALL_DOMAINS];
  const out: Domain[] = [];
  const money = MONEY.test(t);
  const food = FOOD.test(t);
  // a food word inside an expense ("gasté 25k en almuerzo") is still only finance
  const eats = /(comi\b|desayune|almorce|cene\b|registra.*(desayuno|almuerzo|cena)|\bate\b|\blog\b|onces|merienda)/.test(t);
  if (food && (!money || eats)) out.push('fitness');
  if (money) out.push('finance');
  return out.length ? out : [...ALL_DOMAINS];
}
