import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createRateLimitedFetch } from './llm/rate-limit.js';

/**
 * Model roles. Gemini only, one GOOGLE_API_KEY.
 *  - default / vision: cheap multimodal model for chat, tool calls, receipt photos and voice notes
 *  - report: stronger model for weekly reports and for escalation on a bad (malformed) response
 */
export const MODEL_IDS = {
  default: 'google/gemini-3.5-flash-lite',
  vision: 'google/gemini-3.5-flash-lite',
  report: 'google/gemini-3.8-flash',
} as const;

export type ModelRole = keyof typeof MODEL_IDS;

/** Thinking is the main cost driver; chat/tool calls do fine with little of it. */
export const PROVIDER_OPTIONS: Record<ModelRole, Record<string, Record<string, unknown>> | undefined> = {
  default: { google: { thinkingConfig: { thinkingLevel: 'low' } } },
  vision: { google: { thinkingConfig: { thinkingLevel: 'low' } } },
  report: undefined,
};

export type ModelLike = unknown;
export type GeminiModels = Record<ModelRole, ModelLike>;

/**
 * Gemini models with the rate-limit-aware fetch: on 429 they wait and retry the SAME model.
 * There is deliberately no fallback to the stronger model on provider errors (its free-tier
 * quota is far smaller); escalation happens only on a bad response (see EscalationGuard).
 */
export function createGeminiModels(apiKey: string | undefined, log?: (m: string) => void): GeminiModels {
  const google = createGoogleGenerativeAI({ apiKey: apiKey ?? '', fetch: createRateLimitedFetch({ log }) });
  const make = (role: ModelRole) => google(MODEL_IDS[role].replace(/^google\//, ''));
  return { default: make('default'), vision: make('vision'), report: make('report') };
}

/** Agent model config for a role: a single entry, retries handled by the fetch layer. */
export function modelChain(role: ModelRole, models: GeminiModels): { model: ModelLike; maxRetries: number; providerOptions?: Record<string, Record<string, unknown>> }[] {
  const providerOptions = PROVIDER_OPTIONS[role];
  return [{ model: models[role], maxRetries: 0, ...(providerOptions ? { providerOptions } : {}) }];
}

interface ToolResultLike {
  payload?: { isError?: boolean; result?: unknown };
}
export interface ResultLike {
  finishReason?: string;
  toolResults?: ToolResultLike[];
}

function hasSharedErrorShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const err = (value as { error?: unknown }).error;
  return !!err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string';
}

/** True when a run produced a malformed function call or a failed tool call. */
export function needsEscalation(result: ResultLike): boolean {
  if (result.finishReason === 'error') return true; // @ai-sdk/google maps MALFORMED_FUNCTION_CALL → 'error'
  return (result.toolResults ?? []).some((t) => t.payload?.isError === true || hasSharedErrorShape(t.payload?.result));
}

/**
 * Run with the default model; if the result needs escalation (or the run throws), retry exactly
 * once with the report model. Never loops.
 */
export async function withEscalation<R extends ResultLike>(
  run: (role: ModelRole) => Promise<R>,
): Promise<R & { escalated: boolean }> {
  try {
    const first = await run('default');
    if (!needsEscalation(first)) return { ...first, escalated: false };
  } catch {
    // fall through to the stronger model
  }
  const second = await run('report');
  return { ...second, escalated: true };
}
