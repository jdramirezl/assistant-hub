import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { McpToolbox } from '../src/mcp/toolbox.js';
import { parseRegistry } from '../src/mcp/registry.js';
import { masonError } from '../src/mcp/errors.js';
import { requiresApproval } from '../src/approvals.js';
import { createHub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel, lastToolResult } from './support/scripted-model.js';

/** Minimal stand-in for Mason: fitness_* tools, failures reported as MCP isError text. */
async function fakeMason() {
  const failWith = (msg: string) => async () => {
    throw new Error(msg);
  };
  const tool = (id: string, execute: () => Promise<unknown>, readOnly = false) =>
    createTool({ id, description: id, inputSchema: z.object({}).passthrough(), mcp: { annotations: { readOnlyHint: readOnly } }, execute });
  const tools = {
    fitness_log_food: createTool({
      id: 'fitness_log_food',
      description: 'Log a food to the MyFitnessPal diary',
      inputSchema: z.object({ food: z.string(), meal: z.string() }),
      execute: async ({ food, meal }) => ({ logged: food, meal }),
    }),
    fitness_get_diary: tool('fitness_get_diary', async () => ({ calories: 1800 }), true),
    fitness_modify_food: tool('fitness_modify_food', async () => ({ ok: true })),
    fitness_expired: tool('fitness_expired', failWith('Session expired: auto-refresh failed. Run `mfp-mcp auth` to log in again.')),
    fitness_blocked: tool('fitness_blocked', failWith('HTTP 403 Forbidden (Cloudflare challenge)')),
    fitness_badmeal: tool('fitness_badmeal', failWith("Unknown meal 'brunch'. Valid meals: Breakfast, Lunch, Dinner, Snacks")),
    fitness_weird: tool('fitness_weird', failWith('something unexpected happened')),
  };
  const mcp = new MCPServer({ id: 'mason', name: 'mason', version: '0.0.0-test', tools });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void mcp.startHTTP({ url, httpPath: '/mcp', req, res });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return {
    url,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const MFP_ENTRY = (url: string) => ({ url, toolPrefix: 'fitness', errorStyle: 'mason' });

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

type Exec = { execute: (i: unknown, c: unknown) => Promise<unknown> };

describe('masonError mapping', () => {
  it.each([
    ['fetch failed: connect ECONNREFUSED 127.0.0.1:8484', 'MFP_UNAVAILABLE', true],
    ['Session expired: auto-refresh failed. Run `mfp-mcp auth`', 'MFP_SESSION_EXPIRED', false],
    ['Retrying with a refreshed session... login required', 'MFP_SESSION_EXPIRED', false],
    ['HTTP 403 Forbidden', 'MFP_BLOCKED', false],
    ['Blocked by Cloudflare', 'MFP_BLOCKED', false],
    ["Unknown meal 'brunch'", 'MFP_BAD_REQUEST', false],
    ['No draft option matches "arepa"', 'MFP_BAD_REQUEST', false],
    ['something unexpected happened', 'MFP_ERROR', false],
  ])('%s → %s', (text, code, retryable) => {
    expect(masonError(text)).toEqual({ error: { code, message: expect.stringContaining(text.slice(0, 15)), retryable } });
  });
});

describe('Mason (mfp) through the toolbox', () => {
  function toolbox(url: string) {
    const tb = new McpToolbox(parseRegistry({ servers: { mfp: MFP_ENTRY(url) } }), {}, { log: () => {} });
    closers.push(() => tb.close());
    return tb;
  }

  it('keeps Mason tool names as fitness_* (no mfp_ prefix)', async () => {
    const m = await fakeMason();
    closers.push(m.close);
    const tools = await toolbox(m.url).getTools();
    expect(Object.keys(tools)).toContain('fitness_log_food');
    expect(Object.keys(tools).some((n) => n.startsWith('mfp_'))).toBe(false);
  });

  it('normalizes Mason isError text into the shared error shape with MFP codes', async () => {
    const m = await fakeMason();
    closers.push(m.close);
    const tools = await toolbox(m.url).getTools();
    const run = (n: string) => (tools[n] as unknown as Exec).execute({}, {});
    expect(await run('fitness_expired')).toMatchObject({ error: { code: 'MFP_SESSION_EXPIRED', retryable: false } });
    expect(await run('fitness_blocked')).toMatchObject({ error: { code: 'MFP_BLOCKED', retryable: false } });
    expect(await run('fitness_badmeal')).toMatchObject({ error: { code: 'MFP_BAD_REQUEST', retryable: false } });
    expect(await run('fitness_weird')).toMatchObject({ error: { code: 'MFP_ERROR', retryable: false } });
    expect(await run('fitness_get_diary')).toEqual({ calories: 1800 });
  });

  it('reports MFP_UNAVAILABLE (retryable) when Mason dies mid-session', async () => {
    const m = await fakeMason();
    const tools = await toolbox(m.url).getTools();
    await m.close();
    const res = await (tools.fitness_get_diary as unknown as Exec).execute({}, {});
    expect(res).toMatchObject({ error: { code: 'MFP_UNAVAILABLE', retryable: true } });
  });

  it('end to end: "log 2 eggs for breakfast" → fitness_log_food, no approval', async () => {
    const m = await fakeMason();
    closers.push(m.close);
    const { model, calls } = scriptedModel([
      { tool: 'fitness_log_food', args: { food: '2 eggs', meal: 'Breakfast' } },
      (p) => ({ text: `listo ${lastToolResult(p)}` }),
    ]);
    const hub = createHub(testConfig(), { model: model as never, registry: { servers: { mfp: MFP_ENTRY(m.url) } } });
    closers.push(() => hub.stop());
    const res = await hub.mastra.getAgentById('assistant').generate('log 2 eggs for breakfast');
    expect(calls).toHaveLength(2);
    expect(res.text).toContain('2 eggs');
    expect(res.finishReason).not.toBe('suspended');
  });

  it('fitness_modify_food is gated behind approval', async () => {
    const m = await fakeMason();
    closers.push(m.close);
    const { model } = scriptedModel([{ tool: 'fitness_modify_food', args: { id: 'e1' } }]);
    const hub = createHub(testConfig(), { model: model as never, registry: { servers: { mfp: MFP_ENTRY(m.url) } } });
    closers.push(() => hub.stop());
    const res = await hub.mastra.getAgentById('assistant').generate('cambia la entrada e1', { memory: { thread: 't', resource: 'dev:local' } });
    expect(res.finishReason).toBe('suspended');
  });
});

describe('approval policy: MFP tools by name', () => {
  it.each(['fitness_delete_food', 'fitness_delete_exercise', 'fitness_modify_food', 'fitness_clear_food_pin'])('%s needs approval', (name) => {
    expect(requiresApproval(name, { destructiveHint: false, readOnlyHint: false })).toBe(true);
  });
  it.each(['fitness_log_food', 'fitness_log_exercise', 'fitness_get_diary', 'fitness_draft_food'])('%s does not', (name) => {
    expect(requiresApproval(name, { destructiveHint: false })).toBe(false);
  });
});

describe('registry: per-server options', () => {
  it('validates toolPrefix and errorStyle', () => {
    expect(() => parseRegistry({ servers: { mfp: { url: 'http://127.0.0.1:8484/mcp', toolPrefix: 'Fit-ness' } } })).toThrow(/toolPrefix/);
    expect(() => parseRegistry({ servers: { mfp: { url: 'http://127.0.0.1:8484/mcp', errorStyle: 'nope' } } })).toThrow(/errorStyle/);
    const reg = parseRegistry({ servers: { x: { url: 'http://127.0.0.1:1/mcp' } } });
    expect(reg.servers.x).toMatchObject({ errorStyle: 'default' });
    expect(reg.servers.x!.toolPrefix).toBeUndefined();
  });
});
