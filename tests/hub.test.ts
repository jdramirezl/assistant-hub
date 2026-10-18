import { describe, expect, it } from 'vitest';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { loadConfig } from '../src/config.js';
import { createHub } from '../src/hub.js';

describe('createHub', () => {
  it('boots a Mastra instance bound to loopback:4111', () => {
    const hub = createHub(loadConfig({ NODE_ENV: 'test' }));
    expect(hub.getServer()).toMatchObject({ host: '127.0.0.1', port: 4111 });
  });

  it('registers the assistant agent', async () => {
    const hub = createHub(loadConfig({ NODE_ENV: 'test' }), {
      model: createMockModel({ mockText: 'pong', version: 'v2' }) as never,
    });
    const res = await hub.getAgentById('assistant').generate('ping');
    expect(res.text).toBe('pong');
  });
});
