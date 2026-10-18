import { Mastra } from '@mastra/core/mastra';
import type { HubConfig } from './config.js';

/**
 * Build the Mastra instance from config. Every subsystem is created here so tests
 * can build a hub with a temp data dir and mocked dependencies.
 */
export function createHub(config: HubConfig): Mastra {
  return new Mastra({
    server: { host: config.server.host, port: config.server.port },
  });
}
