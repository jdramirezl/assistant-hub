import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import type { MastraMemory } from '@mastra/core/memory';
import type { InputProcessor, OutputProcessor } from '@mastra/core/processors';
import { modelChain } from '../models.js';

export const ASSISTANT_ID = 'assistant';

function localTime(timezone: string, now: Date): { stamp: string; weekday: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'long',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { stamp: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`, weekday: parts.weekday! };
}

export function buildInstructions(timezone: string, now: Date = new Date()): string {
  const { stamp, weekday } = localTime(timezone, now);
  return [
    "You are the user's personal assistant, reached through Telegram on their phone.",
    'Reply in the language the user writes in (Spanish or English; mixed is fine). Keep answers short and concise: a few lines, no filler.',
    `Current local time: ${weekday} ${stamp} (${timezone}). Resolve relative dates ("ayer", "last Friday") against it.`,
    'Use tools to act on the user\'s apps. Tools are prefixed by app (finance_*, fitness_*). When the user asks for a write, do it and then confirm briefly what changed.',
    'Never invent data a tool did not return. If a tool returns {"error":{code,message,retryable}}, say what failed in one line and whether retrying may help.',
    'Photos are usually receipts or meals; voice notes are requests. Extract amounts, dates and items carefully and state any assumption you made.',
  ].join('\n');
}

export interface AssistantOptions {
  timezone: string;
  tools?: ToolsInput | (() => ToolsInput | Promise<ToolsInput>);
  memory?: MastraMemory;
  /** Test seam: replaces the Gemini fallback chain. */
  model?: Agent['model'];
  /** Extra, per-request lines appended to the instructions (e.g. which apps are down). */
  extraInstructions?: () => string;
  /** Processors that run in both the input and output phases (e.g. the budget guard). */
  guards?: (InputProcessor & OutputProcessor)[];
}

export function createAssistantAgent(opts: AssistantOptions): Agent {
  return new Agent({
    id: ASSISTANT_ID,
    name: 'Assistant',
    description: 'Personal assistant for finance, fitness and future apps',
    instructions: () => [buildInstructions(opts.timezone), opts.extraInstructions?.()].filter(Boolean).join('\n'),
    model: (opts.model ?? modelChain('default')) as never,
    tools: (opts.tools ?? {}) as never,
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.guards?.length ? { inputProcessors: opts.guards, outputProcessors: opts.guards } : {}),
  });
}
