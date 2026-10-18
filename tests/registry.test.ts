import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, parseRegistry, RegistryError, resolveHeaders } from '../src/mcp/registry.js';

describe('MCP registry', () => {
  it('parses a valid registry and defaults enabled=true, auth headers from env names', () => {
    const reg = parseRegistry({
      servers: {
        fitness: { url: 'http://127.0.0.1:8484/mcp' },
        finance: {
          url: 'https://finance.example.com/mcp',
          headers: { Authorization: { env: 'FINANCE_MCP_TOKEN', prefix: 'Bearer ' } },
          enabled: false,
        },
      },
    });
    expect(reg.servers.fitness).toMatchObject({ url: 'http://127.0.0.1:8484/mcp', enabled: true, headers: {} });
    expect(reg.servers.finance!.enabled).toBe(false);
  });

  it('rejects bad names, non-http urls, plaintext http to remote hosts and literal secrets', () => {
    expect(() => parseRegistry({ servers: { 'Bad-Name': { url: 'http://127.0.0.1/mcp' } } })).toThrow(RegistryError);
    expect(() => parseRegistry({ servers: { a: { url: 'ftp://x/mcp' } } })).toThrow(/url/);
    expect(() => parseRegistry({ servers: { a: { url: 'http://finance.example.com/mcp' } } })).toThrow(/https/);
    expect(() =>
      parseRegistry({ servers: { a: { url: 'https://x/mcp', headers: { Authorization: 'Bearer abc' } } } }),
    ).toThrow(/env/);
  });

  it('resolves headers from env and reports missing secrets', () => {
    const spec = { Authorization: { env: 'TOK', prefix: 'Bearer ' }, 'X-Client': { env: 'CLIENT' } };
    expect(resolveHeaders(spec, { TOK: 's3cret', CLIENT: 'hub' })).toEqual({
      headers: { Authorization: 'Bearer s3cret', 'X-Client': 'hub' },
      missing: [],
    });
    expect(resolveHeaders(spec, { TOK: 'CHANGEME' }).missing).toEqual(['TOK', 'CLIENT']);
  });

  it('allows env interpolation in the url (placeholder → server skipped)', () => {
    const reg = parseRegistry({ servers: { finance: { url: '${FINANCE_MCP_URL}' } } });
    expect(reg.servers.finance!.url).toBe('${FINANCE_MCP_URL}');
  });

  it('loads from a file and reports the path on parse errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    const p = join(dir, 'mcp-servers.json');
    writeFileSync(p, '{ not json');
    expect(() => loadRegistry(p)).toThrow(p);
    expect(loadRegistry(join(dir, 'missing.json'))).toEqual({ servers: {} });
  });
});
