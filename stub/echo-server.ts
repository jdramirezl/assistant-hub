// Local echo MCP server used until the finance/fitness forks land.
// Run: npm run stub:echo  → http://127.0.0.1:8585/mcp
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';

/** Cross-track error shape. */
export function toolError(code: string, message: string, retryable = false) {
  return { error: { code, message, retryable } };
}

const deleted = new Set<string>();

export const echoTools = {
  echo_say: createTool({
    id: 'echo_say',
    description: 'Echo the given text back. Use when the user says "echo ...".',
    inputSchema: z.object({ text: z.string().min(1) }),
    mcp: { annotations: { title: 'Echo', readOnlyHint: true, destructiveHint: false } },
    execute: async ({ text }) => ({ echoed: text }),
  }),
  echo_delete: createTool({
    id: 'echo_delete',
    description: 'Delete an echo item by id (demo destructive tool).',
    inputSchema: z.object({ id: z.string().min(1) }),
    mcp: { annotations: { title: 'Delete echo item', readOnlyHint: false, destructiveHint: true } },
    execute: async ({ id }) => {
      deleted.add(id);
      return { deleted: id };
    },
  }),
  echo_fail: createTool({
    id: 'echo_fail',
    description: 'Always fails with the shared error shape (for testing error handling).',
    inputSchema: z.object({ reason: z.string().optional() }),
    mcp: { annotations: { title: 'Fail', readOnlyHint: true, destructiveHint: false } },
    execute: async ({ reason }) => toolError('ECHO_FAILED', reason ?? 'echo_fail always fails', true),
  }),
};

export function wasDeleted(id: string): boolean {
  return deleted.has(id);
}

export async function startEchoServer(
  port = 0,
  host = '127.0.0.1',
  opts: { requireToken?: string } = {},
): Promise<{ url: string; server: Server; close(): Promise<void> }> {
  const mcp = new MCPServer({ id: 'echo', name: 'echo', version: '0.1.0', tools: echoTools });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname !== '/mcp') return void res.writeHead(404).end();
    if (opts.requireToken && req.headers.authorization !== opts.requireToken) {
      return void res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
    }
    void mcp.startHTTP({ url, httpPath: '/mcp', req, res, options: { enableDnsRebindingProtection: true, allowedHosts: ['127.0.0.1', 'localhost'] } }).catch((err) => {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    });
  });
  await new Promise<void>((r) => server.listen(port, host, r));
  const actual = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${actual}/mcp`,
    server,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.ECHO_PORT ?? 8585);
  void startEchoServer(port).then(({ url }) => console.log(`echo MCP server on ${url}`));
}
