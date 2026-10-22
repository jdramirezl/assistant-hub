/**
 * "Amo Julián" → "Master Julian". The persona prompt already says it, but the model copies the
 * old form from its own earlier replies (chat history). At the model layer: earlier assistant
 * messages are rewritten before the call (so there is nothing to copy) and the reply is fixed
 * if it still slips. Deterministic; no extra model call.
 */
type Part = { type: string; delta?: string };
type StreamModel = {
  specificationVersion: string;
  provider: string;
  modelId: string;
  supportedUrls?: unknown;
  doGenerate(o: unknown): PromiseLike<unknown>;
  doStream(o: unknown): PromiseLike<{ stream: ReadableStream<Part> }>;
};
type Msg = { role: string; content: unknown };

const OLD = /\b[Aa]mo\s+Juli[aá]n\b/g;
const HAS = /\b[Aa]mo\s+Juli[aá]n\b/;

export function fixAddress(text: string, address: string): string {
  return text.replace(OLD, address);
}

/** The prompt with earlier assistant text rewritten (user text and tool data untouched). */
export function fixHistory(prompt: Msg[], address: string): Msg[] {
  return prompt.map((m) => {
    if (m.role !== 'assistant') return m;
    if (typeof m.content === 'string') return HAS.test(m.content) ? { ...m, content: fixAddress(m.content, address) } : m;
    if (!Array.isArray(m.content)) return m;
    let changed = false;
    const content = (m.content as { type?: string; text?: string }[]).map((p) => {
      if (p.type !== 'text' || typeof p.text !== 'string' || !HAS.test(p.text)) return p;
      changed = true;
      return { ...p, text: fixAddress(p.text, address) };
    });
    return changed ? { ...m, content } : m;
  });
}

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

export function withAddressFix(model: unknown, address: string, log: (m: string) => void = () => {}): unknown {
  const m = model as StreamModel;
  if (!m || typeof m.doStream !== 'function') return model;
  const opts = (o: unknown) => {
    const prompt = (o as { prompt?: Msg[] }).prompt;
    return Array.isArray(prompt) ? { ...(o as object), prompt: fixHistory(prompt, address) } : o;
  };
  const wrapped: StreamModel = {
    specificationVersion: m.specificationVersion,
    provider: m.provider,
    modelId: m.modelId,
    get supportedUrls() {
      return m.supportedUrls;
    },
    doGenerate: async (o) => {
      const res = (await m.doGenerate(opts(o))) as { content?: { type: string; text?: string }[] };
      if (!res?.content?.some((c) => c.type === 'text' && HAS.test(c.text ?? ''))) return res;
      log('[guard] reply said "Amo Julián"; fixed the address');
      return { ...res, content: res.content.map((c) => (c.type === 'text' && c.text ? { ...c, text: fixAddress(c.text, address) } : c)) };
    },
    doStream: async (o) => {
      const res = await m.doStream(opts(o));
      const parts = await drain(res.stream);
      const text = parts.filter((p) => p.type === 'text-delta').map((p) => p.delta ?? '').join('');
      if (!HAS.test(text)) return { ...res, stream: replay(parts) };
      log('[guard] reply said "Amo Julián"; fixed the address');
      let done = false;
      const fixed = fixAddress(text, address);
      return { ...res, stream: replay(parts.flatMap((p) => (p.type !== 'text-delta' ? [p] : done ? [] : ((done = true), [{ ...p, delta: fixed }])))) };
    },
  };
  return wrapped;
}
