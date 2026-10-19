import { describe, expect, it, vi } from 'vitest';
import { MODEL_IDS, PROVIDER_OPTIONS, createGeminiModels, modelChain, needsEscalation, withEscalation } from '../src/models.js';

describe('model roles', () => {
  it('maps roles to the approved Gemini models', () => {
    expect(MODEL_IDS).toEqual({
      default: 'google/gemini-3.5-flash-lite',
      vision: 'google/gemini-3.5-flash-lite',
      report: 'google/gemini-3.8-flash',
    });
  });

  it('never falls back to the stronger model on provider errors (single entry, retries in fetch)', () => {
    const models = createGeminiModels('k');
    const chain = modelChain('default', models);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ model: models.default, maxRetries: 0 });
    expect((models.default as { modelId: string }).modelId).toBe('gemini-3.5-flash-lite');
    expect((models.report as { modelId: string }).modelId).toBe('gemini-3.8-flash');
  });

  it('uses low thinking for the default role only', () => {
    const models = createGeminiModels('k');
    expect(modelChain('default', models)[0]!.providerOptions).toEqual({ google: { thinkingConfig: { thinkingLevel: 'low' } } });
    expect(modelChain('report', models)[0]!.providerOptions).toBeUndefined();
    expect(PROVIDER_OPTIONS.vision).toEqual(PROVIDER_OPTIONS.default);
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
