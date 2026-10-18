/**
 * Model roles. Gemini only, one GOOGLE_API_KEY.
 *  - default / vision: cheap multimodal model for chat, tool calls, receipt photos and voice notes
 *  - report: stronger model for weekly reports and for escalation when the cheap model fails
 */
export const MODEL_IDS = {
  default: 'google/gemini-3.5-flash-lite',
  vision: 'google/gemini-3.5-flash-lite',
  report: 'google/gemini-3.8-flash',
} as const;

export type ModelRole = keyof typeof MODEL_IDS;

/**
 * Mastra model fallback chain for a role. Covers *thrown* provider errors (5xx, 429, timeouts):
 * Mastra moves to the next entry automatically. Content-level failures (malformed function
 * calls, tool errors) are handled by {@link withEscalation}.
 */
export function modelChain(role: ModelRole): { model: string; maxRetries: number }[] {
  const primary = { model: MODEL_IDS[role], maxRetries: 1 };
  return role === 'report' ? [primary] : [primary, { model: MODEL_IDS.report, maxRetries: 1 }];
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
