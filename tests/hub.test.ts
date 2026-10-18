import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createHub } from '../src/hub.js';

describe('createHub', () => {
  it('boots a Mastra instance bound to loopback:4111', () => {
    const hub = createHub(loadConfig({ NODE_ENV: 'test' }));
    expect(hub.getServer()).toMatchObject({ host: '127.0.0.1', port: 4111 });
  });
});
