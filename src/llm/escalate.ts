/**
 * Escalate to the stronger model only on a BAD response: Gemini's MALFORMED_FUNCTION_CALL
 * arrives as finishReason "error" with no content, which Mastra would otherwise turn into a
 * fatal run error. Provider errors (429/503) are NOT escalated; the fetch layer retries
 * those on the same model.
 *
 * Works at the LanguageModel level (doGenerate/doStream), so it is invisible to Mastra.
 * Streams are passed through as soon as real content appears; only a stream that ends in
 * "error" before producing any content is replaced by the stronger model's stream.
 */
type Part = { type: string; finishReason?: unknown };
type ModelObj = {
  specificationVersion: string;
  provider: string;
  modelId: string;
  supportedUrls?: unknown;
  doGenerate(options: unknown): PromiseLike<{ content?: unknown[]; finishReason?: unknown }>;
  doStream(options: unknown): PromiseLike<{ stream: ReadableStream<Part> }>;
};

export function isErrorFinish(reason: unknown): boolean {
  return reason === 'error' || (typeof reason === 'object' && reason !== null && (reason as { unified?: string }).unified === 'error');
}

const CONTENT = new Set(['text-start', 'text-delta', 'tool-call', 'tool-input-start', 'reasoning-delta', 'file']);

export function withMalformedFallback(primary: unknown, stronger: unknown, log: (m: string) => void = () => {}): unknown {
  const p = primary as ModelObj;
  const s = stronger as ModelObj;
  if (!p || typeof p.doStream !== 'function' || !s || typeof s.doStream !== 'function' || p === s) return primary;

  return {
    specificationVersion: p.specificationVersion,
    provider: p.provider,
    modelId: p.modelId,
    get supportedUrls() {
      return p.supportedUrls;
    },
    async doGenerate(options: unknown) {
      const res = await p.doGenerate(options);
      if (isErrorFinish(res.finishReason) && !(res.content ?? []).length) {
        log(`[llm] malformed response from ${p.modelId}; retrying on ${s.modelId}`);
        return s.doGenerate(options);
      }
      return res;
    },
    async doStream(options: unknown) {
      const first = await p.doStream(options);
      const reader = first.stream.getReader();
      const buffered: Part[] = [];
      let passThrough = false;
      // Buffer until content appears (then pass through) or the stream ends.
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered.push(value);
        if (CONTENT.has(value.type)) {
          passThrough = true;
          break;
        }
        if (value.type === 'finish' && isErrorFinish(value.finishReason)) {
          reader.releaseLock();
          void first.stream.cancel().catch(() => {});
          log(`[llm] malformed response from ${p.modelId}; retrying on ${s.modelId}`);
          return s.doStream(options);
        }
      }
      const stream = new ReadableStream<Part>({
        start(controller) {
          for (const part of buffered) controller.enqueue(part);
          if (!passThrough) controller.close();
        },
        async pull(controller) {
          const { value, done } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
      return { ...first, stream };
    },
  };
}
