import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { loadConfig } from '../src/config.js';
import { createHub } from '../src/hub.js';
import { createStorage, createMemory, WORKING_MEMORY_TEMPLATE } from '../src/memory.js';

const dirs: string[] = [];
function tempDataDir() {
  const d = join(mkdtempSync(join(tmpdir(), 'hub-mem-')), 'nested', 'data');
  dirs.push(d);
  return d;
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('memory', () => {
  it('creates the data directory and the LibSQL file at an absolute path', async () => {
    const dataDir = tempDataDir();
    const cfg = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: dataDir });
    const storage = createStorage(cfg);
    await storage.init();
    expect(existsSync(cfg.dbPath)).toBe(true);
  });

  it('uses a resource-scoped working memory template with preferences', () => {
    expect(WORKING_MEMORY_TEMPLATE).toMatch(/Default currency/);
    expect(WORKING_MEMORY_TEMPLATE).toMatch(/Pockets/);
  });

  it('persists conversation and working memory across a full re-instantiation', async () => {
    const dataDir = tempDataDir();
    const env = { NODE_ENV: 'test', HUB_DATA_DIR: dataDir, TELEGRAM_ALLOWED_USER_IDS: '42' };
    const thread = 't-1';

    // --- first process lifetime
    {
      const cfg = loadConfig(env);
      const hub = createHub(cfg, { model: createMockModel({ mockText: 'anotado', version: 'v2' }) as never });
      await hub
        .getAgentById('assistant')
        .generate('Mi moneda por defecto es COP', { memory: { thread, resource: cfg.resourceId } });
      const memory = createMemory(createStorage(cfg));
      await memory.updateWorkingMemory({
        threadId: thread,
        resourceId: cfg.resourceId,
        workingMemory: '# User preferences\n- Default currency: COP',
      });
    }

    // --- second process lifetime (new storage + memory objects)
    const cfg = loadConfig(env);
    expect(cfg.resourceId).toBe('telegram:42');
    const memory = createMemory(createStorage(cfg));
    const { messages } = await memory.recall({ threadId: thread, resourceId: cfg.resourceId });
    const texts = JSON.stringify(messages);
    expect(texts).toContain('Mi moneda por defecto es COP');
    expect(texts).toContain('anotado');

    // working memory is resource-scoped: visible from a different thread
    const wm = await memory.getWorkingMemory({ threadId: 'another-thread', resourceId: cfg.resourceId });
    expect(wm).toContain('Default currency: COP');
  });
});
