import type { Agent } from '@mastra/core/agent';
import type { MessageListInput } from '@mastra/core/agent/message-list';
import { MODEL_IDS, withEscalation, type ModelRole } from '../models.js';

/** Model to use when escalating; defaults to the report model id. */
export type EscalationModel = unknown;

type Options = Record<string, unknown>;
type Generator = { generate(messages: MessageListInput, options: Options): ReturnType<Agent['generate']> };

/**
 * agent.generate() with escalation: a malformed function call or failed tool call on the
 * default model is retried once on the report model. Used by programmatic callers
 * (scheduled reports, scripts). Channel traffic gets provider-error fallback from the
 * agent's model chain.
 */
export async function generateWithEscalation(agent: Pick<Agent, 'generate'>, input: MessageListInput, options: Options = {}) {
  const gen = agent as unknown as Generator;
  return withEscalation((role: ModelRole) =>
    gen.generate(input, role === 'default' ? options : { ...options, model: MODEL_IDS[role] }),
  );
}
