import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpToolbox } from '../src/mcp/toolbox.js';
import { parseRegistry } from '../src/mcp/registry.js';
import { startEchoServer } from '../stub/echo-server.js';
import { createHub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel, lastToolResult } from './support/scripted-model.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function echo(opts?: { requireToken?: string }) {
  const s = await startEchoServer(0, '127.0.0.1', opts);
  closers.push(s.close);
  return s;
}

/** A port with nothing listening. */
async function deadUrl() {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return `http://127.0.0.1:${port}/mcp`;
}

function toolbox(servers: Record<string, unknown>, env: Record<string, string> = {}) {
  const tb = new McpToolbox(parseRegistry({ servers }), env, { log: () => {}, perServerTimeoutMs: 3_000 });
  closers.push(() => tb.close());
  return tb;
}

describe('McpToolbox', () => {
  it('exposes server tools with a single app prefix (echo_say, not echo_echo_say)', async () => {
    const s = await echo();
    const tools = await toolbox({ echo: { url: s.url } }).getTools();
    expect(Object.keys(tools).sort()).toEqual(['echo_delete', 'echo_fail', 'echo_say']);
  });

  it('prefixes un-prefixed tool names with the server name', async () => {
    const s = await echo();
    const tools = await toolbox({ demo: { url: s.url } }).getTools();
    expect(Object.keys(tools).sort()).toEqual(['demo_echo_delete', 'demo_echo_fail', 'demo_echo_say']);
  });

  it('keeps working when a server is down and reports which one', async () => {
    const s = await echo();
    const tb = toolbox({ echo: { url: s.url }, fitness: { url: await deadUrl() } });
    const tools = await tb.getTools();
    expect(Object.keys(tools)).toContain('echo_say');
    expect(tb.status().fitness).toMatchObject({ state: 'down' });
    expect(tb.status().echo).toMatchObject({ state: 'up', tools: 3 });
    expect(tb.statusNote()).toMatch(/fitness/);
  });

  it('skips servers with placeholder urls or missing secrets, without connecting', async () => {
    const tb = toolbox({
      finance: { url: '${FINANCE_MCP_URL}', headers: { Authorization: { env: 'FINANCE_MCP_TOKEN', prefix: 'Bearer ' } } },
      off: { url: 'http://127.0.0.1:1/mcp', enabled: false },
    }, { FINANCE_MCP_URL: 'https://finance.example.com/mcp', FINANCE_MCP_TOKEN: 'CHANGEME' });
    expect(await tb.getTools()).toEqual({});
    expect(tb.status().finance).toMatchObject({ state: 'skipped', reason: expect.stringMatching(/FINANCE_MCP_TOKEN/) });
    expect(tb.status().off).toMatchObject({ state: 'skipped', reason: 'disabled' });
  });

  it('sends auth headers resolved from env', async () => {
    const s = await echo({ requireToken: 'Bearer s3cret' });
    const ok = await toolbox({ echo: { url: s.url, headers: { Authorization: { env: 'TOK', prefix: 'Bearer ' } } } }, { TOK: 's3cret' }).getTools();
    expect(Object.keys(ok)).toContain('echo_say');
    const bad = toolbox({ echo: { url: s.url, headers: { Authorization: { env: 'TOK', prefix: 'Bearer ' } } } }, { TOK: 'wrong' });
    expect(await bad.getTools()).toEqual({});
    expect(bad.status().echo!.state).toBe('down');
  });

  it('returns plain JSON results and passes the shared error shape through', async () => {
    const s = await echo();
    const tools = await toolbox({ echo: { url: s.url } }).getTools();
    const exec = (name: string, input: unknown) => (tools[name] as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute(input, {});
    expect(await exec('echo_say', { text: 'hola' })).toEqual({ echoed: 'hola' });
    expect(await exec('echo_fail', { reason: 'nope' })).toEqual({ error: { code: 'ECHO_FAILED', message: 'nope', retryable: true } });
  });

  it('turns a server dying mid-call into a retryable shared error', async () => {
    const s = await echo();
    const tools = await toolbox({ echo: { url: s.url } }).getTools();
    await s.close();
    const res = await (tools.echo_say as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute({ text: 'x' }, {});
    expect(res).toMatchObject({ error: { code: 'MCP_UNAVAILABLE', retryable: true } });
  });

  it('rediscovers a server that comes back, on the next call after the on-demand gap', async () => {
    let now = 0;
    const url = await deadUrl();
    const port = Number(new URL(url).port);
    const tb = new McpToolbox(parseRegistry({ servers: { echo: { url } } }), {}, { log: () => {}, now: () => now, perServerTimeoutMs: 3_000 });
    closers.push(() => tb.close());
    expect(await tb.getTools()).toEqual({});
    const s = await startEchoServer(port);
    closers.push(s.close);
    now = 5_000;
    expect(await tb.getTools()).toEqual({}); // last attempt too recent: no hammering
    now = 16_000;
    expect(Object.keys(await tb.getTools())).toContain('echo_say');
  });
});

describe('agent + MCP', () => {
  it('"echo hello" goes through MCP and comes back', async () => {
    const s = await echo();
    const { model } = scriptedModel([{ tool: 'echo_say', args: { text: 'hello' } }, (p) => ({ text: `MCP said ${lastToolResult(p)}` })]);
    const hub = createHub(testConfig(), { model: model as never, registry: { servers: { echo: { url: s.url } } } });
    closers.push(() => hub.stop());
    const res = await hub.mastra.getAgentById('assistant').generate('echo hello');
    expect(res.text).toContain('hello');
    expect(res.text).toContain('MCP said');
  });

  it('tells the agent which apps are unavailable', async () => {
    const hub = createHub(testConfig(), {
      model: scriptedModel([{ text: 'ok' }]).model as never,
      registry: { servers: { fitness: { url: await deadUrl() } } },
    });
    closers.push(() => hub.stop());
    await hub.toolbox.getTools();
    const instructions = await hub.mastra.getAgentById('assistant').getInstructions();
    expect(JSON.stringify(instructions)).toMatch(/fitness.*unavailable/i);
  });
});
