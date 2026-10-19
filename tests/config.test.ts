import { describe, expect, it } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { loadConfig, ConfigError, isPlaceholder, findUp } from '../src/config.js';

const base = { GOOGLE_API_KEY: 'test-key' };

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const cfg = loadConfig(base);
    expect(cfg.server).toEqual({ host: '127.0.0.1', port: 4111 });
    expect(cfg.dataDir).toBe(join(homedir(), 'Library/Application Support/assistant-hub'));
    expect(cfg.dbPath).toBe(join(cfg.dataDir, 'mastra.db'));
    expect(cfg.timezone).toBe('America/Bogota');
    expect(cfg.telegram.enabled).toBe(false);
    expect(cfg.healthcheckUrl).toBeUndefined();
    expect(cfg.budget).toEqual({ dailyTokenCap: 2_000_000, dailyCostCapUsd: 1 });
  });

  it('requires GOOGLE_API_KEY outside tests', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/GOOGLE_API_KEY/);
  });

  it('allows a missing GOOGLE_API_KEY when NODE_ENV=test', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).not.toThrow();
  });

  it('honours HUB_DATA_DIR but rejects relative paths', () => {
    expect(loadConfig({ ...base, HUB_DATA_DIR: '/tmp/hub' }).dbPath).toBe('/tmp/hub/mastra.db');
    expect(() => loadConfig({ ...base, HUB_DATA_DIR: 'rel/dir' })).toThrow(/absolute/);
  });

  it('refuses to bind the server to anything but loopback', () => {
    expect(() => loadConfig({ ...base, HUB_HOST: '0.0.0.0' })).toThrow(/loopback/);
    expect(loadConfig({ ...base, HUB_HOST: 'localhost' }).server.host).toBe('localhost');
  });

  it('treats placeholder values as unset', () => {
    const cfg = loadConfig({
      ...base,
      TELEGRAM_BOT_TOKEN: 'CHANGEME',
      TELEGRAM_ALLOWED_USER_IDS: '123',
      HEALTHCHECK_URL: 'CHANGEME',
    });
    expect(cfg.telegram.enabled).toBe(false);
    expect(cfg.healthcheckUrl).toBeUndefined();
    expect(isPlaceholder('changeme')).toBe(true);
    expect(isPlaceholder('')).toBe(true);
  });

  it('enables telegram only with a token AND a non-empty allowlist (fail closed)', () => {
    const tokenOnly = loadConfig({ ...base, TELEGRAM_BOT_TOKEN: '123:abc' });
    expect(tokenOnly.telegram).toMatchObject({ enabled: false, disabledReason: expect.stringMatching(/ALLOWED_USER_IDS/) });

    const ok = loadConfig({ ...base, TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_ALLOWED_USER_IDS: ' 42, 7 ' });
    expect(ok.telegram).toMatchObject({ enabled: true, botToken: '123:abc', allowedUserIds: ['42', '7'] });
  });

  it('rejects non-numeric telegram user ids', () => {
    expect(() =>
      loadConfig({ ...base, TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_ALLOWED_USER_IDS: 'bob' }),
    ).toThrow(/TELEGRAM_ALLOWED_USER_IDS/);
  });

  it('derives the memory resource id from the first allowed user', () => {
    expect(loadConfig(base).resourceId).toBe('dev:local');
    expect(loadConfig({ ...base, TELEGRAM_ALLOWED_USER_IDS: '42' }).resourceId).toBe('telegram:42');
  });

  it('finds mcp-servers.json in a parent directory (mastra dev runs from .mastra/output)', () => {
    const root = mkdtempSync(join(tmpdir(), 'cfg-'));
    const deep = join(root, '.mastra', 'output');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(root, 'mcp-servers.json'), '{"servers":{}}');
    expect(findUp('mcp-servers.json', deep)).toBe(join(root, 'mcp-servers.json'));
    expect(findUp('nope.json', deep)).toBeUndefined();
  });

  it('parses budget caps', () => {
    const cfg = loadConfig({ ...base, DAILY_TOKEN_CAP: '1000', DAILY_COST_CAP_USD: '0.5' });
    expect(cfg.budget).toEqual({ dailyTokenCap: 1000, dailyCostCapUsd: 0.5 });
    expect(() => loadConfig({ ...base, DAILY_TOKEN_CAP: '-1' })).toThrow(/DAILY_TOKEN_CAP/);
  });
});
