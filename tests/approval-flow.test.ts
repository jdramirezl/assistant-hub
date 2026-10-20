import { afterEach, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { callbackUpdate, findButton, MockTelegram, textUpdate } from './support/mock-telegram.js';
import { scriptedModel, lastToolResult } from './support/scripted-model.js';
import { startEchoServer, wasDeleted } from '../stub/echo-server.js';

const ME = 42;
const FAST = { timeout: 0, retryDelayMs: 50 };
let tg: MockTelegram;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  tg = await new MockTelegram().start();
  cleanups.push(() => tg.stop());
  const echo = await startEchoServer();
  cleanups.push(echo.close);
  return { echo, env: { TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME) } };
}

function hubFor(env: Record<string, string>, echoUrl: string, dataDir?: string) {
  const { model } = scriptedModel([
    (p) => (lastToolResult(p) === 'none' ? { tool: 'echo_delete', args: { id: env.ITEM! } } : { text: `resultado ${lastToolResult(p)}` }),
    (p) => ({ text: `resultado ${lastToolResult(p)}` }),
  ]);
  const cfg = testConfig({ ...env, ...(dataDir ? { HUB_DATA_DIR: dataDir } : {}) });
  const hub = createHub(cfg, {
    model: model as never,
    registry: { servers: { echo: { url: echoUrl } } },
    telegram: { apiBaseUrl: tg.url, longPolling: FAST, log: () => {} },
  });
  cleanups.push(() => hub.stop());
  return { hub, cfg };
}

async function askDelete(hub: Hub, item: string) {
  await hub.start();
  tg.push(textUpdate(ME, `borra ${item}`));
  await tg.waitFor(() => !!findButton(tg, 'tool_approve:'));
  expect(wasDeleted(item)).toBe(false); // nothing ran yet
}

describe('approval cards', () => {
  it('a destructive tool shows Approve/Deny and runs only after Approve', async () => {
    const { echo, env } = await setup();
    const { hub } = hubFor({ ...env, ITEM: 'a-1' }, echo.url);
    await askDelete(hub, 'a-1');
    expect(tg.outgoingText(ME)).toMatch(/🗑️ Borrar el movimiento|Acción en echo que requiere su aprobación/);
    const btn = findButton(tg, 'tool_approve:')!;
    tg.push(callbackUpdate(ME, { message_id: btn.messageId }, btn.data));
    await tg.waitFor(() => wasDeleted('a-1'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('resultado'));
  });

  it('Deny skips the tool', async () => {
    const { echo, env } = await setup();
    const { hub } = hubFor({ ...env, ITEM: 'b-1' }, echo.url);
    await askDelete(hub, 'b-1');
    const btn = findButton(tg, 'tool_deny:')!;
    const before = tg.calls.length;
    tg.push(callbackUpdate(ME, { message_id: btn.messageId }, btn.data));
    await tg.waitFor(() => tg.calls.slice(before).some((c) => c.method === 'editMessageText' || c.method === 'sendMessage'));
    await new Promise((r) => setTimeout(r, 500));
    expect(wasDeleted('b-1')).toBe(false);
  });

  it('a stranger cannot press the button', async () => {
    const { echo, env } = await setup();
    const { hub } = hubFor({ ...env, ITEM: 'c-1' }, echo.url);
    await askDelete(hub, 'c-1');
    const btn = findButton(tg, 'tool_approve:')!;
    tg.push(callbackUpdate(666, { message_id: btn.messageId }, btn.data));
    await new Promise((r) => setTimeout(r, 800));
    expect(wasDeleted('c-1')).toBe(false);
  });

  it('a pending approval survives a restart', async () => {
    const { echo, env } = await setup();
    const first = hubFor({ ...env, ITEM: 'd-1' }, echo.url);
    await askDelete(first.hub, 'd-1');
    const btn = findButton(tg, 'tool_approve:')!;
    await first.hub.stop();

    const second = hubFor({ ...env, ITEM: 'd-1' }, echo.url, first.cfg.dataDir);
    await second.hub.start();
    tg.push(callbackUpdate(ME, { message_id: btn.messageId }, btn.data));
    await tg.waitFor(() => wasDeleted('d-1'));
  });

  it('read-only tools run without asking', async () => {
    const { echo, env } = await setup();
    const { model } = scriptedModel([{ tool: 'echo_say', args: { text: 'hola' } }, (p) => ({ text: `dijo ${lastToolResult(p)}` })]);
    const hub = createHub(testConfig(env), {
      model: model as never,
      registry: { servers: { echo: { url: echo.url } } },
      telegram: { apiBaseUrl: tg.url, longPolling: FAST, log: () => {} },
    });
    cleanups.push(() => hub.stop());
    await hub.start();
    tg.push(textUpdate(ME, 'echo hola'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('dijo'));
    expect(findButton(tg, 'tool_approve:')).toBeUndefined();
  });
});

describe('approval via the agent API (what Studio uses)', () => {
  it('suspends on echo_delete and runs it after approveToolCallGenerate', async () => {
    const echo = await startEchoServer();
    cleanups.push(echo.close);
    const { model } = scriptedModel([{ tool: 'echo_delete', args: { id: 'api-1' } }, (p) => ({ text: `ok ${lastToolResult(p)}` })]);
    const hub = createHub(testConfig(), { model: model as never, registry: { servers: { echo: { url: echo.url } } } });
    cleanups.push(() => hub.stop());
    const agent = hub.mastra.getAgentById('assistant');
    const memory = { thread: 'studio-1', resource: 'dev:local' };
    const first = await agent.generate('borra api-1', { memory });
    expect(first.finishReason).toBe('suspended');
    expect(wasDeleted('api-1')).toBe(false);
    const resumed = await agent.approveToolCallGenerate({ runId: first.runId!, memory } as never);
    expect(wasDeleted('api-1')).toBe(true);
    expect(resumed.text).toContain('api-1');
  });
});
