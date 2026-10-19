import { describe, expect, it } from 'vitest';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { buildInstructions, createAssistantAgent, dynamicContext } from '../src/agents/assistant.js';

describe('assistant agent', () => {
  it('instructions are bilingual and concise; the time lives in a separate, hour-precision tail', () => {
    const text = buildInstructions('America/Bogota', new Date('2026-10-18T22:00:00Z'));
    expect(text).toMatch(/language of the user's latest message/);
    expect(text).toMatch(/Short: a few lines/);
    expect(text).not.toMatch(/2026-10-18/);
    const tail = dynamicContext('America/Bogota', new Date('2026-10-18T22:07:00Z'), 'mfp is down');
    expect(tail).toContain('Sunday 2026-10-18 17h (America/Bogota)'); // UTC-5, no minutes
    expect(tail).toContain('mfp is down');
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

describe('honesty rules', () => {
  it('forbids claiming writes without a successful tool call; records stay out of working memory', async () => {
    const text = buildInstructions('America/Bogota');
    expect(text).toMatch(/NEVER say something was recorded, saved, logged, updated or deleted unless a tool call in this turn returned success/);
    expect(text).toMatch(/not connected/);
    expect(text).toMatch(/Never invent data/);
    const { workingMemoryInstruction } = await import('../src/memory.js');
    expect(workingMemoryInstruction(null)).toMatch(/Never store transactions, meals or other records/);
  });
});
