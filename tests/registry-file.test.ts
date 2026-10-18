import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadRegistry } from '../src/mcp/registry.js';

describe('repo mcp-servers.json', () => {
  it('is valid and keeps real apps disabled until go-live', () => {
    const reg = loadRegistry(join(process.cwd(), 'mcp-servers.json'));
    expect(Object.keys(reg.servers).sort()).toEqual(['echo', 'finance', 'fitness']);
    expect(reg.servers.fitness!.url).toBe('http://127.0.0.1:8484/mcp');
    expect(reg.servers.finance!.headers.Authorization).toEqual({ env: 'FINANCE_MCP_TOKEN', prefix: 'Bearer ' });
  });
});
