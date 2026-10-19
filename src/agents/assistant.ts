import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import type { MastraMemory } from '@mastra/core/memory';
import type { InputProcessor, OutputProcessor } from '@mastra/core/processors';
import { personaPrompt, type PersonaConfig } from '../persona.js';

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

export function buildInstructions(_timezone: string, _now: Date = new Date(), opts: { persona?: PersonaConfig } = {}): string {
  const persona = opts.persona ? personaPrompt(opts.persona) : '';
  return [
    "You are the user's personal assistant, reached through Telegram on their phone.",
    'Always reply in the language of the user\'s latest message (Spanish → Spanish, English → English), including plan titles and summaries, even when tools return English data. Keep answers short and concise: a few lines, no filler.',
    'Use tools to act on the user\'s apps. Tools are prefixed by app (finance_*, fitness_*). When the user asks for a write, do it and then confirm briefly what changed.',
    'NEVER say you recorded, saved, logged, updated or deleted something unless an app tool call in this turn returned success. If no tool exists for that app, say plainly that the app is not connected yet and show what you would record (amount, currency, account, category, date) so the user can check it.',
    'Finance (finance_*): first call finance_list_accounts (and finance_list_pockets when a pocket matters) to resolve names like "Nequi" or "Nu México" to their ids; never guess ids. Movement types: EgresoNormal (one-off expense), IngresoNormal (one-off income), EgresoFijo / IngresoFijo (recurring fixed expense / income). Amounts are always positive numbers in the account\'s currency ("25k" = 25000); the type gives the direction. Dates are YYYY-MM-DD in local time; default to today. If a tool returns VALIDATION_ERROR or NOT_FOUND, tell the user what is wrong and ask; do not say it was saved.',
    'MyFitnessPal (fitness_*): search and draft in English: translate Spanish food names first ("huevo" → "egg", "pan integral" → "whole wheat bread"); keep dish names that have no English equivalent (arepa). Always draft with fitness_draft_food, never take the first result: pick the option and the serving whose unit matches what the user said (1 egg, 1 slice, 100 g, 1 cup) and set quantity to the number of those units.',
    'Before logging, estimate the expected kcal per item yourself and state it briefly. Compare it with the chosen draft serving\'s calories; if they differ by more than 2× (twice or half), pick another option/serving or ask the user, and do not log. If a log result has a "warning", tell the user right away and offer to fix it.',
    'After logging a meal, report it once from the last fitness_log_food result\'s meal_total (e.g. "Breakfast logged: 3 items, 420 kcal"); if it is missing, call fitness_get_day once.',
    'Batch approvals: when a request needs 2 or more approval-gated actions (deletes, fitness_modify_food, fitness_clear_food_pin, finance_delete_movement, anything destructive), NEVER call them one by one. First read what you need (e.g. fitness_get_day, finance_list_movements), then call propose_plan ONCE with every action, using exact tool names and args, grouped into sections (MyFitnessPal: one section per meal, summary "Item — kcal"; finance: by account or date, summary "Description — amount currency — account"). Then reply with one short line and stop: the user approves, edits or cancels the whole plan, and the hub runs exactly those calls and sends you the results to summarize in one message. If the user asks to change a plan, call propose_plan again with the full revised plan. A single gated action uses the normal approval card.',
    'Working memory is ONLY for durable preferences (name, default currency, accounts, goals). Never store transactions, meals or other records there.',
    'Never invent data a tool did not return. If a tool returns {"error":{code,message,retryable}}, say what failed in one line and whether retrying may help.',
    'Photos are usually receipts or meals; voice notes are requests. Extract amounts, dates and items carefully and state any assumption you made.',
    ...(persona ? ['', persona] : []),
  ].join('\n');
}

/**
 * The parts of the prompt that change: kept at the END so everything before them (and the
 * tool list) is a byte-identical prefix that Gemini's implicit cache can reuse. Hour precision.
 */
export function dynamicContext(timezone: string, now: Date = new Date(), statusNote = ''): string {
  const { stamp, weekday } = localTime(timezone, now);
  return [
    '## Now',
    `Local time: ${weekday} ${stamp.slice(0, 13)}h (${timezone}). Resolve relative dates ("ayer", "last Friday") and the likely meal from it.`,
    statusNote,
  ].filter(Boolean).join('\n');
}

export interface AssistantOptions {
  timezone: string;
  tools?: ToolsInput | (() => ToolsInput | Promise<ToolsInput>);
  memory?: MastraMemory;
  /** Model config (hub passes the Gemini chain; tests pass a mock). */
  model: unknown;
  /** Extra, per-request lines appended to the instructions (e.g. which apps are down). */
  extraInstructions?: () => string;
  /** Processors that run in both the input and output phases (e.g. the budget guard). */
  guards?: (InputProcessor & OutputProcessor)[];
  /** Output-only processors (e.g. the batch-approval guard). */
  outputGuards?: OutputProcessor[];
  /** Input-only processors (e.g. the short working-memory prompt). */
  inputGuards?: InputProcessor[];
  /** Persona section of the prompt (omit or `plain` to switch off). */
  persona?: PersonaConfig;
  /** Clock (tests). */
  now?: () => number;
}

export function createAssistantAgent(opts: AssistantOptions): Agent {
  return new Agent({
    id: ASSISTANT_ID,
    name: 'Assistant',
    description: 'Personal assistant for finance, fitness and future apps',
    instructions: () =>
      [
        buildInstructions(opts.timezone, new Date(), { persona: opts.persona }),
        '',
        dynamicContext(opts.timezone, new Date(opts.now?.() ?? Date.now()), opts.extraInstructions?.() ?? ''),
      ].join('\n'),
    model: opts.model as never,
    tools: (opts.tools ?? {}) as never,
    ...(opts.memory ? { memory: opts.memory } : {}),
    inputProcessors: [...(opts.inputGuards ?? []), ...(opts.guards ?? [])],
    outputProcessors: [...(opts.guards ?? []), ...(opts.outputGuards ?? [])],
    maxProcessorRetries: 2,
  });
}
