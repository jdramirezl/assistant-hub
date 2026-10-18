import { describe, expect, it, vi } from 'vitest';
import { generateWithEscalation } from '../src/agents/generate.js';
import { MODEL_IDS } from '../src/models.js';

describe('generateWithEscalation', () => {
  it('re-runs on the report model with the same options when the first run is malformed', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ text: '', finishReason: 'error', toolResults: [] })
      .mockResolvedValueOnce({ text: 'ok', finishReason: 'stop', toolResults: [] });
    const res = await generateWithEscalation({ generate } as never, 'hi', { maxSteps: 3 } as never);
    expect(res).toMatchObject({ text: 'ok', escalated: true });
    expect(generate.mock.calls[0]![1]).toEqual({ maxSteps: 3 });
    expect(generate.mock.calls[1]![1]).toEqual({ maxSteps: 3, model: MODEL_IDS.report });
  });
});
