import type { ServerStatus } from './mcp/toolbox.js';

export type PersonaName = 'alfred' | 'plain';
export type Language = 'es' | 'en';

export interface PersonaConfig {
  persona: PersonaName;
  /** Language for proactive notices (startup ping, digest, …); replies follow the user. */
  language: Language;
  /** The owner's first name as written in Spanish (accents kept); English drops them. */
  ownerName: string;
}

const stripAccents = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '');

/** "Master Julian" in every language (the owner prefers the English form, also in Spanish replies). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function addressOf(p: PersonaConfig, _lang: Language = p.language): string {
  return `Master ${stripAccents(p.ownerName)}`;
}

/** System-prompt section for the persona; '' when switched off (HUB_PERSONA=plain). */
export function personaPrompt(p: PersonaConfig): string {
  if (p.persona !== 'alfred') return '';
  return [
    '## Persona',
    'You are Alfred Pennyworth, the user\'s butler: formal, loyal, with a dry British wit.',
    `Address the user as "${addressOf(p)}" in every language, including Spanish replies (never "Amo" or "Amo Julián", even if older messages in the chat used it). Reply in the user's language.`,
    'Brevity first: at most one short, elegant line of personality, then the facts.',
    'Plans, amounts, calories, approval requests and errors stay plain and scannable; the persona never obscures a number.',
  ].join('\n');
}

type Apps = Record<string, ServerStatus>;

export interface Voice {
  startup(host: string, apps: Apps): string;
  back(app: string, minutes: number): string;
  /** A real 429 from Gemini: we wait and retry. */
  rateLimit(seconds: number): string;
  /** The hub is pacing its own calls (not an error). */
  waiting(seconds: number): string;
  /** A voice note arrived; transcription + answer can take a few seconds. */
  voiceAck(): string;
  rateLimitGiveUp(daily: boolean): string;
  digestEmpty(period: string): string;
  planEdit(): string;
  /** "🔒 Send the CVV…": the prompt for a secure input (the model never sees the reply). */
  securePrompt(kind: string, details?: { last4?: string; total?: string }): string;
  secureBadFormat(kind: string): string;
  secureExpired(): string;
}

const SECRET_NAMES: Record<string, { es: string; en: string }> = {
  cvv: { es: 'el CVV de su tarjeta', en: 'your card\'s CVV' },
  otp_3ds: { es: 'el código que le envió su banco', en: 'the code your bank sent you' },
  email_code: { es: 'el código de 6 dígitos que Cinépolis envió a su correo', en: 'the 6-digit code Cinépolis e-mailed you' },
  arm_pin: { es: 'su PIN de compras', en: 'your purchase PIN' },
};
const FORMATS: Record<string, { es: string; en: string }> = {
  email_code: { es: '6 dígitos', en: '6 digits' },
  cvv: { es: '3 o 4 dígitos', en: '3 or 4 digits' },
  otp_3ds: { es: '4 a 10 letras o números', en: '4 to 10 letters or digits' },
  arm_pin: { es: '6 a 8 dígitos', en: '6 to 8 digits' },
};
const formatOf = (kind: string, lang: 'es' | 'en') => FORMATS[kind]?.[lang] ?? '';
/** "el CVV de su tarjeta *1234 ($99 MXN)": the card and total the server named in its prompt. */
const secretName = (kind: string, lang: 'es' | 'en', d: { last4?: string; total?: string } = {}) => {
  const base = SECRET_NAMES[kind]?.[lang] ?? (lang === 'es' ? 'el código' : 'the code');
  const card = kind === 'cvv' && d.last4 ? ` *${d.last4}` : '';
  const total = (kind === 'cvv' || kind === 'arm_pin') && d.total ? ` ($${d.total} MXN)` : '';
  return `${base}${card}${total}`;
};

function appLines(apps: Apps, lang: Language): string[] {
  const up = Object.entries(apps).filter(([, s]) => s.state === 'up').map(([n]) => n);
  const down = Object.entries(apps).filter(([, s]) => s.state === 'down').map(([n]) => n);
  const lines = [up.length ? `Apps: ${up.join(', ')}` : lang === 'es' ? 'Ninguna app conectada aún.' : 'No apps connected yet.'];
  if (down.length) lines.push(`⚠️ ${lang === 'es' ? 'No disponibles' : 'Unavailable'}: ${down.join(', ')} (down)`);
  return lines;
}

/** Proactive notices in the configured persona and language. */
export function createVoice(p: PersonaConfig): Voice {
  const lang = p.language;
  const plain = p.persona !== 'alfred';
  const who = addressOf(p);
  if (plain) {
    return {
      startup: (host, apps) => [`✅ I'm up on ${host}.`, ...appLines(apps, 'en')].join('\n'),
      back: (app, min) => `✅ ${app} is back (it was unreachable for ${min} min).`,
      rateLimit: (s) => `⏳ Gemini rate limit, retrying in ${s}s`,
      waiting: () => '⏳ One moment, processing your message…',
      voiceAck: () => '🎙️ Got it, processing your voice note…',
      rateLimitGiveUp: (daily) =>
        daily
          ? '⏳ Gemini daily free-tier limit reached; I will be able to answer again tomorrow.'
          : '⏳ Gemini rate limit; give me a minute and send it again.',
      digestEmpty: (period) => `🗓️ Weekly digest (${period}): no apps reported data yet. Connect finance or fitness to get a real summary.`,
      planEdit: () => '✏️ What should I change? Reply in text and I will send a revised plan.',
      securePrompt: (k, d) => `🔒 Send ${secretName(k, 'en', d)} in your next message. The model will not see it; I delete the message after reading it. (5 min; "cancel" to stop)`,
      secureBadFormat: (k) => `⚠️ That doesn't look right (${formatOf(k, 'en')}). Send it again, or "cancel".`,
      secureExpired: () => '⌛ That request expired, so I did not use your message (it was deleted).',
    };
  }
  if (lang === 'es') {
    return {
      startup: (host, apps) => [`✅ A su servicio, ${who}. En línea en ${host}.`, ...appLines(apps, 'es')].join('\n'),
      back: (app, min) => `✅ ${app} ha vuelto, ${who} (estuvo fuera ${min} min).`,
      rateLimit: (s) => `⏳ Límite de Gemini, ${who}. Reintento en ${s} s.`,
      waiting: () => `⏳ Un momento, ${who}, estoy procesando su mensaje…`,
      voiceAck: () => `🎙️ Recibido, ${who}. Estoy procesando su nota de voz…`,
      rateLimitGiveUp: (daily) =>
        daily
          ? `⏳ Me temo que agotamos el cupo diario gratuito de Gemini, ${who}. Volveré a responder mañana.`
          : `⏳ Gemini nos pide paciencia, ${who}. Inténtelo de nuevo en un minuto.`,
      digestEmpty: (period) => `🗓️ Resumen semanal (${period}), ${who}: ninguna app ha reportado datos aún.`,
      planEdit: () => `✏️ ¿Qué cambio, ${who}? Respóndame por escrito y le enviaré el plan corregido.`,
      securePrompt: (k, d) => `🔒 Envíe ${secretName(k, 'es', d)}, ${who}. No lo verá el modelo y borraré su mensaje en cuanto lo lea. (5 min; "cancelar" para detener)`,
      secureBadFormat: (k) => `⚠️ Eso no parece correcto, ${who} (${formatOf(k, 'es')}). Envíelo de nuevo, o "cancelar".`,
      secureExpired: () => `⌛ La solicitud expiró, ${who}; no usé su mensaje (lo borré).`,
    };
  }
  return {
    startup: (host, apps) => [`✅ At your service, ${who}. Online on ${host}.`, ...appLines(apps, 'en')].join('\n'),
    back: (app, min) => `✅ ${app} has returned, ${who} (it was away for ${min} min).`,
    rateLimit: (s) => `⏳ Gemini's rate limit, ${who}. Retrying in ${s} s.`,
    waiting: () => `⏳ One moment, ${who}, I am processing your message…`,
    voiceAck: () => `🎙️ Received, ${who}. Processing your voice note…`,
    rateLimitGiveUp: (daily) =>
      daily
        ? `⏳ I'm afraid we've used up Gemini's free daily quota, ${who}. I shall answer again tomorrow.`
        : `⏳ Gemini asks for patience, ${who}. Do try again in a minute.`,
    digestEmpty: (period) => `🗓️ Weekly digest (${period}), ${who}: no app has reported data yet.`,
    planEdit: () => `✏️ What shall I change, ${who}? Reply in text and I'll send a revised plan.`,
    securePrompt: (k, d) => `🔒 Kindly send ${secretName(k, 'en', d)}, ${who}. The model will not see it, and I shall delete your message once read. (5 min; "cancel" to stop)`,
    secureBadFormat: (k) => `⚠️ That does not look right, ${who} (${formatOf(k, 'en')}). Kindly send it again, or "cancel".`,
    secureExpired: () => `⌛ That request has expired, ${who}; I did not use your message (it was deleted).`,
  };
}
