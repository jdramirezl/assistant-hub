import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { KvStore } from '../src/kv.js';

const dirs: string[] = [];
function dbUrl() {
  const d = mkdtempSync(join(tmpdir(), 'hub-kv-'));
  dirs.push(d);
  return `file:${join(d, 'kv.db')}`;
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('KvStore', () => {
  it('round-trips JSON values and survives a new client', async () => {
    const url = dbUrl();
    const a = new KvStore(createClient({ url }));
    await a.set('k', { offset: 7, pending: [] });
    const b = new KvStore(createClient({ url }));
    expect(await b.get('k')).toEqual({ offset: 7, pending: [] });
  });

  it('expires values after their ttl', async () => {
    let now = 1_000;
    const kv = new KvStore(createClient({ url: dbUrl() }), () => now);
    await kv.set('k', 1, 500);
    expect(await kv.get('k')).toBe(1);
    now = 1_501;
    expect(await kv.get('k')).toBeNull();
  });

  it('setIfNotExists claims once, and again after expiry', async () => {
    let now = 0;
    const kv = new KvStore(createClient({ url: dbUrl() }), () => now);
    expect(await kv.setIfNotExists('dedupe:1', true, 100)).toBe(true);
    expect(await kv.setIfNotExists('dedupe:1', true, 100)).toBe(false);
    now = 101;
    expect(await kv.setIfNotExists('dedupe:1', true, 100)).toBe(true);
  });

  it('increments atomically', async () => {
    const kv = new KvStore(createClient({ url: dbUrl() }));
    await Promise.all(Array.from({ length: 20 }, () => kv.incr('n', 2)));
    expect(await kv.get('n')).toBe(40);
  });

  it('deletes', async () => {
    const kv = new KvStore(createClient({ url: dbUrl() }));
    await kv.set('k', 'v');
    await kv.delete('k');
    expect(await kv.get('k')).toBeNull();
  });
});
