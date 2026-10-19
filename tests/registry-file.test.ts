import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadRegistry } from '../src/mcp/registry.js';

describe('repo mcp-servers.json', () => {
  const reg = loadRegistry(join(process.cwd(), 'mcp-servers.json'));

  it('lists echo, mfp and finance; echo and mfp off, finance gated by env', () => {
    expect(Object.keys(reg.servers).sort()).toEqual(['echo', 'finance', 'mfp']);
    expect(reg.servers.echo!.enabled).toBe(false);
    expect(reg.servers.mfp!.enabled).toBe(false);
    expect(reg.servers.finance!.enabled).toBe(true);
  });

  it('mfp: Mason on loopback, no auth, fitness_* tools, Mason error mapping', () => {
    expect(reg.servers.mfp).toMatchObject({
      url: 'http://127.0.0.1:8484/mcp',
      headers: {},
      toolPrefix: 'fitness',
      errorStyle: 'mason',
    });
  });

  it('finance: url and bearer token come only from env', () => {
    expect(reg.servers.finance!.url).toBe('${FINANCE_MCP_URL}');
    expect(reg.servers.finance!.headers.Authorization).toEqual({ env: 'FINANCE_MCP_TOKEN', prefix: 'Bearer ' });
    expect(reg.servers.finance!.headers['x-vercel-protection-bypass']).toEqual({ env: 'FINANCE_MCP_BYPASS', optional: true });
  });
});
