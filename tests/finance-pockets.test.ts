import { describe, expect, it } from 'vitest';
import { FinanceDirectory } from '../src/mcp/finance-cache.js';
import { createAdjustBalances } from '../src/mcp/adjust-balances.js';
import type { PlanInput } from '../src/plans/types.js';

type Rec = Record<string, unknown>;
// the live shape (2026-10-23): two accounts, several pockets each
const ACC_NU = 'ed3c9bb2-d2e6-4a63-a4df-f0345853f472';
const ACC_BONO = '229129a7-7788-46aa-8b14-8c774f0ad87e';
const ACCOUNTS = [
  { id: ACC_NU, name: 'Nu México', currency: 'MXN', balance: 12000 },
  { id: ACC_BONO, name: 'Bancolombia', currency: 'COP', balance: 3_000_000 },
];
const POCKETS = [
  { id: 'f8790365-8899-446c-a514-1e5c4feb489f', accountId: ACC_NU, name: 'Cajita Turbo', type: 'normal', balance: 5000 },
  { id: 'e72610ce-d408-4c8a-bcc7-2a31cefccec8', accountId: ACC_NU, name: 'Viajes', type: 'normal', balance: 4000 },
  { id: '3f043b05-d84b-4ecf-ae51-c827b955ba74', accountId: ACC_NU, name: 'Ahorros', type: 'normal', balance: 2000 },
  { id: '0b2fd392-cfa9-416e-a1cb-aa80cc5a1907', accountId: ACC_NU, name: 'Dinero de respaldo', type: 'normal', balance: 1000 },
  { id: '4fa35fb2-9a61-4fa4-b234-8087aa22fe8a', accountId: ACC_BONO, name: 'Bono', type: 'normal', balance: 1_000_000 },
  { id: '5aa35fb2-9a61-4fa4-b234-8087aa22fe8b', accountId: ACC_BONO, name: 'Para gastar', type: 'fixed', balance: 2_000_000 },
];
const [TURBO, VIAJES, , , BONO, GASTAR] = POCKETS.map((p) => p.id);

function dir(pockets = POCKETS) {
  const calls: string[] = [];
  const toolbox = {
    async execute(name: string) {
      calls.push(name);
      return name === 'finance_list_accounts' ? { result: ACCOUNTS } : { result: pockets };
    },
  };
  return { d: new FinanceDirectory(toolbox), calls };
}

describe('pocket ids checked against the cache (prod req 956597)', () => {
  it('pocketId = the account id + the real pocket in subPocketId → remapped, subPocketId dropped', async () => {
    const { d } = dir();
    const r = await d.repairPocket({ type: 'IngresoNormal', amount: 69.45, pocketId: ACC_NU, subPocketId: TURBO, accountId: ACC_NU, displayedDate: '2026-10-23' });
    expect(r).toEqual({ args: { type: 'IngresoNormal', amount: 69.45, pocketId: TURBO, accountId: ACC_NU, displayedDate: '2026-10-23' }, fixed: expect.stringMatching(/account id/) });
  });
  it('a known pocket keeps its own account (a wrong accountId is corrected) and a pocket id in subPocketId is dropped', async () => {
    const { d } = dir();
    expect(await d.repairPocket({ pocketId: BONO, accountId: ACC_NU, subPocketId: BONO })).toEqual({ args: { pocketId: BONO, accountId: ACC_BONO }, fixed: expect.any(String) });
    expect(await d.repairPocket({ pocketId: TURBO })).toEqual({ args: { pocketId: TURBO, accountId: ACC_NU }, fixed: expect.any(String) });
    expect(await d.repairPocket({ pocketId: TURBO, accountId: ACC_NU })).toEqual({ args: { pocketId: TURBO, accountId: ACC_NU } });
  });
  it('a real sub-pocket id (not a pocket) on a fixed pocket is kept', async () => {
    const { d } = dir();
    const sub = '99999999-9999-4999-8999-999999999999';
    expect(await d.repairPocket({ pocketId: GASTAR, accountId: ACC_BONO, subPocketId: sub })).toEqual({ args: { pocketId: GASTAR, accountId: ACC_BONO, subPocketId: sub } });
  });
  it('pocketId = an account id with no usable subPocketId → an error for the model listing that account\'s pockets', async () => {
    const { d } = dir();
    const r = await d.repairPocket({ pocketId: ACC_NU, accountId: ACC_NU });
    expect(r).toMatchObject({ error: expect.stringMatching(/is the ACCOUNT id of Nu México[\s\S]*Cajita Turbo id=f8790365[^\n]* accountId=ed3c9bb2/) });
    expect((r as { error: string }).error).not.toMatch(/Bono/);
  });
  it('an unknown pocketId → the error lists every pocket (refreshed once first)', async () => {
    const { d, calls } = dir();
    const r = await d.repairPocket({ pocketId: '12345678-1234-4234-8234-123456789012' });
    expect((r as { error: string }).error).toMatch(/not a pocket id[\s\S]*Viajes id=e72610ce[\s\S]*Bono id=4fa35fb2/);
    expect(calls.filter((c) => c === 'finance_list_pockets')).toHaveLength(2);
  });
  it('without a cache (finance list failed), args pass through unchanged', async () => {
    const d = new FinanceDirectory({ execute: async () => ({ error: { code: 'UNAVAILABLE', message: 'x', retryable: true } }) });
    expect(await d.repairPocket({ pocketId: ACC_NU })).toEqual({ args: { pocketId: ACC_NU } });
  });
});

describe('adjust_balances: one summary card, deltas computed by the hub', () => {
  function setup() {
    const { d } = dir();
    const proposed: PlanInput[] = [];
    const tool = createAdjustBalances({ directory: d, propose: async (input: PlanInput) => (proposed.push(input), { plan_id: 'p1', status: 'shown_to_user' }), today: () => '2026-10-23', language: 'es' }) as unknown as { execute(i: unknown, c: unknown): Promise<Rec> };
    return { tool, proposed };
  }
  it('new balances (from a photo) → one plan: income/expense per pocket, grouped by account, current → new · delta', async () => {
    const { tool, proposed } = setup();
    const r = await tool.execute(
      {
        adjustments: [
          { pocketId: TURBO, newBalance: 5069.45 },
          { pocketId: VIAJES, newBalance: 3929.41 },
          { pocketId: BONO, newBalance: 1_055_262.51 },
          { pocketId: GASTAR, newBalance: 2_000_000 }, // unchanged → skipped
        ],
      },
      {},
    );
    expect(r).toMatchObject({ status: 'shown_to_user' });
    const p = proposed[0]!;
    expect(p.groups.map((g) => g.label)).toEqual(['Nu México (MXN)', 'Bancolombia (COP)']);
    const acts = p.groups.flatMap((g) => g.actions);
    expect(acts.map((a) => [a.args.type, a.args.amount, a.args.pocketId, a.args.accountId])).toEqual([
      ['IngresoNormal', 69.45, TURBO, ACC_NU],
      ['EgresoNormal', 70.59, VIAJES, ACC_NU],
      ['IngresoNormal', 55262.51, BONO, ACC_BONO],
    ]);
    expect(acts[0]!.summary).toMatch(/Cajita Turbo: 5\.000(,00)? → 5\.069,45 \(\+69,45\)/);
    expect(acts[2]!.args).toMatchObject({ notes: 'Ajuste de saldo Bono', displayedDate: '2026-10-23' });
    expect(p.title).toMatch(/3 ajustes/);
  });
  it('deltas are accepted too; an account id given as pocket is resolved by name; unknown pockets are reported', async () => {
    const { tool, proposed } = setup();
    await tool.execute({ adjustments: [{ pocketId: TURBO, delta: -10 }] }, {});
    expect(proposed[0]!.groups[0]!.actions[0]!.args).toMatchObject({ type: 'EgresoNormal', amount: 10 });
    const bad = await tool.execute({ adjustments: [{ pocketId: ACC_NU, newBalance: 1 }] }, {});
    expect(JSON.stringify(bad)).toMatch(/ACCOUNT id/);
    expect(proposed).toHaveLength(1);
  });
  it('nothing to change → no card', async () => {
    const { tool, proposed } = setup();
    expect(await tool.execute({ adjustments: [{ pocketId: TURBO, newBalance: 5000 }] }, {})).toMatchObject({ status: 'nothing_to_adjust' });
    expect(proposed).toHaveLength(0);
  });
});

describe('through the hub (fake finance-app)', async () => {
  const { afterEach } = await import('vitest');
  const { createHub } = await import('../src/hub.js');
  const { testConfig } = await import('./helpers.js');
  const { scriptedModel, lastToolResult } = await import('./support/scripted-model.js');
  const { startFakeFinance } = await import('./support/fake-finance.js');
  const { withUsageScope } = await import('../src/telemetry/context.js');
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0).reverse()) await c();
  });
  async function run(script: Parameters<typeof scriptedModel>[0], text: string) {
    const fin = await startFakeFinance('t0k');
    closers.push(fin.close);
    const sm = scriptedModel(script);
    const env = { FINANCE_MCP_URL: fin.url, FINANCE_MCP_TOKEN: 't0k' };
    const hub = createHub(testConfig(), { model: sm.model as never, registry: { servers: { finance: { url: '${FINANCE_MCP_URL}', headers: { Authorization: { env: 'FINANCE_MCP_TOKEN', prefix: 'Bearer ' } } } } }, env });
    closers.push(() => hub.stop());
    await withUsageScope({ requestId: 'r', intent: 'expense', media: 'text', kind: 'chat', domains: ['finance'], text }, () => hub.mastra.getAgentById('assistant').generate(text, { memory: { thread: 't', resource: 'dev:local' } }));
    return { fin, sm, hub };
  }
  const creates = (fin: { calls: { tool: string; input: Rec }[] }) => fin.calls.filter((c) => c.tool === 'finance_create_movement').map((c) => c.input);

  it('the live args (pocketId = account, pocket in subPocketId) reach the server fixed', async () => {
    const { fin } = await run([{ tool: 'finance_create_movement', args: { type: 'IngresoNormal', amount: 69.45, pocketId: 'acc-nu-mx', subPocketId: 'pk-nu-turbo', accountId: 'acc-nu-mx', displayedDate: '2026-10-23', notes: 'intereses' } }, { text: 'ok' }], 'registra 69.45 de intereses en Cajita Turbo');
    expect(creates(fin)).toEqual([{ type: 'IngresoNormal', amount: 69.45, pocketId: 'pk-nu-turbo', accountId: 'acc-nu-mx', displayedDate: '2026-10-23', notes: 'intereses' }]);
  });
  it('an unknown pocket never reaches the server: the model gets the pocket list and retries', async () => {
    let seen = '';
    const { fin } = await run(
      [
        { tool: 'finance_create_movement', args: { type: 'EgresoNormal', amount: 1000, pocketId: 'acc-nequi', accountId: 'acc-nequi', displayedDate: '2026-10-23' } },
        (p) => ((seen = lastToolResult(p)), { tool: 'finance_create_movement', args: { type: 'EgresoNormal', amount: 1000, pocketId: 'pk-nequi-main', accountId: 'acc-nequi', displayedDate: '2026-10-23' } }),
        { text: 'ok' },
      ],
      'gasté 1000 en Nequi',
    );
    expect(seen).toMatch(/VALIDATION_ERROR[\s\S]*ACCOUNT id of Nequi[\s\S]*Principal id=pk-nequi-main/);
    expect(creates(fin)).toEqual([{ type: 'EgresoNormal', amount: 1000, pocketId: 'pk-nequi-main', accountId: 'acc-nequi', displayedDate: '2026-10-23' }]);
  });
  it('a balance adjustment via finance_create_movement is sent back; adjust_balances shows a plan and writes nothing', async () => {
    let seen = '';
    const { fin, sm } = await run(
      [
        { tool: 'finance_create_movement', args: { type: 'IngresoNormal', amount: 69.45, pocketId: 'pk-nu-turbo', accountId: 'acc-nu-mx', displayedDate: '2026-10-23', notes: 'Ajuste de saldo Cajita Turbo' } },
        (p) => ((seen = lastToolResult(p)), { tool: 'adjust_balances', args: { adjustments: [{ pocketId: 'pk-nu-turbo', newBalance: 5069.45 }] } }),
        (p) => ((seen += lastToolResult(p)), { text: 'Le mostré el ajuste.' }),
      ],
      'ajusta los saldos como en la foto',
    );
    expect(seen).toMatch(/adjust_balances[\s\S]*shown_to_user/);
    expect(creates(fin)).toEqual([]);
    expect(sm.calls[0]!.tools).toContain('adjust_balances');
  });
});
