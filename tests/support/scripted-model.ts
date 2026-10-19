import { MastraLanguageModelV2Mock, simulateReadableStream } from '@mastra/core/test-utils/llm-mock';

/** One model turn: either call a tool or answer with text. */
export type Step = { tool: string; args: Record<string, unknown> } | { text: string } | { malformed: true };
export type Turn = Step | ((prompt: unknown[]) => Step);

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

/**
 * A mock model that plays a script of turns (tool calls / text), one per model call.
 * When the script runs out it answers with the last tool result it saw, so tests can
 * assert what came back from a tool.
 */
export function scriptedModel(script: Turn[]) {
  let i = 0;
  const calls: { prompt: unknown[]; tools: string[] }[] = [];
  const next = (prompt: unknown[], tools?: { name: string }[]): { step: Step; n: number } => {
    calls.push({ prompt, tools: (tools ?? []).map((t) => t.name) });
    const n = i++;
    let turn = script[n];
    if (typeof turn === 'function') turn = turn(prompt);
    return { step: turn ?? { text: `done: ${lastToolResult(prompt)}` }, n };
  };
  const model = new MastraLanguageModelV2Mock({
    doGenerate: async (options) => {
      const { step, n } = next(options.prompt as unknown[], options.tools as { name: string }[] | undefined);
      if ('malformed' in step) return { content: [], finishReason: 'error', usage, warnings: [] } as never;
      return {
        content:
          'tool' in step
            ? [{ type: 'tool-call', toolCallId: `call-${n}`, toolName: step.tool, input: JSON.stringify(step.args) }]
            : [{ type: 'text', text: step.text }],
        finishReason: 'tool' in step ? 'tool-calls' : 'stop',
        usage,
        warnings: [],
      } as never;
    },
    doStream: async (options) => {
      const { step, n } = next(options.prompt as unknown[], options.tools as { name: string }[] | undefined);
      const chunks =
        'malformed' in step
          ? [
              { type: 'stream-start', warnings: [] },
              { type: 'finish', finishReason: 'error', usage },
            ]
          : 'tool' in step
          ? [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: `call-${n}`, toolName: step.tool, input: JSON.stringify(step.args) },
              { type: 'finish', finishReason: 'tool-calls', usage },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: `t-${n}` },
              { type: 'text-delta', id: `t-${n}`, delta: step.text },
              { type: 'text-end', id: `t-${n}` },
              { type: 'finish', finishReason: 'stop', usage },
            ];
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) as never };
    },
  });
  return { model, calls };
}

/** Text of the most recent tool result in a prompt. */
export function lastToolResult(prompt: unknown[]): string {
  const parts = (prompt as { role: string; content: unknown }[])
    .filter((m) => m.role === 'tool')
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as { output?: unknown }[];
  const last = parts.at(-1);
  return last ? JSON.stringify(last.output) : 'none';
}
