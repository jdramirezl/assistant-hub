import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadRegistry } from '../src/mcp/registry.js';

describe('repo mcp-servers.json', () => {
  const reg = loadRegistry(join(process.cwd(), 'mcp-servers.json'));

  it('lists echo, mfp and finance, all disabled until go-live', () => {
    expect(Object.keys(reg.servers).sort()).toEqual(['echo', 'finance', 'mfp']);
    expect(Object.values(reg.servers).every((s) => s.enabled === false)).toBe(true);
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
  });
});
