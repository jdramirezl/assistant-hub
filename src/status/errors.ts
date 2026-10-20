/**
 * Error translation table: every known error code → a sentence for the user (what happened)
 * and an action (what they can do), in Spanish and English. Never a bare "falló". Unknown codes
 * fall back to a generic sentence that still names the code.
 */
export type Lang = 'es' | 'en';
export interface Explained {
  code: string;
  cause: string;
  action: string;
}
type Entry = { es: [cause: string, action: string]; en: [cause: string, action: string] };

/** Code → [cause, action]. `{app}` is replaced by the app's display name. */
export const ERROR_TABLE: Record<string, Entry> = {
  VALIDATION_ERROR: { es: ['faltó o no cuadró un dato', 'Dígame el dato que falta y lo registro.'], en: ['a detail was missing or invalid', 'Tell me the missing detail and I will record it.'] },
  BAD_ARGS: { es: ['faltó o no cuadró un dato', 'Repítamelo con más detalle.'], en: ['a detail was missing or invalid', 'Say it again with a bit more detail.'] },
  NOT_FOUND: { es: ['no encontré ese registro', 'Revise el nombre o dígame cuál es.'], en: ['I could not find that item', 'Check the name or tell me which one.'] },
  UNAUTHORIZED: { es: ['{app} rechazó la credencial del hub', 'Hay que renovar el token en el servidor; no es algo que usted pueda arreglar desde aquí.'], en: ['{app} rejected the hub\'s credentials', 'The token on the server needs renewing.'] },
  FORBIDDEN: { es: ['{app} no permite esa acción', 'Hágalo desde la app directamente.'], en: ['{app} does not allow that action', 'Do it in the app directly.'] },
  CONFLICT: { es: ['{app} ya tenía un cambio en curso', 'Inténtelo de nuevo en un momento.'], en: ['{app} had a conflicting change', 'Try again in a moment.'] },
  RATE_LIMITED: { es: ['{app} pidió bajar el ritmo', 'Inténtelo de nuevo en un minuto.'], en: ['{app} asked us to slow down', 'Try again in a minute.'] },
  TOOL_UNAVAILABLE: { es: ['{app} no está conectada ahora', 'La reintento sola; vuelva a pedírmelo en unos minutos.'], en: ['{app} is not connected right now', 'I keep retrying; ask again in a few minutes.'] },
  MCP_UNAVAILABLE: { es: ['{app} no responde', 'La reintento sola cada minuto; vuelva a pedírmelo en unos minutos.'], en: ['{app} is not responding', 'I retry every minute; ask again in a few minutes.'] },
  SESSION_LOST: { es: ['{app} se reinició a mitad de la operación', 'Vuelva a enviarlo; ya me reconecté.'], en: ['{app} restarted mid-operation', 'Send it again; I have reconnected.'] },
  TOOL_ERROR: { es: ['{app} devolvió un error inesperado', 'Inténtelo de nuevo; si se repite, avíseme con el código de abajo.'], en: ['{app} returned an unexpected error', 'Try again; if it repeats, tell me the code below.'] },
  INTERNAL_ERROR: { es: ['{app} tuvo un error interno', 'Inténtelo de nuevo en un momento.'], en: ['{app} had an internal error', 'Try again in a moment.'] },
  PLAN_INCOMPLETE: { es: ['el plan no incluía todo', 'Lo estoy rehaciendo; espere el plan corregido.'], en: ['the plan was incomplete', 'I am redoing it; wait for the revised plan.'] },
  // MyFitnessPal (Mason)
  MFP_UNAVAILABLE: { es: ['MyFitnessPal no responde', 'Lo reintento solo; vuelva a enviarlo en unos minutos.'], en: ['MyFitnessPal is not responding', 'I keep retrying; send it again in a few minutes.'] },
  MFP_SESSION_EXPIRED: { es: ['la sesión de MyFitnessPal expiró', 'Hay que correr `mfp-mcp auth` en el Mac servidor.'], en: ['the MyFitnessPal session expired', 'Run `mfp-mcp auth` on the server Mac.'] },
  MFP_BLOCKED: { es: ['MyFitnessPal bloqueó la conexión (Cloudflare)', 'Esperemos un rato antes de reintentar.'], en: ['MyFitnessPal blocked the connection (Cloudflare)', 'Let us wait a while before retrying.'] },
  MFP_BAD_REQUEST: { es: ['MyFitnessPal no aceptó ese alimento o porción', 'Dígame el alimento de otra forma (nombre y porción).'], en: ['MyFitnessPal did not accept that food or serving', 'Describe the food differently (name and serving).'] },
  MFP_NOT_FOUND: { es: ['no encontré esa entrada en el diario', 'Dígame cuál, con el nombre que aparece en MyFitnessPal.'], en: ['I could not find that entry in the diary', 'Tell me which one, with its name in MyFitnessPal.'] },
  MFP_AMBIGUOUS: { es: ['varias entradas coinciden', 'Dígame cuál (nombre exacto o comida).'], en: ['several entries match', 'Tell me which one (exact name or meal).'] },
  MFP_ERROR: { es: ['MyFitnessPal devolvió un error', 'Inténtelo de nuevo; si se repite, avíseme con el código.'], en: ['MyFitnessPal returned an error', 'Try again; if it repeats, tell me the code.'] },
  // Cinépolis (cines-mx-mcp)
  CINES_UNAVAILABLE: { es: ['Cinépolis no responde', 'Inténtelo de nuevo en un minuto.'], en: ['Cinépolis is not responding', 'Try again in a minute.'] },
  CINES_BLOCKED: { es: ['Cinépolis bloqueó esta conexión (Cloudflare)', 'Esperemos un rato; desde otra red suele funcionar.'], en: ['Cinépolis blocked this connection (Cloudflare)', 'Let us wait; another network usually works.'] },
  CINES_SCHEMA_CHANGED: { es: ['Cinépolis cambió su sitio', 'Hay que actualizar cines-mx-mcp; no lo reintento.'], en: ['Cinépolis changed its site', 'cines-mx-mcp needs an update; I will not retry.'] },
  CINES_NOT_FOUND: { es: ['no encontré esa película, cine o función', 'Revise el nombre o elija otra función.'], en: ['I could not find that movie, cinema or showtime', 'Check the name or pick another showtime.'] },
  CINES_BAD_REQUEST: { es: ['Cinépolis no aceptó esos datos', 'Revise los asientos o la función.'], en: ['Cinépolis did not accept those details', 'Check the seats or the showtime.'] },
  CINES_SESSION_EXPIRED: { es: ['la sesión de Cinépolis expiró', 'Hay que volver a iniciar sesión en el Mac servidor.'], en: ['the Cinépolis session expired', 'Log in again on the server Mac.'] },
  CINES_HOLD_EXPIRED: { es: ['los asientos ya no están apartados', 'Elijamos asientos de nuevo.'], en: ['the seats are no longer held', 'Let us choose seats again.'] },
  CINES_PAYMENT_FAILED: { es: ['el pago no se completó (no lo reintento)', 'Revise su correo y su banco antes de intentar otra compra.'], en: ['the payment did not go through (not retried)', 'Check your e-mail and bank before trying again.'] },
  CINES_PAYMENT_NOT_ARMED: { es: ['el pago real no está armado', 'En el Mac corra: bin/cinesctl arm-payment'], en: ['real payment is not armed', 'On the Mac run: bin/cinesctl arm-payment'] },
  CINES_PAYMENT_UNKNOWN: { es: ['no sé si se cobró', 'Revise su correo. No liberé los asientos.'], en: ['I do not know whether it was charged', 'Check your e-mail. I did not release the seats.'] },
  CINES_LIMIT_EXCEEDED: { es: ['el total supera el límite de $1,000 MXN', 'Elija menos asientos o una sala más barata.'], en: ['the total is over the $1,000 MXN limit', 'Pick fewer seats or a cheaper room.'] },
  // Hub-level
  BUDGET: { es: ['llegamos al tope diario del modelo', 'Vuelvo a medianoche (Bogotá).'], en: ['the daily model budget is used up', 'I will be back after midnight (Bogotá).'] },
  GEMINI_DAILY_QUOTA: { es: ['se agotó la cuota diaria de Gemini', 'Vuelvo a responder mañana.'], en: ['Gemini\'s daily quota is used up', 'I will answer again tomorrow.'] },
  GEMINI_RATE_LIMIT: { es: ['Gemini pidió una pausa más larga de lo normal', 'Vuelva a enviarlo en un minuto.'], en: ['Gemini asked for a longer pause than usual', 'Send it again in a minute.'] },
  GEMINI_ERROR: { es: ['el modelo devolvió un error', 'Vuelva a enviarlo; si se repite, avíseme con el código.'], en: ['the model returned an error', 'Send it again; if it repeats, tell me the code.'] },
  TRANSCRIPTION_FAILED: { es: ['no pude transcribir la nota de voz', 'Envíela de nuevo o escríbamelo.'], en: ['I could not transcribe the voice note', 'Send it again or type it.'] },
};

/** Fields named in a validation message → a specific cause and question. */
const FIELDS: { re: RegExp; es: [string, string]; en: [string, string] }[] = [
  { re: /insufficient|balance|saldo|fondos/i, es: ['no hay saldo suficiente en ese bolsillo', '¿Lo cargo a otra cuenta o bolsillo?'], en: ['there is not enough balance in that pocket', 'Shall I charge it to another account or pocket?'] },
  { re: /accountId|pocketId|account|cuenta/i, es: ['falta la cuenta', '¿Con cuál la pagó?'], en: ['the account is missing', 'Which account did you use?'] },
  { re: /amount|monto/i, es: ['falta el monto', '¿Cuánto fue?'], en: ['the amount is missing', 'How much was it?'] },
  { re: /date|fecha/i, es: ['la fecha no es válida', '¿Qué día fue?'], en: ['the date is invalid', 'Which day was it?'] },
  { re: /kcal|calor/i, es: ['faltan las calorías', '¿Cuántas calorías tenía, más o menos?'], en: ['the calories are missing', 'Roughly how many calories?'] },
  { re: /quantity|serving|porci/i, es: ['falta la porción', '¿Cuánto comió?'], en: ['the serving is missing', 'How much did you have?'] },
];

export const APP_NAMES: Record<string, { es: string; en: string }> = {
  finance: { es: 'Finanzas', en: 'Finance' },
  mfp: { es: 'MyFitnessPal', en: 'MyFitnessPal' },
  fitness: { es: 'MyFitnessPal', en: 'MyFitnessPal' },
  cines: { es: 'Cinépolis', en: 'Cinépolis' },
  echo: { es: 'echo', en: 'echo' },
};
export const appName = (server: string, lang: Lang) => APP_NAMES[server]?.[lang] ?? server;
/** The app of a tool name (finance_*, fitness_*, cines_*). */
export const appOfTool = (tool: string) => (tool === 'log_meal' ? 'mfp' : tool.split('_')[0] === 'fitness' ? 'mfp' : tool.split('_')[0]!);

/** Shared-shape error (or Mastra's {error:true, message} validation error) → code + message. */
export function errorOf(result: unknown): { code: string; message: string } | undefined {
  if (!result || typeof result !== 'object' || !('error' in result)) return undefined;
  const e = (result as { error: unknown; message?: unknown }).error;
  if (e === true) return { code: 'VALIDATION_ERROR', message: String((result as { message?: unknown }).message ?? '') };
  if (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') return { code: (e as { code: string }).code, message: String((e as { message?: unknown }).message ?? '') };
  return undefined;
}

/** Translate a code (+ message, for field-specific validation) for the user. */
export function explain(code: string, message = '', lang: Lang = 'es', app = ''): Explained {
  const entry = ERROR_TABLE[code];
  if ((code === 'VALIDATION_ERROR' || code === 'BAD_ARGS' || code === 'MFP_BAD_REQUEST') && message) {
    const why = message.split(/Provided arguments/i)[0]!; // not the echoed arguments
    const f = FIELDS.find((x) => x.re.test(why));
    if (f) return { code, cause: f[lang][0], action: f[lang][1] };
  }
  const fill = (s: string) => s.replace('{app}', app || (lang === 'es' ? 'la app' : 'the app'));
  if (entry) return { code, cause: fill(entry[lang][0]), action: fill(entry[lang][1]) };
  return lang === 'es'
    ? { code, cause: `${app || 'la app'} devolvió un error (${code})`, action: 'Inténtelo de nuevo; si se repite, avíseme con el código.' }
    : { code, cause: `${app || 'the app'} returned an error (${code})`, action: 'Try again; if it repeats, tell me the code.' };
}

/** Candidate entries listed in an "ambiguous match" error ("…: A (Breakfast), B (Lunch); narrow…"). */
export function candidatesOf(message: string): string[] {
  const m = message.match(/(?:entries|entry|candidates|matches|logged)[^:]*:\s*([^;"]+?)(?:;|"|$)/i);
  if (!m) return [];
  const list = m[1]!.trim();
  // names contain commas ("Egg, whole, large"): split on "Name (Meal)" items when present
  const withMeal = [...list.matchAll(/\s*([^()]+?\s*\([^)]+\))\s*(?:,|$)/g)].map((x) => x[1]!.trim());
  const items = withMeal.length ? withMeal : list.split(/\s*,\s*/);
  return items.filter((x) => x && x.length < 80).slice(0, 6);
}

/** A model/run error (Gemini, transport) → code. */
export function codeOfModelError(err: unknown): string {
  const e = err as { statusCode?: number; message?: string; cause?: { statusCode?: number } };
  const status = e?.statusCode ?? e?.cause?.statusCode;
  const msg = String(e?.message ?? err);
  if (/budget/i.test(msg) && /paused|cap|hit/i.test(msg)) return 'BUDGET';
  if (status === 429 || /RESOURCE_EXHAUSTED|exceeded your current quota|\b429\b/i.test(msg)) return /PerDay/i.test(msg) ? 'GEMINI_DAILY_QUOTA' : 'GEMINI_RATE_LIMIT';
  if (/session not found|-32600/i.test(msg)) return 'SESSION_LOST';
  return 'GEMINI_ERROR';
}
