import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const SCRIPTS = ['lib.sh', 'render-plist.sh', 'setup-mac.sh', 'deploy.sh', 'backup.sh'].map((s) => join(REPO, 'scripts', s));
const TEMPLATES = ['com.jdrami.assistant-hub', 'com.jdrami.assistant-hub.backup'].map((l) => join(REPO, 'launchd', `${l}.plist.tmpl`));
const hasShellcheck = spawnSync('which', ['shellcheck']).status === 0;

function fakeNode(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-node-'));
  const bin = join(dir, 'opt', 'node@24', 'bin');
  mkdirSync(bin, { recursive: true });
  const node = join(bin, 'node');
  writeFileSync(node, '#!/bin/sh\necho v24.0.0\n');
  chmodSync(node, 0o755);
  return node;
}

function render(template: string, env: Record<string, string> = {}): string {
  return execFileSync(join(REPO, 'scripts/render-plist.sh'), [template, '--stdout'], {
    env: { ...process.env, NODE_BIN: fakeNode(), ...env },
    encoding: 'utf8',
  });
}

describe('shell scripts', () => {
  it.each(SCRIPTS)('%s parses (bash -n)', (script) => {
    expect(spawnSync('bash', ['-n', script]).status).toBe(0);
  });

  it.skipIf(!hasShellcheck)('pass shellcheck', () => {
    const res = spawnSync('shellcheck', ['-x', '-P', join(REPO, 'scripts'), ...SCRIPTS], { encoding: 'utf8' });
    expect(res.stdout + res.stderr).toBe('');
  });

  it('templates contain no hardcoded user paths', () => {
    for (const t of TEMPLATES) expect(readFileSync(t, 'utf8')).not.toMatch(/\/Users\//);
  });

  it('setup and deploy show usage', () => {
    for (const s of ['setup-mac.sh', 'deploy.sh']) {
      const out = execFileSync(join(REPO, 'scripts', s), ['--help'], { encoding: 'utf8' });
      expect(out).toMatch(/Run it ON that Mac/);
    }
  });
});

describe('launchd plists', () => {
  it.each(TEMPLATES)('%s renders to a valid plist with absolute paths', (template) => {
    const dir = mkdtempSync(join(tmpdir(), 'plist-'));
    const out = join(dir, 'x.plist');
    writeFileSync(out, render(template));
    expect(spawnSync('plutil', ['-lint', out]).status).toBe(0);
    const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', out], { encoding: 'utf8' }));
    const strings: string[] = JSON.stringify(json).match(/"[^"]*"/g)!.map((s) => JSON.parse(s));
    for (const s of strings.filter((x) => x.includes('/') && !x.startsWith('--') && !x.includes(':'))) {
      expect(s.startsWith('/'), `relative path in plist: ${s}`).toBe(true);
    }
    expect(JSON.stringify(json)).not.toMatch(/@[A-Z_]+@/);
  });

  it('hub agent: KeepAlive, loopback bind, production env, logs, no secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plist-'));
    const out = join(dir, 'hub.plist');
    writeFileSync(out, render(TEMPLATES[0]!, { LOG_DIR: '/tmp/hub-logs' }));
    const p = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', out], { encoding: 'utf8' }));
    expect(p.Label).toBe('com.jdrami.assistant-hub');
    expect(p.KeepAlive).toBe(true);
    expect(p.RunAtLoad).toBe(true);
    expect(p.ProgramArguments[0]).toMatch(/^\/.*\/bin\/node$/);
    expect(p.ProgramArguments).toContain(`--env-file-if-exists=${REPO}/.env`);
    expect(p.ProgramArguments.at(-1)).toBe(`${REPO}/.mastra/output/index.mjs`);
    expect(p.WorkingDirectory).toBe(REPO);
    expect(p.EnvironmentVariables).toMatchObject({
      NODE_ENV: 'production',
      MASTRA_TELEMETRY_DISABLED: '1',
      HUB_HOST: '127.0.0.1',
      HUB_PORT: '4111',
    });
    expect(p.StandardErrorPath).toBe('/tmp/hub-logs/hub.err.log');
    expect(JSON.stringify(p)).not.toMatch(/GOOGLE_API_KEY|TELEGRAM_BOT_TOKEN|TOKEN/);
  });

  it('render fails loudly when no usable Node exists', () => {
    const res = spawnSync(join(REPO, 'scripts/render-plist.sh'), [TEMPLATES[0]!, '--stdout'], {
      env: { ...process.env, NODE_BIN: '', NODE_CANDIDATES: '', NODE_ENV_FILE: '/nonexistent', PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/no Node >= 22\.13 on a stable path/);
  });

  it('render rejects relative override paths', () => {
    const res = spawnSync(join(REPO, 'scripts/render-plist.sh'), [TEMPLATES[0]!, '--stdout'], {
      env: { ...process.env, NODE_BIN: fakeNode(), LOG_DIR: 'logs' },
      encoding: 'utf8',
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/absolute/);
  });
});

describe('backup.sh', () => {
  function setupDb() {
    const root = mkdtempSync(join(tmpdir(), 'hub-backup-'));
    const data = join(root, 'data');
    const backups = join(root, 'backups');
    const logs = join(root, 'logs');
    mkdirSync(data, { recursive: true });
    mkdirSync(logs, { recursive: true });
    execFileSync('sqlite3', [join(data, 'mastra.db'), "PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES ('hola');"]);
    return { root, data, backups, logs };
  }
  const runBackup = (env: Record<string, string>) =>
    spawnSync('bash', [join(REPO, 'scripts/backup.sh')], { env: { ...process.env, ...env }, encoding: 'utf8' });

  it('writes a consistent, private snapshot', () => {
    const { data, backups, logs } = setupDb();
    const res = runBackup({ HUB_DATA_DIR: data, BACKUP_DIR: backups, LOG_DIR: logs });
    expect(res.status, res.stderr + res.stdout).toBe(0);
    const files = readdirSync(backups);
    expect(files).toHaveLength(1); // no -wal/-shm sidecars
    const snap = join(backups, files[0]!);
    expect(execFileSync('sqlite3', [snap, 'SELECT x FROM t'], { encoding: 'utf8' }).trim()).toBe('hola');
    expect(execFileSync('stat', ['-f', '%Lp', snap], { encoding: 'utf8' }).trim()).toBe('600');
  });

  it('keeps only the newest 7 snapshots', () => {
    const { data, backups, logs } = setupDb();
    mkdirSync(backups);
    const old = Array.from({ length: 8 }, (_, i) => `mastra-202601${String(i + 1).padStart(2, '0')}-000000.db`);
    for (const f of old) writeFileSync(join(backups, f), 'old');
    writeFileSync(join(backups, 'unrelated.txt'), 'keep me');
    const res = runBackup({ HUB_DATA_DIR: data, BACKUP_DIR: backups, LOG_DIR: logs });
    expect(res.status, res.stderr + res.stdout).toBe(0);
    const remaining = readdirSync(backups).filter((f) => f.startsWith('mastra-')).sort();
    expect(remaining).toHaveLength(7);
    expect(remaining).not.toContain('mastra-20260101-000000.db');
    expect(remaining).not.toContain('mastra-20260102-000000.db');
    expect(existsSync(join(backups, 'unrelated.txt'))).toBe(true);
  });

  it('honors BACKUP_KEEP and rotates oversized logs', () => {
    const { data, backups, logs } = setupDb();
    writeFileSync(join(logs, 'hub.err.log'), 'x'.repeat(2000));
    for (let i = 0; i < 3; i++) {
      expect(runBackup({ HUB_DATA_DIR: data, BACKUP_DIR: backups, LOG_DIR: logs, BACKUP_KEEP: '2', LOG_MAX_BYTES: '1000' }).status).toBe(0);
      execFileSync('sleep', ['1']); // distinct timestamps
    }
    expect(readdirSync(backups).filter((f) => f.startsWith('mastra-'))).toHaveLength(2);
    expect(readFileSync(join(logs, 'hub.err.log'), 'utf8')).toBe('');
    expect(readFileSync(join(logs, 'hub.err.log.1'), 'utf8')).toHaveLength(2000);
  });

  it('is a no-op without a database', () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-backup-'));
    const res = runBackup({ HUB_DATA_DIR: join(root, 'none'), BACKUP_DIR: join(root, 'b'), LOG_DIR: join(root, 'l') });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/nothing to back up/);
  });
});

describe('launchd registration (deploy over ssh lost the label)', () => {
  /**
   * A fake launchctl on PATH: state in a dir; `bootstrap` fails `failBootstraps` times (like
   * "Bootstrap failed: 5: Input/output error" right after an async bootout); `print` succeeds
   * only for registered labels. A fake curl never gets healthy.
   */
  function fakeLaunchd(failBootstraps: number, registered: string[] = []) {
    const root = mkdtempSync(join(tmpdir(), 'launchd-'));
    const bin = join(root, 'bin');
    const state = join(root, 'state');
    mkdirSync(bin);
    mkdirSync(state);
    for (const l of registered) writeFileSync(join(state, l), '');
    writeFileSync(join(root, 'fails'), String(failBootstraps));
    writeFileSync(
      join(bin, 'launchctl'),
      `#!/bin/bash
echo "$*" >> "${root}/calls"
label() { basename "\${1##*/}" .plist; }
case "$1" in
  print) [[ -f "${state}/$(label "$2")" ]] && { echo "    state = running"; echo "    pid = 4242"; echo "    last exit code = 0"; exit 0; }; echo "Could not find service" >&2; exit 113 ;;
  bootout) rm -f "${state}/$(label "$2")" ;;
  bootstrap) n=$(cat "${root}/fails"); if (( n > 0 )); then echo $((n - 1)) > "${root}/fails"; echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi; touch "${state}/$(label "$3")" ;;
  *) ;;
esac
`,
    );
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit 7\n');
    chmodSync(join(bin, 'launchctl'), 0o755);
    chmodSync(join(bin, 'curl'), 0o755);
    return { root, bin, plists: join(root, 'LaunchAgents'), calls: () => (existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8') : '') };
  }
  const bash = (f: ReturnType<typeof fakeLaunchd>, script: string) =>
    spawnSync('bash', ['-c', `set -euo pipefail; source "${join(REPO, 'scripts/lib.sh')}"; ${script}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, PLIST_DIR: f.plists, NODE_BIN: fakeNode(), LAUNCHCTL_SLEEP: '0', LAUNCHCTL_TRIES: '3', HEALTH_WAIT_S: '1', LOG_DIR: join(f.root, 'logs') },
    });
  const TMPL = TEMPLATES[0]!;

  it('a failed bootstrap is retried until launchctl print shows the label', () => {
    const f = fakeLaunchd(2, ['com.jdrami.assistant-hub']);
    // plist differs from the loaded one → bootout + bootstrap
    const res = bash(f, `install_agent com.jdrami.assistant-hub "${TMPL}"`);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim()).toBe('changed');
    expect(f.calls().match(/^bootstrap /gm)).toHaveLength(3);
    expect(res.stderr).toMatch(/attempt 1\/3 failed: Bootstrap failed: 5/);
    expect(res.stderr).toMatch(/registered \(attempt 3\)/);
  });

  it('gives up with a clear error (non-zero) instead of reporting success', () => {
    const f = fakeLaunchd(9);
    const res = bash(f, `x="$(install_agent com.jdrami.assistant-hub "${TMPL}")" || { echo "install failed"; exit 1; }`);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/could not register com\.jdrami\.assistant-hub with launchd; try: launchctl bootstrap gui\/\d+ /);
  });

  it('ensure_loaded re-bootstraps a label launchd lost; health timeout prints launchd state', () => {
    const f = fakeLaunchd(1);
    mkdirSync(f.plists, { recursive: true });
    writeFileSync(join(f.plists, 'com.jdrami.assistant-hub.plist'), '<plist/>');
    const res = bash(f, 'ensure_loaded com.jdrami.assistant-hub && wait_healthy || true');
    expect(res.stderr).toMatch(/is not registered with launchd; bootstrapping it again/);
    expect(f.calls().match(/^bootstrap /gm)).toHaveLength(2);
    expect(res.stderr).toMatch(/did not become healthy in 1s/);
    expect(res.stdout + res.stderr).toMatch(/launchd state of com\.jdrami\.assistant-hub[\s\S]*state = running[\s\S]*pid = 4242/);
    // and when it is gone, it says so
    const gone = bash(fakeLaunchd(0), 'wait_healthy || true');
    expect(gone.stderr).toMatch(/is NOT registered with launchd/);
  });
});
