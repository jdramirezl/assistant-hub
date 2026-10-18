import { Mastra } from '@mastra/core/mastra';
import type { HubConfig } from './config.js';
import { createAssistantAgent, type AssistantOptions } from './agents/assistant.js';

export interface HubDeps {
  /** Test seam: model used by the assistant instead of Gemini. */
  model?: AssistantOptions['model'];
}

/**
 * Build the Mastra instance from config. Every subsystem is created here so tests
 * can build a hub with a temp data dir and mocked dependencies.
 */
export function createHub(config: HubConfig, deps: HubDeps = {}): Mastra {
  const assistant = createAssistantAgent({ timezone: config.timezone, model: deps.model });
  return new Mastra({
    agents: { assistant },
    server: { host: config.server.host, port: config.server.port },
  });
}
