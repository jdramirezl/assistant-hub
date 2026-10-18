import { Mastra } from '@mastra/core/mastra';
import type { TelegramProvider } from '@mastra/telegram';
import type { HubConfig } from './config.js';
import { createAssistantAgent, ASSISTANT_ID, type AssistantOptions } from './agents/assistant.js';
import { createDbClient, createKv, createMemory, createStorage } from './memory.js';
import { createTelegramChannel, connectTelegram, type TelegramDeps } from './channels/telegram.js';
import type { KvStore } from './kv.js';
import { loadRegistry, parseRegistry } from './mcp/registry.js';
import { McpToolbox } from './mcp/toolbox.js';

export interface HubDeps {
  /** Test seam: model used by the assistant instead of Gemini. */
  model?: AssistantOptions['model'];
  telegram?: Omit<TelegramDeps, 'kv'>;
  /** Inline registry (tests); default: load config.mcpRegistryPath. */
  registry?: unknown;
  env?: Record<string, string | undefined>;
}

export interface Hub {
  mastra: Mastra;
  kv: KvStore;
  toolbox: McpToolbox;
  telegram?: TelegramProvider;
  /** Connect channels (network). Safe to call when Telegram is disabled. */
  start(opts?: { connectRetries?: number }): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Build the hub from config. Every subsystem is created here so tests can build a hub
 * with a temp data dir and mocked dependencies.
 */
export function createHub(config: HubConfig, deps: HubDeps = {}): Hub {
  const client = createDbClient(config);
  const storage = createStorage(config, client);
  const kv = createKv(client);
  const memory = createMemory(storage);
  const registry = deps.registry !== undefined ? parseRegistry(deps.registry) : loadRegistry(config.mcpRegistryPath);
  const toolbox = new McpToolbox(registry, deps.env ?? process.env, { log: deps.telegram?.log });
  const assistant = createAssistantAgent({
    timezone: config.timezone,
    model: deps.model,
    memory,
    tools: () => toolbox.getTools(),
    extraInstructions: () => toolbox.statusNote(),
  });
  const telegram = createTelegramChannel(config, {
    ...deps.telegram,
    kv,
  });

  const mastra = new Mastra({
    storage,
    agents: { assistant },
    ...(telegram ? { channels: { telegram } } : {}),
    server: { host: config.server.host, port: config.server.port },
  });

  return {
    mastra,
    kv,
    toolbox,
    telegram,
    async start(opts = {}) {
      await toolbox.getTools(); // discover apps at boot so status is logged early
      if (!telegram || !config.telegram.enabled) return;
      await connectTelegram(telegram, ASSISTANT_ID, {
        botToken: config.telegram.botToken,
        retries: opts.connectRetries,
        log: deps.telegram?.log,
      });
    },
    async stop() {
      await toolbox.close();
      if (!telegram) return;
      const install = await telegram.getInstallation(ASSISTANT_ID);
      if (install) await telegram.getAdapter(install.id)?.stopPolling();
    },
  };
}
