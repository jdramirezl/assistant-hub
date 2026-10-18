import { describe, expect, it } from 'vitest';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { buildInstructions, createAssistantAgent } from '../src/agents/assistant.js';

describe('assistant agent', () => {
  it('instructions are bilingual, concise and carry the current Bogota time', () => {
    const text = buildInstructions('America/Bogota', new Date('2026-10-18T22:00:00Z'));
    expect(text).toMatch(/Spanish/);
    expect(text).toMatch(/English/);
    expect(text).toMatch(/concise|short/i);
    expect(text).toContain('America/Bogota');
    expect(text).toContain('2026-10-18 17:00'); // UTC-5
    expect(text).toContain('Sunday');
  });

  it('answers through the injected model', async () => {
    const agent = createAssistantAgent({
      timezone: 'America/Bogota',
      model: createMockModel({ mockText: 'hola!', version: 'v2' }) as never,
    });
    expect(agent.id).toBe('assistant');
    const res = await agent.generate('hola');
    expect(res.text).toBe('hola!');
  });
});
