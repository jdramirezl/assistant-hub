import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type HubConfig } from '../src/config.js';

/** Test config with an isolated temp data dir (never touches ~/Library). */
export function testConfig(env: Record<string, string> = {}): HubConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'hub-test-'));
  return loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: dataDir, ...env });
}
