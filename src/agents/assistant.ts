import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import type { MastraMemory } from '@mastra/core/memory';
import type { InputProcessor, OutputProcessor } from '@mastra/core/processors';
import { personaPrompt, type PersonaConfig } from '../persona.js';
import { ALL_DOMAINS, type Domain } from '../telemetry/intent.js';
import { usageContext } from '../telemetry/context.js';
import { languageName } from '../meal.js';

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

/** Rules sent only when that app's tools are sent (see domainsFor). */
export const DOMAIN_RULES: Record<Domain, string[]> = {
  finance: [
    '## Finance (finance_*)',
    '- Use the account and pocket ids listed under "## Now"; call finance_list_accounts / finance_list_pockets only if one is missing. Never guess ids.',
    '- Types: EgresoNormal = expense, IngresoNormal = income, EgresoFijo / IngresoFijo = on a fixed-expense budget. Amounts are positive, in the account currency ("25k" = 25000, "4.2 millones" = 4200000). displayedDate is YYYY-MM-DD, local, default today.',
    '- Every expense, income or transfer the user reports MUST be saved with a tool call (finance_create_movement / finance_create_transfer) before you reply; a reply alone saves nothing. Fill accountId and pocketId from the ids under "## Now".',
    '- VALIDATION_ERROR / NOT_FOUND: say what is wrong and ask; it was not saved.',
  ],
  fitness: [
    '## MyFitnessPal (fitness_*)',
    '- To log food, call log_meal ONCE with every item of the message: English food name, the user\'s quantity and unit, your kcal estimate, meal. Never draft/log item by item.',
    '- Example: "2 huevos y una tostada al desayuno" → log_meal({items:[{query:"egg", quantity:2, unit:"unit", kcal_estimate:150, meal:"breakfast"}, {query:"toast", quantity:1, unit:"slice", kcal_estimate:80, meal:"breakfast"}]}) → reply with the logged items and meal_totals ("Desayuno: 3 items, 420 kcal").',
    '- "ambiguous": ask the user to choose (name, serving, kcal); log their pick with fitness_log_food using that option\'s draft_id, option, serving_index as serving and servings as quantity. "needs_confirmation" (> 800 kcal): call fitness_log_food with exactly log_with (the user gets an approval card).',
    '- Corrections ("no, eran 2"): fitness_modify_food with the new quantity. Other tasks: the matching fitness_* tool.',
  ],
};

export function buildInstructions(
  _timezone: string,
  _now: Date = new Date(),
  opts: { persona?: PersonaConfig; domains?: readonly Domain[] } = {},
): string {
  const persona = opts.persona ? personaPrompt(opts.persona) : '';
  const domains = opts.domains ?? ALL_DOMAINS;
  return [
    "You are the user's personal assistant on Telegram. Act on their apps with tools (finance_*, fitness_*).",
    '- Reply in the language of the user\'s latest message, including plan titles, even when tools return English. Short: a few lines, no filler.',
    '- Make independent tool calls in the SAME step (e.g. a meal and an expense in one message), then reply once.',
    '- NEVER say something was recorded, saved, logged, updated or deleted unless a tool call in this turn returned success. If an app is not connected, say so and show what you would record.',
    '- Never invent data a tool did not return. On {"error":{code,message,retryable}}, say what failed in one line and whether a retry may help.',
    '- Batch approvals: 2 or more approval-gated actions (deletes, fitness_modify_food, fitness_clear_food_pin, finance_delete_movement, anything destructive) → read what you need, then call propose_plan ONCE with every action (exact tool names and args; sections per meal or account; one "Item — kcal" / "Description — amount currency — account" line each), reply one line and stop. The hub runs exactly those calls after the user approves and sends you the results to summarize. Revisions: call propose_plan again with the full plan. A single gated action uses the normal approval card.',
    '- Photos are usually receipts or meals. "[voice note] …" is the transcript of the user\'s voice note: treat it as their request. Read amounts, dates and items carefully and state any assumption.',
    ...(persona ? ['', persona] : []),
    ...ALL_DOMAINS.filter((d) => domains.includes(d)).flatMap((d) => ['', ...DOMAIN_RULES[d]]),
  ].join('\n');
}

/**
 * The parts of the prompt that change: kept at the END so everything before them (and the
 * tool list) is a byte-identical prefix that Gemini's implicit cache can reuse. Hour precision.
 */
export function dynamicContext(timezone: string, now: Date = new Date(), statusNote = '', language?: string): string {
  const { stamp, weekday } = localTime(timezone, now);
  const lang = languageName(language);
  return [
    '## Now',
    `Local time: ${weekday} ${stamp.slice(0, 13)}h (${timezone}). Resolve relative dates ("ayer", "last Friday") and the likely meal from it.`,
    lang ? `The user spoke a voice note in ${lang}: reply in ${lang}.` : '',
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
  extraInstructions?: () => string | Promise<string>;
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
    instructions: async () =>
      [
        buildInstructions(opts.timezone, new Date(), { persona: opts.persona, domains: usageContext.getStore()?.domains }),
        '',
        dynamicContext(opts.timezone, new Date(opts.now?.() ?? Date.now()), (await opts.extraInstructions?.()) ?? '', usageContext.getStore()?.language),
      ].join('\n'),
    model: opts.model as never,
    tools: (opts.tools ?? {}) as never,
    ...(opts.memory ? { memory: opts.memory } : {}),
    inputProcessors: [...(opts.inputGuards ?? []), ...(opts.guards ?? [])],
    outputProcessors: [...(opts.guards ?? []), ...(opts.outputGuards ?? [])],
    maxProcessorRetries: 2,
  });
}
