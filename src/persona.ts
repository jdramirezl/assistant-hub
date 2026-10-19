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

export function addressOf(p: PersonaConfig, lang: Language = p.language): string {
  return lang === 'es' ? `Amo ${p.ownerName}` : `Master ${stripAccents(p.ownerName)}`;
}

/** System-prompt section for the persona; '' when switched off (HUB_PERSONA=plain). */
export function personaPrompt(p: PersonaConfig): string {
  if (p.persona !== 'alfred') return '';
  return [
    '## Persona',
    'You are Alfred Pennyworth, the user\'s butler: formal, loyal, with a dry British wit.',
    `Address the user as "${addressOf(p, 'en')}" when replying in English and "${addressOf(p, 'es')}" in Spanish (as in the Latin American dub). Reply in the user's language.`,
    'Brevity first: at most one short, elegant line of personality, then the facts.',
    'Plans, amounts, calories, approval requests and errors stay plain and scannable; the persona never obscures a number.',
  ].join('\n');
}

type Apps = Record<string, ServerStatus>;

export interface Voice {
  startup(host: string, apps: Apps): string;
  back(app: string, minutes: number): string;
  rateLimit(seconds: number): string;
  rateLimitGiveUp(daily: boolean): string;
  digestEmpty(period: string): string;
  planEdit(): string;
}

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
      rateLimit: (s) => `⏳ rate limit, retrying in ${s}s`,
      rateLimitGiveUp: (daily) =>
        daily
          ? '⏳ Gemini daily free-tier limit reached; I will be able to answer again tomorrow.'
          : '⏳ Gemini rate limit; give me a minute and send it again.',
      digestEmpty: (period) => `🗓️ Weekly digest (${period}): no apps reported data yet. Connect finance or fitness to get a real summary.`,
      planEdit: () => '✏️ What should I change? Reply in text and I will send a revised plan.',
    };
  }
  if (lang === 'es') {
    return {
      startup: (host, apps) => [`✅ A su servicio, ${who}. En línea en ${host}.`, ...appLines(apps, 'es')].join('\n'),
      back: (app, min) => `✅ ${app} ha vuelto, ${who} (estuvo fuera ${min} min).`,
      rateLimit: (s) => `⏳ Google nos pide un momento, ${who}. Reintento en ${s} s.`,
      rateLimitGiveUp: (daily) =>
        daily
          ? `⏳ Me temo que agotamos el cupo diario gratuito de Gemini, ${who}. Volveré a responder mañana.`
          : `⏳ Gemini nos pide paciencia, ${who}. Inténtelo de nuevo en un minuto.`,
      digestEmpty: (period) => `🗓️ Resumen semanal (${period}), ${who}: ninguna app ha reportado datos aún.`,
      planEdit: () => `✏️ ¿Qué cambio, ${who}? Respóndame por escrito y le enviaré el plan corregido.`,
    };
  }
  return {
    startup: (host, apps) => [`✅ At your service, ${who}. Online on ${host}.`, ...appLines(apps, 'en')].join('\n'),
    back: (app, min) => `✅ ${app} has returned, ${who} (it was away for ${min} min).`,
    rateLimit: (s) => `⏳ Google asks us to wait a moment, ${who}. Retrying in ${s} s.`,
    rateLimitGiveUp: (daily) =>
      daily
        ? `⏳ I'm afraid we've used up Gemini's free daily quota, ${who}. I shall answer again tomorrow.`
        : `⏳ Gemini asks for patience, ${who}. Do try again in a minute.`,
    digestEmpty: (period) => `🗓️ Weekly digest (${period}), ${who}: no app has reported data yet.`,
    planEdit: () => `✏️ What shall I change, ${who}? Reply in text and I'll send a revised plan.`,
  };
}
