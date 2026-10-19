import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';

/**
 * Fake finance-app MCP mirroring its SYNC contract: bearer auth, finance_* tools with
 * readOnly/destructive annotations, shared error shape {error:{code,message,retryable}},
 * arrays wrapped as {result:[...]}.
 */
export interface FakeFinance {
  url: string;
  calls: { tool: string; input: Record<string, unknown> }[];
  /** When set, finance_create_movement fails with this VALIDATION_ERROR message. */
  rejectCreate?: string;
  close(): Promise<void>;
}

const ACCOUNTS = [
  { id: 'acc-nequi', name: 'Nequi', currency: 'COP' },
  { id: 'acc-nu-mx', name: 'Nu México', currency: 'MXN' },
];
const POCKETS = [
  { id: 'pk-nequi-main', accountId: 'acc-nequi', name: 'Principal' },
  { id: 'pk-nu-main', accountId: 'acc-nu-mx', name: 'Disponible' },
];
const TYPES = ['IngresoNormal', 'EgresoNormal', 'IngresoFijo', 'EgresoFijo'] as const;

const err = (code: string, message: string, retryable = false) => ({ error: { code, message, retryable } });

export async function startFakeFinance(token = 'test-token'): Promise<FakeFinance> {
  const state: FakeFinance = { url: '', calls: [], close: async () => {} };
  const ro = { readOnlyHint: true, destructiveHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false };
  const record = (tool: string, input: unknown) => state.calls.push({ tool, input: (input ?? {}) as Record<string, unknown> });

  const tools = {
    finance_list_accounts: createTool({
      id: 'finance_list_accounts',
      description: 'List the user accounts (id, name, currency).',
      inputSchema: z.object({}),
      mcp: { annotations: ro },
      execute: async (i) => (record('finance_list_accounts', i), { result: ACCOUNTS }),
    }),
    finance_list_pockets: createTool({
      id: 'finance_list_pockets',
      description: 'List pockets (sub-balances) of accounts.',
      inputSchema: z.object({ accountId: z.string().optional() }),
      mcp: { annotations: ro },
      execute: async (i) => (record('finance_list_pockets', i), { result: POCKETS.filter((p) => !i.accountId || p.accountId === i.accountId) }),
    }),
    finance_create_movement: createTool({
      id: 'finance_create_movement',
      description: 'Create a movement (income or expense) in an account. Amount is positive, in the account currency. Date YYYY-MM-DD.',
      inputSchema: z.object({
        accountId: z.string(),
        pocketId: z.string().optional(),
        type: z.enum(TYPES),
        amount: z.number(),
        date: z.string(),
        description: z.string().optional(),
      }),
      mcp: { annotations: rw },
      execute: async (i) => {
        record('finance_create_movement', i);
        if (state.rejectCreate) return err('VALIDATION_ERROR', state.rejectCreate);
        if (!(i.amount > 0)) return err('VALIDATION_ERROR', 'amount must be positive');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(i.date)) return err('VALIDATION_ERROR', 'date must be YYYY-MM-DD');
        if (!ACCOUNTS.some((a) => a.id === i.accountId)) return err('NOT_FOUND', `account ${i.accountId} not found`);
        return { id: 'mov-1', ...i };
      },
    }),
    finance_delete_movement: createTool({
      id: 'finance_delete_movement',
      description: 'Delete a movement by id.',
      inputSchema: z.object({ id: z.string() }),
      mcp: { annotations: { readOnlyHint: false, destructiveHint: true } },
      execute: async (i) => (record('finance_delete_movement', i), { deleted: i.id }),
    }),
  };

  const mcp = new MCPServer({ id: 'finance', name: 'finance', version: '0.0.0-test', tools });
  const server: Server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify(err('UNAUTHORIZED', 'invalid token')));
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void mcp.startHTTP({ url, httpPath: '/mcp', req, res });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  state.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return state;
}
