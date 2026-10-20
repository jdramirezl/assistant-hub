import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHub } from '../src/hub.js';
import { McpToolbox } from '../src/mcp/toolbox.js';
import { parseRegistry } from '../src/mcp/registry.js';
import { startEchoServer } from '../stub/echo-server.js';
import { testConfig } from './helpers.js';
import { scriptedModel } from './support/scripted-model.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

async function freePort() {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe('MCP reconnect', () => {
  it('a server that was down at boot is picked up on the next message, without a restart', async () => {
    let now = 1_000_000;
    const port = await freePort();
    const sm = scriptedModel(Array.from({ length: 6 }, () => ({ text: 'ok' })));
    const hub = createHub(testConfig(), {
      model: sm.model as never,
      registry: { servers: { echo: { url: `http://127.0.0.1:${port}/mcp` } } },
      now: () => now,
    });
    closers.push(() => hub.stop());
    await hub.start();
    expect(hub.toolbox.status().echo!.state).toBe('down');
    const agent = hub.mastra.getAgentById('assistant');
    await agent.generate('hola');
    expect(sm.calls.at(-1)!.tools).not.toContain('echo_say');

    const s = await startEchoServer(port);
    closers.push(s.close);
    now += 20_000; // next message, well before the background retry interval
    await agent.generate('echo hola');
    expect(sm.calls.at(-1)!.tools).toContain('echo_say');
    expect(hub.toolbox.status().echo).toMatchObject({ state: 'up' });
  });

  it('background retry reconnects with backoff and leaves healthy servers alone', async () => {
    let now = 0;
    const deadPort = await freePort();
    const live = await startEchoServer();
    closers.push(live.close);
    const recovered: { name: string; downMs: number }[] = [];
    const tb = new McpToolbox(
      parseRegistry({ servers: { echo: { url: live.url }, demo: { url: `http://127.0.0.1:${deadPort}/mcp` } } }),
      {},
      { log: () => {}, now: () => now, onRecovered: (name, downMs) => void recovered.push({ name, downMs }) },
    );
    closers.push(() => tb.close());
    await tb.getTools();
    const echoBefore = (await tb.getTools()).echo_say;
    expect(tb.status().demo!.state).toBe('down');

    now = 30_000;
    await tb.tick();
    expect(tb.retryInfo().demo!.attempts).toBe(1); // not due yet (first retry at 60 s)

    now = 61_000;
    await tb.tick();
    expect(tb.retryInfo().demo!.attempts).toBe(2);
    const nextDelay = tb.retryInfo().demo!.nextAt - now;
    expect(nextDelay).toBeGreaterThan(60_000); // backoff grows

    const back = await startEchoServer(deadPort);
    closers.push(back.close);
    now = 61_000 + nextDelay;
    await tb.tick();
    expect(tb.status().demo).toMatchObject({ state: 'up', tools: 3 });
    expect(Object.keys(await tb.getTools())).toEqual(expect.arrayContaining(['demo_echo_say', 'echo_say']));
    expect((await tb.getTools()).echo_say).toBe(echoBefore); // echo was not reconnected
    expect(recovered).toEqual([{ name: 'demo', downMs: now }]);
  });

  it('hub notifies once when an app comes back after >10 min down', async () => {
    let now = 0;
    const port = await freePort();
    const logs: string[] = [];
    const hub = createHub(testConfig(), {
      registry: { servers: { echo: { url: `http://127.0.0.1:${port}/mcp` } } },
      now: () => now,
      telegram: { log: (m) => logs.push(m) },
    });
    closers.push(() => hub.stop());
    await hub.start();
    const s = await startEchoServer(port);
    closers.push(s.close);
    now = 11 * 60_000;
    await hub.toolbox.tick();
    expect(logs.join('\n')).toMatch(/\[notify\] .*🔌 echo volvió, Master Julian \(estuvo fuera \d+ min\)/);
  });
});
