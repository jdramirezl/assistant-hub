import { usageContext } from './context.js';
import type { CallRow, UsageLog } from './usage-log.js';

export interface AttemptInfo {
  url: string;
  init?: RequestInit;
  res: Response;
  attempt: number;
}

interface GeminiChunk {
  usageMetadata?: { promptTokenCount?: number; cachedContentTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; toolUsePromptTokenCount?: number };
  candidates?: { content?: { parts?: { functionCall?: { name?: string } }[] } }[];
}

function parseChunks(text: string, sse: boolean): GeminiChunk[] {
  if (!sse) {
    try {
      const j = JSON.parse(text);
      return Array.isArray(j) ? j : [j];
    } catch {
      return [];
    }
  }
  const out: GeminiChunk[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      out.push(JSON.parse(line.slice(5)));
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * Builds the `observe` hook of the Gemini fetch: records one llm_calls row per HTTP attempt,
 * from the request body (tools, system prompt size) and the response (usageMetadata,
 * function calls). Never throws and never delays the response.
 */
export function createUsageObserver(log: UsageLog, opts: { now?: () => number; primaryModel?: string; onError?: (e: Error) => void } = {}) {
  const now = opts.now ?? Date.now;
  return (info: AttemptInfo): void => {
    const scope = usageContext.getStore();
    const seq = scope ? scope.seq++ : 0;
    const model = info.url.match(/models\/([^:/?]+)/)?.[1] ?? 'unknown';
    let toolsSent = 0;
    let systemChars = 0;
    const body = typeof info.init?.body === 'string' ? info.init.body : '';
    try {
      const b = JSON.parse(body || '{}') as { tools?: { functionDeclarations?: unknown[] }[]; systemInstruction?: { parts?: { text?: string }[] } };
      toolsSent = (b.tools ?? []).reduce((a, t) => a + (t.functionDeclarations?.length ?? 0), 0);
      systemChars = (b.systemInstruction?.parts ?? []).reduce((a, p) => a + (p.text?.length ?? 0), 0);
    } catch {
      /* not JSON */
    }
    const base: CallRow = {
      ts: now(),
      requestId: scope?.requestId ?? 'none',
      seq,
      kind: scope?.kind ?? 'other',
      intent: scope?.intent ?? 'chat',
      media: scope?.media ?? 'text',
      model,
      status: info.res.status,
      attempt: info.attempt,
      fallback: !!opts.primaryModel && model !== opts.primaryModel && scope?.kind !== 'digest',
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      toolsSent,
      systemChars,
      bodyChars: body.length,
      toolsCalled: [],
    };
    const save = (row: CallRow) => log.record(row).catch((e: Error) => opts.onError?.(e));
    if (!info.res.ok) return void save(base);
    const sse = (info.res.headers.get('content-type') ?? '').includes('event-stream') || info.url.includes('alt=sse');
    void info.res
      .clone()
      .text()
      .then((text) => {
        const chunks = parseChunks(text, sse);
        const usage = chunks.map((c) => c.usageMetadata).filter(Boolean).at(-1) ?? {};
        const calls = chunks.flatMap((c) => c.candidates?.[0]?.content?.parts ?? []).flatMap((p) => (p.functionCall?.name ? [p.functionCall.name] : []));
        return save({
          ...base,
          inputTokens: (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0),
          cachedTokens: usage.cachedContentTokenCount ?? 0,
          outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
          thinkingTokens: usage.thoughtsTokenCount ?? 0,
          toolsCalled: calls,
        });
      })
      .catch(() => save(base));
  };
}
