import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devGeminiKey } from './support/dev-key.js';

describe('devGeminiKey (replay and live tests never use the production quota)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'devkey-'));
  writeFileSync(join(repo, '.env.server'), 'GOOGLE_API_KEY=prod-key\nX=1\n');
  it('requires a separate dev key', () => {
    const r = devGeminiKey({ GOOGLE_API_KEY: 'prod-key' }, repo);
    expect(r.key).toBeUndefined();
    expect(r.reason).toMatch(/REPLAY_GOOGLE_API_KEY/);
  });
  it('refuses the production key', () => {
    const r = devGeminiKey({ REPLAY_GOOGLE_API_KEY: 'prod-key' }, repo);
    expect(r.key).toBeUndefined();
    expect(r.reason).toMatch(/production/);
    expect(devGeminiKey({ GOOGLE_API_KEY_DEV: 'x', PROD_GOOGLE_API_KEY: 'x' }, repo).key).toBeUndefined();
  });
  it('accepts a different key', () => {
    expect(devGeminiKey({ REPLAY_GOOGLE_API_KEY: 'dev-key', GOOGLE_API_KEY: 'prod-key' }, repo)).toEqual({ key: 'dev-key' });
  });
});
