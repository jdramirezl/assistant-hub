import { describe, expect, it, vi } from 'vitest';
import { MODEL_IDS, modelChain, needsEscalation, withEscalation } from '../src/models.js';

describe('model roles', () => {
  it('maps roles to the approved Gemini models', () => {
    expect(MODEL_IDS).toEqual({
      default: 'google/gemini-3.5-flash-lite',
      vision: 'google/gemini-3.5-flash-lite',
      report: 'google/gemini-3.8-flash',
    });
  });

  it('builds a provider-error fallback chain: cheap model first, stronger model second', () => {
    expect(modelChain('default').map((m) => m.model)).toEqual([MODEL_IDS.default, MODEL_IDS.report]);
    expect(modelChain('report').map((m) => m.model)).toEqual([MODEL_IDS.report]);
  });
});

describe('needsEscalation', () => {
  it('is false for a clean result', () => {
    expect(needsEscalation({ finishReason: 'stop', toolResults: [] })).toBe(false);
  });
  it('is true for a malformed function call (Gemini maps it to finishReason=error)', () => {
    expect(needsEscalation({ finishReason: 'error', toolResults: [] })).toBe(true);
  });
  it('is true when a tool returned the shared error shape and it is not retryable-by-user', () => {
    const toolResults = [{ payload: { result: { error: { code: 'BAD_ARGS', message: 'x', retryable: false } } } }];
    expect(needsEscalation({ finishReason: 'stop', toolResults })).toBe(true);
  });
  it('is true when a tool call threw', () => {
    expect(needsEscalation({ finishReason: 'stop', toolResults: [{ payload: { isError: true } }] })).toBe(true);
  });
});

describe('withEscalation', () => {
  it('returns the default-model result when it is fine', async () => {
    const run = vi.fn(async (role: string) => ({ role, finishReason: 'stop', toolResults: [] }));
    const res = await withEscalation(run);
    expect(res).toMatchObject({ role: 'default', escalated: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('retries once on the report model when the default result is bad', async () => {
    const run = vi.fn(async (role: string) => ({ role, finishReason: role === 'default' ? 'error' : 'stop', toolResults: [] }));
    const res = await withEscalation(run);
    expect(res).toMatchObject({ role: 'report', escalated: true });
    expect(run.mock.calls.map((c) => c[0])).toEqual(['default', 'report']);
  });

  it('retries on the report model when the default run throws', async () => {
    const run = vi.fn(async (role: string) => {
      if (role === 'default') throw new Error('boom');
      return { role, finishReason: 'stop', toolResults: [] };
    });
    await expect(withEscalation(run)).resolves.toMatchObject({ role: 'report', escalated: true });
  });

  it('does not loop: a bad escalated result is returned as-is', async () => {
    const run = vi.fn(async (role: string) => ({ role, finishReason: 'error', toolResults: [] }));
    const res = await withEscalation(run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ role: 'report', escalated: true });
  });
});
