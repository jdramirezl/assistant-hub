import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIND = join(process.cwd(), 'scripts/node.sh');

function fakeNode(dir: string, version: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'node');
  writeFileSync(bin, `#!/bin/sh\necho ${version}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function find(env: Record<string, string>) {
  const res = spawnSync('bash', ['-c', `source "${FIND}"; find_node`], {
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME!, ...env },
    encoding: 'utf8',
  });
  return { code: res.status, out: res.stdout.trim(), err: res.stderr };
}

describe('find_node (stable Node for launchd)', () => {
  const root = mkdtempSync(join(tmpdir(), 'nodes-'));
  const ok22 = fakeNode(join(root, 'usr/local/bin'), 'v22.14.0');
  const old = fakeNode(join(root, 'old/bin'), 'v22.12.0');
  const v20 = fakeNode(join(root, 'v20/bin'), 'v20.18.1');
  const nvm = fakeNode(join(root, '.nvm/versions/node/v24.1.0/bin'), 'v24.1.0');
  const noEnv = join(root, 'no.env');

  it('accepts an existing Node >= 22.13 on a stable path (no Homebrew build needed)', () => {
    expect(find({ NODE_CANDIDATES: `${v20} ${old} ${ok22}`, NODE_ENV_FILE: noEnv })).toMatchObject({ code: 0, out: ok22 });
  });

  it('skips version-pinned manager paths (nvm/volta/fnm) that break after upgrades', () => {
    const r = find({ NODE_CANDIDATES: `${nvm}`, NODE_ENV_FILE: noEnv });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/version-specific path/);
  });

  it('NODE_BIN wins (env or .env), even on a manager path, but must be >= 22.13', () => {
    expect(find({ NODE_BIN: nvm, NODE_CANDIDATES: ok22, NODE_ENV_FILE: noEnv })).toMatchObject({ code: 0, out: nvm });
    const envFile = join(root, 'with.env');
    writeFileSync(envFile, `GOOGLE_API_KEY=x\nNODE_BIN=${ok22}\n`);
    expect(find({ NODE_CANDIDATES: '', NODE_ENV_FILE: envFile })).toMatchObject({ code: 0, out: ok22 });
    const bad = find({ NODE_BIN: v20, NODE_ENV_FILE: noEnv });
    expect(bad.code).not.toBe(0);
    expect(bad.err).toMatch(/22\.13/);
  });

  it('explains what to do when nothing suitable exists', () => {
    const r = find({ NODE_CANDIDATES: `${v20}`, NODE_ENV_FILE: noEnv });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/NODE_BIN|nodejs\.org|brew install node@24/);
  });
});
