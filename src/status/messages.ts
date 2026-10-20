/**
 * Every non-answer message the user sees, in one voice: icon + what happened + what's next,
 * one line (plus a monospace technical line for failures), in Alfred's voice or plain.
 */
import type { PersonaConfig } from '../persona.js';
import { addressOf } from '../persona.js';
import { appName, explain, type Explained, type Lang } from './errors.js';
import type { Outcome } from './outcome.js';

export interface StatusText {
  text: string;
  /** Monospace technical line: `CODE · req 7f3a2c` */
  tech?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Telegram HTML (parse_mode HTML). */
export const toHtml = (m: StatusText) => `${esc(m.text)}${m.tech ? `\n<code>${esc(m.tech)}</code>` : ''}`;
/** Plain text (notices sent without parse mode). */
export const toPlain = (m: StatusText) => `${m.text}${m.tech ? `\n${m.tech}` : ''}`;

export const techLine = (code: string, requestId?: string) => `${code}${requestId ? ` · req ${requestId}` : ''}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmtDuration = (ms: number, lang: Lang) => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} ${lang === 'es' ? 'd' : 'd'}`;
};

export class StatusMessages {
  readonly lang: Lang;
  private readonly who?: string;
  constructor(private readonly persona: PersonaConfig, lang?: Lang) {
    this.lang = lang ?? persona.language;
    this.who = persona.persona === 'alfred' ? addressOf(persona, this.lang) : undefined;
  }
  private get es() {
    return this.lang === 'es';
  }
  /** ", Amo Julián" or "" */
  private get addr() {
    return this.who ? `, ${this.who}` : '';
  }
  forLang(lang: Lang | undefined): StatusMessages {
    return !lang || lang === this.lang ? this : new StatusMessages(this.persona, lang);
  }

  received(media: 'voice' | 'photo' | 'pdf'): StatusText {
    const what = { voice: this.es ? ['Nota recibida', 'Transcribiendo…'] : ['Voice note received', 'Transcribing…'], photo: this.es ? ['Foto recibida', 'Revisándola…'] : ['Photo received', 'Looking at it…'], pdf: this.es ? ['Documento recibido', 'Leyéndolo…'] : ['Document received', 'Reading it…'] }[media];
    return { text: `📥 ${what[0]}${this.addr}. ${what[1]}` };
  }
  transcribed(transcript: string, final = false): StatusText {
    const q = `«${clip(transcript.replace(/\s+/g, ' ').trim(), 70)}»`;
    return { text: this.es ? `📥 Nota: ${q}${final ? '' : ' Procesando…'}` : `📥 Note: ${q}${final ? '' : ' Processing…'}` };
  }
  working(activity?: string): StatusText {
    return { text: `⏳ ${activity ?? (this.es ? 'Trabajando en ello…' : 'Working on it…')}` };
  }
  /** Activity line for a tool that started ("Buscando 4 alimentos en MyFitnessPal…"). */
  activity(tool: string, args: Record<string, unknown>, sameToolCount = 1): string {
    const es = this.es;
    if (tool === 'log_meal') {
      const n = Array.isArray(args.items) ? args.items.length : 1;
      return es ? `Buscando ${n} ${n === 1 ? 'alimento' : 'alimentos'} en MyFitnessPal…` : `Looking up ${n} ${n === 1 ? 'food' : 'foods'} in MyFitnessPal…`;
    }
    if (tool === 'finance_create_movement') return es ? `Registrando ${sameToolCount} ${sameToolCount === 1 ? 'movimiento' : 'movimientos'} en finanzas…` : `Recording ${sameToolCount} ${sameToolCount === 1 ? 'movement' : 'movements'} in finance…`;
    if (tool === 'propose_plan') return es ? 'Preparando el plan…' : 'Preparing the plan…';
    if (tool === 'cines_seat_map' || tool === 'cines_validate_seats') return es ? 'Preparando el mapa de asientos…' : 'Preparing the seat map…';
    if (tool === 'cines_purchase') return es ? 'Procesando la compra…' : 'Processing the purchase…';
    if (tool === 'cines_hold_seats') return es ? 'Apartando los asientos…' : 'Holding the seats…';
    const app = tool.startsWith('fitness_') ? 'MyFitnessPal' : tool.startsWith('finance_') ? (es ? 'sus finanzas' : 'your finances') : tool.startsWith('cines_') ? 'Cinépolis' : '';
    return app ? (es ? `Consultando ${app}…` : `Checking ${app}…`) : es ? 'Trabajando en ello…' : 'Working on it…';
  }
  /** ONLY for a real Gemini 429. */
  quota(seconds: number): StatusText {
    return { text: this.es ? `⏸️ Gemini me pidió esperar ${seconds} s. Sigo en cuanto pueda.` : `⏸️ Gemini asked me to wait ${seconds} s. I will continue as soon as I can.` };
  }

  /** Final state of a request from what it actually did. */
  outcome(o: Outcome, requestId?: string): StatusText | undefined {
    const es = this.es;
    const more = o.needInfo.length ? ` · ❓ ${o.needInfo.join(', ')}` : '';
    if (o.kind === 'done') return { text: `✅ ${o.done.join(' · ')}${more}` };
    if (o.kind === 'none') return o.needInfo.length ? { text: `❓ ${o.needInfo.join(', ')}` } : undefined;
    const f = o.failures[0]!;
    const others = o.failures.length > 1 ? (es ? ` (y ${o.failures.length - 1} más)` : ` (and ${o.failures.length - 1} more)`) : '';
    const what = f.label ? `${f.label} — ${f.why.cause}` : f.why.cause;
    const tech = techLine(f.why.code, requestId);
    if (o.kind === 'partial') {
      const saved = o.noun ? (es ? `Guardé ${o.okCount} de ${o.total} ${o.noun}` : `Saved ${o.okCount} of ${o.total} ${o.noun}`) : `${es ? 'Guardé' : 'Saved'}: ${o.done.join(' · ')}`;
      return { text: `⚠️ ${saved}. ${es ? 'Falló' : 'Failed'}: ${what}${others}. ${f.why.action}${more}`, tech };
    }
    const one = o.noun?.replace(/s$/, '');
    const lead = !o.total ? '' : es ? (o.noun ? (o.total === 1 ? `No guardé ${/a$/.test(one!) ? 'la' : 'el'} ${one}` : `No guardé ${/as$/.test(o.noun) ? 'las' : 'los'} ${o.total} ${o.noun}`) : 'No guardé nada') : o.noun ? `Did not save the ${o.total === 1 ? one : `${o.total} ${o.noun}`}` : 'Nothing saved';
    const body = lead ? `${lead}: ${f.label ? `${f.label} — ` : ''}${f.why.cause}` : capital(f.why.cause);
    return { text: `❌ ${body}${others}. ${f.why.action}`, tech };
  }
  /** The run itself failed (model / transport / budget). */
  runError(e: Explained, requestId?: string): StatusText {
    const icon = e.code === 'BUDGET' ? '💸' : e.code === 'GEMINI_DAILY_QUOTA' || e.code === 'GEMINI_RATE_LIMIT' ? '⏸️' : '❌';
    return { text: `${icon} ${capital(e.cause)}${this.addr}. ${e.action}`, tech: techLine(e.code, requestId) };
  }
  budget(requestId?: string): StatusText {
    return this.runError(explain('BUDGET', '', this.lang), requestId);
  }
  serviceDown(server: string, downMs: number): StatusText {
    const app = appName(server, this.lang);
    return { text: this.es ? `🔌 ${app} no responde desde hace ${fmtDuration(downMs, 'es')}${this.addr}. La reintento sola; le aviso cuando vuelva.` : `🔌 ${app} has been down for ${fmtDuration(downMs, 'en')}${this.addr}. I keep retrying and will tell you when it is back.` };
  }
  serviceBack(server: string, downMs: number): StatusText {
    const app = appName(server, this.lang);
    return { text: this.es ? `🔌 ${app} volvió${this.addr} (estuvo fuera ${fmtDuration(downMs, 'es')}).` : `🔌 ${app} is back${this.addr} (it was down for ${fmtDuration(downMs, 'en')}).` };
  }
  restart(version: string, apps: Record<string, { state: string }>): StatusText {
    const up = Object.entries(apps).filter(([n, s]) => s.state === 'up' && n !== 'echo').map(([n]) => appName(n, this.lang));
    const down = Object.entries(apps).filter(([, s]) => s.state === 'down').map(([n]) => appName(n, this.lang));
    const es = this.es;
    const con = up.length ? `${es ? 'Conectados' : 'Connected'}: ${up.join(', ')}.` : es ? 'Ninguna app conectada aún.' : 'No apps connected yet.';
    const off = down.length ? ` ⚠️ ${es ? 'Sin respuesta' : 'Not responding'}: ${down.join(', ')}.` : '';
    return { text: `🔄 ${es ? 'De vuelta' : 'Back online'}${this.addr} (${es ? 'versión' : 'version'} ${version}). ${con}${off}` };
  }
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
