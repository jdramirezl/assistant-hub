/**
 * Voice notes are transcribed by the hub BEFORE the agent runs (one cheap flash-lite call), so
 * the router, the meal word and the reply language are decided in code from the words, and the
 * agent gets text instead of audio.
 */
import { usageContext } from '../telemetry/context.js';

export interface Transcript {
  transcript: string;
  /** ISO 639-1 code, e.g. "es". */
  language: string;
}
export type Transcribe = (audio: Uint8Array, mediaType: string) => Promise<Transcript | undefined>;

interface GenerateModel {
  modelId?: string;
  doGenerate(options: unknown): PromiseLike<{ content?: { type: string; text?: string }[]; usage?: Record<string, number | undefined> }>;
}

const PROMPT =
  'Transcribe this voice note word for word, in the language it is spoken in (do not translate). ' +
  'Return ONLY JSON: {"transcript": "...", "language": "<ISO 639-1 code, e.g. es or en>"}. ' +
  'If there is no speech, return {"transcript": "", "language": ""}.';

/** Parse the model's JSON reply (possibly fenced); undefined if unusable. */
export function parseTranscript(text: string): Transcript | undefined {
  const raw = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const j = JSON.parse(raw) as { transcript?: unknown; language?: unknown };
    const t = String(j.transcript ?? '').trim();
    return t ? { transcript: t, language: String(j.language ?? '').toLowerCase().slice(0, 2) } : undefined;
  } catch {
    return undefined;
  }
}

export function createTranscriber(
  model: unknown,
  opts: {
    providerOptions?: Record<string, Record<string, unknown>>;
    log?: (m: string) => void;
    /** Count the call toward the daily budget. */
    record?: (modelId: string, usage: Record<string, number | undefined>) => Promise<void>;
  } = {},
): Transcribe {
  const m = model as GenerateModel;
  const log = opts.log ?? (() => {});
  return async (audio, mediaType) => {
    const outer = usageContext.getStore();
    const run = async () => {
      const res = await m.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'file', data: audio, mediaType }] }],
        responseFormat: { type: 'json' },
        ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
      });
      await opts.record?.(m.modelId ?? 'unknown', res.usage ?? {}).catch(() => {});
      return (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    };
    try {
      // logged as its own kind in llm_calls, under the same request id
      const inner = outer ? { ...outer, kind: 'transcribe' as const } : undefined;
      const text = inner ? await usageContext.run(inner, run) : await run();
      if (outer && inner) outer.seq = inner.seq;
      const t = parseTranscript(text);
      log(`[voice] transcribed ${audio.byteLength} bytes → ${t ? `${t.transcript.length} chars (${t.language || '?'})` : 'nothing'}`);
      return t;
    } catch (err) {
      log(`[voice] transcription failed (${(err as Error).message}); sending the audio to the agent`);
      return undefined;
    }
  };
}
