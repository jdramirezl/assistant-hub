import { describe, expect, it } from 'vitest';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { createHub } from '../src/hub.js';
import { testConfig } from './helpers.js';

describe('createHub', () => {
  it('boots a Mastra instance bound to loopback:4111 with persistent storage', () => {
    const hub = createHub(testConfig());
    expect(hub.getServer()).toMatchObject({ host: '127.0.0.1', port: 4111 });
    expect(hub.getStorage()).toBeDefined();
  });

  it('registers the assistant agent', async () => {
    const hub = createHub(testConfig(), {
      model: createMockModel({ mockText: 'pong', version: 'v2' }) as never,
    });
    const res = await hub.getAgentById('assistant').generate('ping');
    expect(res.text).toBe('pong');
  });
});
