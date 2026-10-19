/** Shared cross-track error shape: {"error":{"code","message","retryable"}}. */
export interface SharedError {
  error: { code: string; message: string; retryable: boolean };
}

export function sharedError(code: string, message: string, retryable: boolean): SharedError {
  return { error: { code, message, retryable } };
}

/** How a server reports tool failures, and how to map them to the shared shape. */
export type ErrorStyle = 'default' | 'mason';

const clip = (s: string) => s.trim().replace(/^Error:\s*/i, '').slice(0, 300);

/**
 * Mason (MyFitnessPal MCP) reports failures as plain `isError` text. Map it to MFP_* codes.
 * Order matters: connectivity, then blocking, then auth/session, then bad input.
 */
export function masonError(text: string): SharedError {
  const t = clip(text);
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|unreachable|socket hang up|timed? ?out|\b50[234]\b/i.test(t)) {
    return sharedError('MFP_UNAVAILABLE', t, true);
  }
  if (/\b403\b|forbidden|cloudflare|blocked|captcha/i.test(t)) return sharedError('MFP_BLOCKED', t, false);
  if (/session|re-?auth|log ?in|login|unauthori[sz]ed|\b401\b|mfp-mcp auth/i.test(t)) {
    return sharedError('MFP_SESSION_EXPIRED', t, false);
  }
  if (/unknown|invalid|not found|no draft option|no .* match|no .*found|must be|is required|missing/i.test(t)) {
    return sharedError('MFP_BAD_REQUEST', t, false);
  }
  return sharedError('MFP_ERROR', t, false);
}

/** Map an isError text payload (non-shared shape) for a server's error style. */
export function mapToolErrorText(style: ErrorStyle, text: string): SharedError {
  return style === 'mason' ? masonError(text) : sharedError('TOOL_ERROR', clip(text), false);
}

/** Map a transport failure (server unreachable mid-call) for a server's error style. */
export function unavailableError(style: ErrorStyle, server: string, reason: string): SharedError {
  return style === 'mason'
    ? sharedError('MFP_UNAVAILABLE', `MyFitnessPal (Mason) is unreachable: ${reason}`, true)
    : sharedError('MCP_UNAVAILABLE', `${server} is unreachable: ${reason}`, true);
}
