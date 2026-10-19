import { afterEach, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel } from './support/scripted-model.js';
import { MFP_REGISTRY, startFakeMason, type FakeMason } from './support/fake-mason.js';
import { workingMemoryInstruction } from '../src/memory.js';

const hubs: Hub[] = [];
let mason: FakeMason | undefined;
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.stop()));
  await mason?.close();
});

const systemOf = (prompt: unknown[]) =>
  (prompt as { role: string; content: unknown }[]).filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');

describe('stable prompt prefix (implicit caching)', () => {
  it('two messages minutes apart share a byte-identical system prefix and tool order', async () => {
    let now = Date.parse('2026-10-19T19:05:00Z');
    mason = await startFakeMason();
    const sm = scriptedModel([{ text: 'a' }, { text: 'b' }]);
    const hub = createHub(testConfig(), { model: sm.model as never, registry: MFP_REGISTRY(mason.url), now: () => now });
    hubs.push(hub);
    const agent = hub.mastra.getAgentById('assistant');
    await agent.generate('hola', { memory: { thread: 't', resource: 'dev:local' } });
    now += 37 * 60_000; // 14:05 → 14:42 Bogota, same hour
    await agent.generate('qué tal', { memory: { thread: 't', resource: 'dev:local' } });
    const [a, b] = sm.calls.map((c) => systemOf(c.prompt));
    expect(a).toBe(b);
    expect(sm.calls[0]!.tools).toEqual(sm.calls[1]!.tools);
    // the clock is in the tail, after all static rules
    const idx = a!.indexOf('## Now');
    expect(idx).toBeGreaterThan(a!.indexOf('Batch approvals'));
    expect(a).toMatch(/Local time: Monday 2026-10-19 14h/);
  });

  it('working-memory instruction is short and does not demand an update every response', async () => {
    mason = await startFakeMason();
    const sm = scriptedModel([{ text: 'a' }]);
    const hub = createHub(testConfig(), { model: sm.model as never, registry: MFP_REGISTRY(mason.url) });
    hubs.push(hub);
    await hub.mastra.getAgentById('assistant').generate('hola', { memory: { thread: 't', resource: 'dev:local' } });
    const sys = systemOf(sm.calls[0]!.prompt);
    expect(sys).not.toMatch(/in every response|If information might be referenced again/);
    expect(sys).toContain('Call updateWorkingMemory ONLY when the user states a new or changed durable preference');
    expect(sys.match(/# User preferences/g)).toHaveLength(1); // template once
    expect(workingMemoryInstruction(null).length).toBeLessThan(600);
    expect(sm.calls[0]!.tools).toContain('updateWorkingMemory'); // still able to save a stated preference
  });
});
