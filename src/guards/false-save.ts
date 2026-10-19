import { usageContext } from '../telemetry/context.js';
import type { Language } from '../persona.js';

/** Intents where the user asked for a write (the reply must not claim one that didn't happen). */
export const WRITE_INTENTS = new Set(['expense', 'meal', 'plan']);
const READ_TOOL = /^(updateWorkingMemory$|fitness_(get|search|draft|list|bulk)_|finance_(list|spending|convert)_)/;
/** Words that claim a save/delete happened (es/en). */
export const SAVE_CLAIM = /(?<!\p{L})(registr[éeoóa]\p{L}*|guard[éeoóa]\p{L}*|anot[éeoóa]\p{L}*|apunt[éeoóa]\p{L}*|elimin[éeoóa]\p{L}*|borr[éeoóa]\p{L}*|logged|saved|recorded|added|deleted|removed|done|listo|hecho)(?!\p{L})/iu;

type Part = { type: string; delta?: string };
type Msg = { role: string; content: unknown };
type StreamModel = {
  specificationVersion: string;
  provider: string;
  modelId: string;
  supportedUrls?: unknown;
  doGenerate(o: unknown): PromiseLike<unknown>;
  doStream(o: unknown): PromiseLike<{ stream: ReadableStream<Part> }>;
};

/** A write tool returned success after the last user message (this turn). */
export function wroteThisTurn(prompt: Msg[]): boolean {
  const lastUser = prompt.map((m) => m.role).lastIndexOf('user');
  return prompt.slice(lastUser + 1).some(
    (m) =>
      m.role === 'tool' &&
      Array.isArray(m.content) &&
      (m.content as { type?: string; toolName?: string; output?: { value?: unknown } }[]).some((r) => {
        if (r.type !== 'tool-result' || !r.toolName || READ_TOOL.test(r.toolName)) return false;
        let v = r.output?.value as unknown;
        if (typeof v === 'string') {
          try {
            v = JSON.parse(v);
          } catch {
            v = {};
          }
        }
        const obj = (v ?? {}) as Record<string, unknown>;
        if (typeof obj === 'object' && 'error' in obj) return false;
        if (r.toolName === 'log_meal') return Array.isArray(obj.logged) && obj.logged.length > 0;
        return true;
      }),
  );
}

const claims = (text: string) => SAVE_CLAIM.test(text) && !/\?\s*$/.test(text.trim());
const FEEDBACK =
  '[hub] Your reply says it was saved/logged/deleted, but no write tool succeeded in this turn. Call the right tool now (finance_create_movement, log_meal, propose_plan, …). If you cannot, say plainly that it was NOT saved and ask.';

async function drain(stream: ReadableStream<Part>): Promise<Part[]> {
  const out: Part[] = [];
  const r = stream.getReader();
  for (;;) {
    const { value, done } = await r.read();
    if (done) return out;
    out.push(value);
  }
}
const replay = (parts: Part[]) =>
  new ReadableStream<Part>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
const textOf = (parts: Part[]) => parts.filter((p) => p.type === 'text-delta').map((p) => p.delta ?? '').join('');
const hasToolCall = (parts: Part[]) => parts.some((p) => p.type === 'tool-call');
function withText(parts: Part[], text: string): Part[] {
  let done = false;
  return parts.flatMap((p) => (p.type !== 'text-delta' ? [p] : done ? [] : ((done = true), [{ ...p, delta: text }])));
}

/**
 * Deterministic "no false save" guard at the model level, so nothing reaches Telegram first.
 * For write intents (expense / meal / plan), a text-only reply that claims a save while no write
 * tool succeeded this turn gets ONE retry with feedback; if it still claims, the text is
 * replaced by an honest "not saved, shall I record it?" line.
 */
export function withFalseSaveGuard(model: unknown, notSaved: () => string, log: (m: string) => void = () => {}): unknown {
  const m = model as StreamModel;
  if (!m || typeof m.doStream !== 'function') return model;
  const active = () => WRITE_INTENTS.has(String(usageContext.getStore()?.intent ?? ''));
  const wrapped: StreamModel = {
    specificationVersion: m.specificationVersion,
    provider: m.provider,
    modelId: m.modelId,
    get supportedUrls() {
      return m.supportedUrls;
    },
    doGenerate: (o) => m.doGenerate(o),
    doStream: (o) => guardedStream(o),
  };
  const guardedStream = async (options: unknown) => {
    const first = await m.doStream(options);
    const prompt = ((options as { prompt?: Msg[] }).prompt ?? []) as Msg[];
    if (!active() || wroteThisTurn(prompt)) return first;
    const parts = await drain(first.stream);
    if (hasToolCall(parts) || !claims(textOf(parts))) return { ...first, stream: replay(parts) };
    log('[guard] reply claims a save but no write tool succeeded; retrying once with feedback');
    const retry = await m.doStream({ ...(options as object), prompt: [...prompt, { role: 'user', content: [{ type: 'text', text: FEEDBACK }] }] });
    const again = await drain(retry.stream);
    if (hasToolCall(again) || !claims(textOf(again))) return { ...retry, stream: replay(again) };
    log('[guard] still a false save claim; replaced with "not saved"');
    return { ...retry, stream: replay(withText(again, notSaved())) };
  };
  return wrapped;
}

export function notSavedText(lang: Language, address: string): string {
  return lang === 'es'
    ? `⚠️ Le pido disculpas, ${address}: no lo guardé. ¿Lo registro?`
    : `⚠️ My apologies, ${address}: I did not save that. Shall I record it?`;
}
