import { afterEach, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel } from './support/scripted-model.js';

const hubs: Hub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.stop()));
});

describe('escalation only on bad responses', () => {
  it('a malformed function call is retried once on the stronger model', async () => {
    const cheap = scriptedModel([{ malformed: true }, { text: 'cheap again' }]);
    const strong = scriptedModel([{ text: 'respuesta del modelo fuerte' }]);
    const hub = createHub(testConfig(), { model: cheap.model as never, escalationModel: strong.model, registry: { servers: {} } });
    hubs.push(hub);
    const res = await hub.mastra.getAgentById('assistant').generate('hola');
    expect(cheap.calls).toHaveLength(1);
    expect(strong.calls).toHaveLength(1);
    expect(res.text).toContain('modelo fuerte');
  });

  it('a normal response never touches the stronger model', async () => {
    const cheap = scriptedModel([{ text: 'ok' }]);
    const strong = scriptedModel([{ text: 'no' }]);
    const hub = createHub(testConfig(), { model: cheap.model as never, escalationModel: strong.model, registry: { servers: {} } });
    hubs.push(hub);
    expect((await hub.mastra.getAgentById('assistant').generate('hola')).text).toBe('ok');
    expect(strong.calls).toHaveLength(0);
  });
});
