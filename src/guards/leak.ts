/**
 * Only the FINAL answer reaches the user. Gemini often writes its plan as plain text before a
 * tool call ("The user wants to… Rule check: … Let's call fitness_get_day…"); Mastra's channel
 * posts any step's text, so the hub removes it at the model level, deterministically:
 *
 * - a step that calls tools: its text is dropped (the live status shows what is happening);
 * - a final step whose text looks like planning (tool names, "Rule check", "Let's call", "the
 *   user wants to"…) is retried ONCE with feedback; if it still leaks, the leaking lines are
 *   removed;
 * - right after a plan card was shown, the model's text is dropped: the card is the message
 *   (a late "please approve" would land after the user already tapped ✅).
 */
type Part = { type: string; delta?: string; id?: string; toolName?: string };
type Msg = { role: string; content: unknown };
type StreamModel = {
  specificationVersion: string;
  provider: string;
  modelId: string;
  supportedUrls?: unknown;
  doGenerate(o: unknown): PromiseLike<unknown>;
  doStream(o: unknown): PromiseLike<{ stream: ReadableStream<Part> }>;
};

/** Text that is the model thinking out loud, not an answer for the user. */
export const PLANNING_LEAK =
  /\b(?:fitness|finance|cines)_[a-z_]+\b|\b(?:log_meal|propose_plan|clear_day|updateWorkingMemory)\b|\brule check\b|\blet'?s (?:call|check|use|first)\b|\b(?:the )?user (?:wants|asked|is asking|said) (?:to|me|for|that)\b|\bwait,? (?:can|should|do|the)\b|\bI (?:will|should|need to|must) (?:call|use|first)\b|\btool calls?\b|\bthis turn\b|\bsystem prompt\b|\bper the rules?\b|^\s*(?:plan|step \d+|thought|reasoning)\s*:/im;

export const leaks = (text: string) => PLANNING_LEAK.test(text);

/** Remove the lines (or sentences) that leak; '' when nothing is left. */
export function stripLeaks(text: string): string {
  const keep = text
    .split('\n')
    .map((line) => (leaks(line) ? line.split(/(?<=[.!?¿¡])\s+/).filter((s) => !leaks(s)).join(' ') : line))
    .filter((line, i, all) => line.trim() || (i > 0 && all[i - 1]!.trim()));
  return keep.join('\n').trim();
}

const FEEDBACK =
  '[hub] Your last reply exposed your internal planning (tool names, rules or reasoning). Write ONLY the final answer for the user, in their language, in a few lines: what was done or what you need from them. No tool names, no rules, no "the user wants".';

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
const isText = (p: Part) => p.type === 'text-start' || p.type === 'text-delta' || p.type === 'text-end';
const textOf = (parts: Part[]) => parts.filter((p) => p.type === 'text-delta').map((p) => p.delta ?? '').join('');
const hasToolCall = (parts: Part[]) => parts.some((p) => p.type === 'tool-call');
function withText(parts: Part[], text: string): Part[] {
  if (!text) return parts.filter((p) => !isText(p));
  let done = false;
  return parts.flatMap((p) => (p.type !== 'text-delta' ? [p] : done ? [] : ((done = true), [{ ...p, delta: text }])));
}

/** A plan card was shown in this turn (propose_plan / clear_day returned status shown_to_user). */
export function planShownThisTurn(prompt: Msg[]): boolean {
  const lastUser = prompt.map((m) => m.role).lastIndexOf('user');
  return prompt.slice(lastUser + 1).some(
    (m) =>
      m.role === 'tool' &&
      Array.isArray(m.content) &&
      (m.content as { type?: string; output?: { value?: unknown } }[]).some((r) => r.type === 'tool-result' && /"status"\s*:\s*"shown_to_user"/.test(JSON.stringify(r.output?.value ?? ''))),
  );
}

/** user_message of tool failures this turn that no later call of the same tool fixed. */
export function finalFailureCauses(prompt: Msg[]): string[] {
  const lastUser = prompt.map((m) => m.role).lastIndexOf('user');
  const rs: { tool: string; cause?: string; ok: boolean }[] = [];
  for (const m of prompt.slice(lastUser + 1)) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const r of m.content as { type?: string; toolName?: string; output?: { value?: unknown } }[]) {
      if (r.type !== 'tool-result' || !r.toolName) continue;
      const v = (r.output?.value ?? {}) as { error?: unknown; user_message?: unknown };
      rs.push({ tool: r.toolName, ok: !(v && typeof v === 'object' && 'error' in v), cause: typeof v?.user_message === 'string' ? v.user_message : undefined });
    }
  }
  return rs.filter((x, i) => !x.ok && x.cause && !rs.slice(i + 1).some((y) => y.tool === x.tool && y.ok)).map((x) => x.cause!);
}

const words = (s: string) => new Set(s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').match(/\p{L}{4,}/gu) ?? []);
/** The reply just restates a failure cause (no question, mostly the same words). */
export function restatesFailure(text: string, causes: string[]): boolean {
  if (!text.trim() || /\?/.test(text) || text.length > 400) return false;
  const t = words(text);
  return causes.some((c) => {
    const w = [...words(c)];
    return w.length >= 3 && w.filter((x) => t.has(x)).length / w.length >= 0.6;
  });
}

export function withLeakGuard(model: unknown, log: (m: string) => void = () => {}): unknown {
  const m = model as StreamModel;
  if (!m || typeof m.doStream !== 'function') return model;
  const guardedStream = async (options: unknown) => {
    const first = await m.doStream(options);
    const parts = await drain(first.stream);
    const prompt = ((options as { prompt?: Msg[] }).prompt ?? []) as Msg[];
    const text = textOf(parts);
    if (hasToolCall(parts)) {
      if (text.trim()) log(`[guard] dropped ${text.length} chars of text from a tool step`);
      return { ...first, stream: replay(parts.filter((p) => !isText(p))) };
    }
    if (text.trim() && planShownThisTurn(prompt)) {
      log('[guard] plan card shown: the card is the message; dropped the model text');
      return { ...first, stream: replay(withText(parts, '')) };
    }
    // the status line already shows this failure (❌ + cause + action): no duplicate message
    if (text.trim() && restatesFailure(text, finalFailureCauses(prompt))) {
      log('[guard] reply only restates the failure shown in the status line; dropped it');
      return { ...first, stream: replay(withText(parts, '')) };
    }
    if (!leaks(text)) return { ...first, stream: replay(parts) };
    log('[guard] reply leaks internal planning; retrying once with feedback');
    const retry = await m.doStream({ ...(options as object), prompt: [...prompt, { role: 'user', content: [{ type: 'text', text: FEEDBACK }] }] });
    const again = await drain(retry.stream);
    if (hasToolCall(again)) return { ...retry, stream: replay(again.filter((p) => !isText(p))) };
    const t2 = textOf(again);
    if (!leaks(t2)) return { ...retry, stream: replay(again) };
    log('[guard] still leaking; removed the leaking lines');
    return { ...retry, stream: replay(withText(again, stripLeaks(t2))) };
  };
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
  return wrapped;
}
