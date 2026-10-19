import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadRegistry } from '../src/mcp/registry.js';
import { McpToolbox } from '../src/mcp/toolbox.js';

describe('repo mcp-servers.json', () => {
  const reg = loadRegistry(join(process.cwd(), 'mcp-servers.json'));

  it('is machine-independent: every app is enabled and gated by its own env URL', () => {
    expect(Object.keys(reg.servers).sort()).toEqual(['echo', 'finance', 'mfp']);
    expect(Object.values(reg.servers).every((s) => s.enabled)).toBe(true);
    expect(reg.servers.echo!.url).toBe('${ECHO_MCP_URL}');
    expect(reg.servers.mfp!.url).toBe('${MFP_MCP_URL}');
    expect(reg.servers.finance!.url).toBe('${FINANCE_MCP_URL}');
  });

  it('mfp: no auth, fitness_* tools, Mason error mapping', () => {
    expect(reg.servers.mfp).toMatchObject({ headers: {}, toolPrefix: 'fitness', errorStyle: 'mason' });
  });

  it('finance: bearer token from env, optional preview bypass header', () => {
    expect(reg.servers.finance!.headers.Authorization).toEqual({ env: 'FINANCE_MCP_TOKEN', prefix: 'Bearer ' });
    expect(reg.servers.finance!.headers['x-vercel-protection-bypass']).toEqual({ env: 'FINANCE_MCP_BYPASS', optional: true });
  });

  it('a machine without the env vars skips every app without connecting', async () => {
    const tb = new McpToolbox(reg, {}, { log: () => {} });
    expect(await tb.getTools()).toEqual({});
    expect(Object.values(tb.status()).map((s) => s.state)).toEqual(['skipped', 'skipped', 'skipped']);
    await tb.close();
  });

  it('a non-loopback plain-http MFP_MCP_URL is refused at runtime', async () => {
    const tb = new McpToolbox(reg, { MFP_MCP_URL: 'http://192.168.1.20:8484/mcp' }, { log: () => {} });
    await tb.getTools();
    expect(tb.status().mfp).toMatchObject({ state: 'skipped', reason: expect.stringMatching(/https/) });
    await tb.close();
  });
});
