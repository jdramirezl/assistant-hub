import { afterEach, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../src/hub.js';
import { BUDGET_MESSAGE } from '../src/budget.js';
import { testConfig } from './helpers.js';
import { scriptedModel } from './support/scripted-model.js';
import { MockTelegram, textUpdate } from './support/mock-telegram.js';

const hubs: Hub[] = [];
let tg: MockTelegram | undefined;
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.stop()));
  await tg?.stop();
  tg = undefined;
});

// scriptedModel reports 15 tokens per call.
function boot(env: Record<string, string>, now?: () => number, telegramUrl?: string) {
  const sm = scriptedModel(Array.from({ length: 10 }, (_, i) => ({ text: `respuesta ${i}` })));
  const hub = createHub(testConfig(env), {
    model: sm.model as never,
    registry: { servers: {} },
    now,
    telegram: telegramUrl ? { apiBaseUrl: telegramUrl, longPolling: { timeout: 0, retryDelayMs: 50 }, log: () => {} } : { log: () => {} },
  });
  hubs.push(hub);
  return { hub, calls: sm.calls };
}

describe('daily budget cap', () => {
  it('counts usage and stops calling the model once the cap is hit', async () => {
    const { hub, calls } = boot({ DAILY_TOKEN_CAP: '20' });
    const agent = hub.mastra.getAgentById('assistant');

    const first = await agent.generate('hola');
    expect(first.text).toBe('respuesta 0');
    expect((await hub.budget.check()).tokens).toBe(15);

    await agent.generate('otra'); // 30 tokens now, over the cap
    const blocked = await agent.generate('una más');
    expect(calls).toHaveLength(2); // third call never reached the model
    expect(JSON.stringify(blocked)).toContain('Paused, budget hit');
  });

  it('resets after Bogota midnight', async () => {
    let now = Date.parse('2026-10-19T04:30:00Z'); // 23:30 Bogota
    const { hub, calls } = boot({ DAILY_TOKEN_CAP: '10' }, () => now);
    const agent = hub.mastra.getAgentById('assistant');
    await agent.generate('hola'); // 15 > 10
    await agent.generate('bloqueado');
    expect(calls).toHaveLength(1);
    now = Date.parse('2026-10-19T05:30:00Z'); // 00:30 Bogota, next day
    const res = await agent.generate('nuevo día');
    expect(calls).toHaveLength(2);
    expect(res.text).toBe('respuesta 1');
  });

  it('tells the Telegram user "paused, budget hit"', async () => {
    tg = await new MockTelegram().start();
    const { hub, calls } = boot({ DAILY_TOKEN_CAP: '10', TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: '42' }, undefined, tg.url);
    await hub.start();
    tg.push(textUpdate(42, 'hola'));
    await tg.waitFor(() => tg!.outgoingText(42).includes('respuesta 0'));
    tg.push(textUpdate(42, 'otra vez'));
    await tg.waitFor(() => tg!.outgoingText(42).includes(BUDGET_MESSAGE.slice(0, 20)));
    expect(calls).toHaveLength(1);
  });
});
