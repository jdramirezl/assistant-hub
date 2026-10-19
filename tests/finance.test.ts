import { afterEach, describe, expect, it } from 'vitest';
import { createHub } from '../src/hub.js';
import { bogotaDay } from '../src/budget.js';
import { buildInstructions } from '../src/agents/assistant.js';
import { normalizeResult } from '../src/mcp/toolbox.js';
import { parseRegistry, resolveHeaders } from '../src/mcp/registry.js';
import { McpToolbox } from '../src/mcp/toolbox.js';
import { testConfig } from './helpers.js';
import { scriptedModel, lastToolResult } from './support/scripted-model.js';
import { startFakeFinance, type FakeFinance } from './support/fake-finance.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const FINANCE = {
  url: '${FINANCE_MCP_URL}',
  headers: { Authorization: { env: 'FINANCE_MCP_TOKEN', prefix: 'Bearer ' } },
};

async function setup() {
  const fin = await startFakeFinance('t0k');
  closers.push(fin.close);
  return { fin, env: { FINANCE_MCP_URL: fin.url, FINANCE_MCP_TOKEN: 't0k' } };
}

function hubWith(fin: FakeFinance, env: Record<string, string>, script: Parameters<typeof scriptedModel>[0]) {
  const sm = scriptedModel(script);
  const hub = createHub(testConfig(), { model: sm.model as never, registry: { servers: { finance: FINANCE } }, env });
  closers.push(() => hub.stop());
  return { hub, calls: sm.calls };
}

/** The scripted "model" resolves Nequi from the listed accounts and takes today's date from the prompt. */
function systemText(prompt: unknown[]): string {
  return JSON.stringify((prompt as { role: string }[]).filter((m) => m.role === 'system'));
}

describe('finance contract normalization', () => {
  it('isError + structuredContent shared shape passes through unchanged', () => {
    const shaped = { error: { code: 'VALIDATION_ERROR', message: 'amount must be positive', retryable: false } };
    const res = normalizeResult({ isError: true, content: [{ type: 'text', text: JSON.stringify(shaped) }], structuredContent: shaped });
    expect(res).toEqual(shaped);
  });
  it('success structuredContent is returned; arrays stay wrapped as {result}', () => {
    expect(normalizeResult({ content: [{ type: 'text', text: '{}' }], structuredContent: { result: [{ id: 'a' }] } })).toEqual({ result: [{ id: 'a' }] });
  });
});

describe('finance through the hub', () => {
  it('"gasté 25k en almuerzo con Nequi" → finance_create_movement (EgresoNormal, today in Bogota), no approval', async () => {
    const { fin, env } = await setup();
    const today = bogotaDay(Date.now(), 'America/Bogota');
    const { hub } = hubWith(fin, env, [
      { tool: 'finance_list_accounts', args: {} },
      (p) => {
        expect(lastToolResult(p)).toContain('acc-nequi'); // accounts were listed first
        const date = systemText(p).match(/\d{4}-\d{2}-\d{2}/)![0];
        return { tool: 'finance_create_movement', args: { accountId: 'acc-nequi', type: 'EgresoNormal', amount: 25000, date, description: 'almuerzo' } };
      },
      (p) => ({ text: `Listo ✅ ${lastToolResult(p)}` }),
    ]);
    const res = await hub.mastra.getAgentById('assistant').generate('gasté 25k en almuerzo con Nequi', { memory: { thread: 'f1', resource: 'dev:local' } });
    expect(res.finishReason).not.toBe('suspended');
    const create = fin.calls.find((c) => c.tool === 'finance_create_movement')!;
    expect(create.input).toMatchObject({ accountId: 'acc-nequi', type: 'EgresoNormal', amount: 25000, date: today });
    expect(res.text).toContain('mov-1');
  });

  it('a delete requires approval and only runs after it', async () => {
    const { fin, env } = await setup();
    const { hub } = hubWith(fin, env, [{ tool: 'finance_delete_movement', args: { id: 'mov-9' } }, (p) => ({ text: `ok ${lastToolResult(p)}` })]);
    const agent = hub.mastra.getAgentById('assistant');
    const memory = { thread: 'f2', resource: 'dev:local' };
    const first = await agent.generate('borra el movimiento mov-9', { memory });
    expect(first.finishReason).toBe('suspended');
    expect(fin.calls.some((c) => c.tool === 'finance_delete_movement')).toBe(false);
    await agent.approveToolCallGenerate({ runId: first.runId!, memory } as never);
    expect(fin.calls.some((c) => c.tool === 'finance_delete_movement')).toBe(true);
  });

  it('a VALIDATION_ERROR reaches the model as the shared error, not a success', async () => {
    const { fin, env } = await setup();
    fin.rejectCreate = 'category is required for EgresoNormal';
    let seen = '';
    const { hub } = hubWith(fin, env, [
      { tool: 'finance_create_movement', args: { accountId: 'acc-nequi', type: 'EgresoNormal', amount: 25000, date: '2026-10-18' } },
      (p) => ((seen = lastToolResult(p)), { text: 'No pude registrarlo' }),
    ]);
    await hub.mastra.getAgentById('assistant').generate('gasté 25k', { memory: { thread: 'f3', resource: 'dev:local' } });
    expect(seen).toContain('VALIDATION_ERROR');
    expect(seen).toContain('category is required');
    expect(seen).toContain('"retryable":false');
  });

  it('wrong token → finance is down, the hub keeps running and the agent is told', async () => {
    const { fin } = await setup();
    const tb = new McpToolbox(parseRegistry({ servers: { finance: FINANCE } }), { FINANCE_MCP_URL: fin.url, FINANCE_MCP_TOKEN: 'nope' }, { log: () => {} });
    closers.push(() => tb.close());
    expect(await tb.getTools()).toEqual({});
    expect(tb.status().finance!.state).toBe('down');
    expect(tb.statusNote()).toMatch(/finance/);
  });

  it('without FINANCE_MCP_URL (dev laptop) finance is skipped, not contacted', async () => {
    const tb = new McpToolbox(parseRegistry({ servers: { finance: FINANCE } }), { FINANCE_MCP_URL: 'CHANGEME', FINANCE_MCP_TOKEN: 'CHANGEME' }, { log: () => {} });
    closers.push(() => tb.close());
    expect(await tb.getTools()).toEqual({});
    expect(tb.status().finance).toMatchObject({ state: 'skipped' });
  });
});

describe('optional headers (preview deployments)', () => {
  const spec = {
    Authorization: { env: 'FINANCE_MCP_TOKEN', prefix: 'Bearer ' },
    'x-vercel-protection-bypass': { env: 'FINANCE_MCP_BYPASS', optional: true },
  };
  it('sends an optional header when set', () => {
    expect(resolveHeaders(spec, { FINANCE_MCP_TOKEN: 't', FINANCE_MCP_BYPASS: 'b' })).toEqual({
      headers: { Authorization: 'Bearer t', 'x-vercel-protection-bypass': 'b' },
      missing: [],
    });
  });
  it('omits it (without skipping the server) when unset', () => {
    expect(resolveHeaders(spec, { FINANCE_MCP_TOKEN: 't' })).toEqual({ headers: { Authorization: 'Bearer t' }, missing: [] });
  });
  it('parses in the registry', () => {
    expect(parseRegistry({ servers: { finance: { url: 'https://x.vercel.app/mcp', headers: spec } } }).servers.finance!.headers['x-vercel-protection-bypass']).toEqual({
      env: 'FINANCE_MCP_BYPASS',
      optional: true,
    });
  });
});

describe('finance domain hints', () => {
  it('teaches types, positive amounts and resolving names to ids first', () => {
    const t = buildInstructions('America/Bogota');
    for (const s of ['IngresoNormal', 'EgresoNormal', 'IngresoFijo', 'EgresoFijo', 'positive', 'finance_list_accounts', 'finance_list_pockets', 'YYYY-MM-DD']) {
      expect(t).toContain(s);
    }
  });
});
