import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createHub, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel, lastToolResult } from './support/scripted-model.js';
import { MFP_REGISTRY, startFakeMason, type FakeMason } from './support/fake-mason.js';
import { withUsageScope } from '../src/telemetry/context.js';
import { fixHistory } from '../src/guards/address.js';
import type { Domain } from '../src/telemetry/intent.js';

const PROFILE = join(import.meta.dirname, '..', 'docs', 'nutrition-profile.example.json');
const sys = (prompt: unknown[]) => (prompt as { role: string; content: unknown }[]).filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');

describe('nutrition brain in the hub', () => {
  let mason: FakeMason | undefined;
  const hubs: Hub[] = [];
  afterEach(async () => {
    await Promise.all(hubs.splice(0).map((h) => h.stop()));
    await mason?.close();
    mason = undefined;
  });
  async function ask(text: string, script: Parameters<typeof scriptedModel>[0], opts: { domains?: Domain[]; profile?: boolean; thread?: string; hub?: Hub } = {}) {
    mason ??= await startFakeMason();
    const sm = scriptedModel(script);
    const hub = opts.hub ?? createHub(testConfig(opts.profile === false ? {} : { NUTRITION_PROFILE_PATH: PROFILE }), { model: sm.model as never, registry: MFP_REGISTRY(mason.url), localNow: () => Date.parse('2026-10-21T15:00:00Z') });
    if (!opts.hub) hubs.push(hub);
    const res = await withUsageScope({ requestId: 'r', intent: 'meal', media: 'text', kind: 'chat', domains: opts.domains ?? ['fitness'], text }, () =>
      hub.mastra.getAgentById('assistant').generate(text, { memory: { thread: opts.thread ?? 't', resource: 'dev:local' } }),
    );
    return { res, calls: sm.calls, hub };
  }

  it('fitness requests get the style rules, the dictionary and today\'s targets; long context only when asked', async () => {
    const { calls } = await ask('¿me cabe un Cornetto?', [{ text: 'Sí.' }]);
    const s = sys(calls[0]!.prompt);
    expect(s).toMatch(/## Nutrition style/);
    expect(s).toMatch(/Cornetto Chocolate[^;]*: 208 kcal/);
    expect(s).toMatch(/Day targets: rest ~2000 kcal/);
    expect(s).toMatch(/usually a gimnasia/); // Wednesday in the example schedule: a hint
    expect(s).not.toMatch(/Nutrition context/);
    expect(calls[0]!.tools).toEqual(expect.arrayContaining(['log_meal', 'save_food', 'set_day_type']));
    const plan = await ask('¿qué ceno hoy?', [{ text: 'Una sopa.' }]);
    expect(sys(plan.calls[0]!.prompt)).toMatch(/## Nutrition context[\s\S]*### preferences/);
  });

  it('other domains and a hub without a profile: no nutrition prompt, no extra tools', async () => {
    const cines = await ask('hola', [{ text: 'Hola.' }], { domains: ['finance'] });
    expect(sys(cines.calls[0]!.prompt)).not.toMatch(/Nutrition style|Day targets/);
    const off = await ask('almorcé arroz', [{ text: 'ok' }], { profile: false });
    expect(sys(off.calls[0]!.prompt)).not.toMatch(/Nutrition style|Day targets/);
    expect(off.calls[0]!.tools).not.toContain('save_food');
  });

  it('"hoy tengo gimnasia" is remembered for today without a tool call; set_day_type works too', async () => {
    mason = await startFakeMason();
    let seen = '';
    const sm = scriptedModel([{ text: 'ok' }, { tool: 'set_day_type', args: { type: 'rest' } }, (p) => ((seen = lastToolResult(p)), { text: 'ok' })]);
    const hub = createHub(testConfig({ NUTRITION_PROFILE_PATH: PROFILE }), { model: sm.model as never, registry: MFP_REGISTRY(mason.url), localNow: () => Date.parse('2026-10-21T15:00:00Z') });
    hubs.push(hub);
    const say = (text: string) => withUsageScope({ requestId: 'r', intent: 'meal', media: 'text', kind: 'chat', domains: ['fitness'], text }, () => hub.mastra.getAgentById('assistant').generate(text, { memory: { thread: 't', resource: 'dev:local' } }));
    await say('hoy tengo gimnasia, ¿cuánto me queda?');
    expect(sys(sm.calls[0]!.prompt)).toMatch(/Today is a gimnasia \(gymnastics training\) \(the user said so\)/);
    await say('no, al final descanso');
    expect(JSON.parse(seen).value).toMatchObject({ day_type: 'rest', target_kcal: 2000 });
    await say('¿y ahora?');
    expect(sys(sm.calls.at(-1)!.prompt)).toMatch(/Today is a rest day \(the user said so\)/);
  });

  it('"Amo Julián" from older replies is rewritten before the model sees it, and in the reply', async () => {
    const { res } = await ask('hola', [{ text: 'Amo Julián, a su servicio.' }], { domains: ['finance'] });
    expect(res.text).toBe('Master Julian, a su servicio.');
    const fixed = fixHistory([{ role: 'user', content: [{ type: 'text', text: 'Amo Julián dice el bot' }] }, { role: 'assistant', content: [{ type: 'text', text: 'Amo Julián, he registrado…' }] }], 'Master Julian');
    expect(JSON.stringify(fixed)).toContain('Amo Julián dice el bot'); // user text untouched
    expect(JSON.stringify(fixed[1])).toContain('Master Julian, he registrado');
  });
});
