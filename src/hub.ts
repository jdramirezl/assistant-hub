import { Mastra } from '@mastra/core/mastra';
import type { TelegramProvider } from '@mastra/telegram';
import type { HubConfig } from './config.js';
import { createAssistantAgent, ASSISTANT_ID, type AssistantOptions } from './agents/assistant.js';
import { createDbClient, createKv, createMemory, createStorage } from './memory.js';
import { createTelegramChannel, connectTelegram, type TelegramDeps } from './channels/telegram.js';
import type { KvStore } from './kv.js';
import { loadRegistry, parseRegistry } from './mcp/registry.js';
import { McpToolbox } from './mcp/toolbox.js';
import { Budget, BudgetGuard, BUDGET_MESSAGE } from './budget.js';

export interface HubDeps {
  /** Test seam: model used by the assistant instead of Gemini. */
  model?: AssistantOptions['model'];
  telegram?: Omit<TelegramDeps, 'kv' | 'gate'>;
  /** Inline registry (tests); default: load config.mcpRegistryPath. */
  registry?: unknown;
  env?: Record<string, string | undefined>;
  /** Clock for budget/scheduling (tests). */
  now?: () => number;
}

export interface Hub {
  mastra: Mastra;
  kv: KvStore;
  toolbox: McpToolbox;
  budget: Budget;
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
  const budget = new Budget(kv, config.budget, config.timezone, deps.now);
  const registry = deps.registry !== undefined ? parseRegistry(deps.registry) : loadRegistry(config.mcpRegistryPath);
  const toolbox = new McpToolbox(registry, deps.env ?? process.env, { log: deps.telegram?.log });
  const assistant = createAssistantAgent({
    timezone: config.timezone,
    model: deps.model,
    memory,
    tools: () => toolbox.getTools(),
    extraInstructions: () => toolbox.statusNote(),
    guards: [new BudgetGuard(budget, (s) => (deps.telegram?.log ?? console.warn)(`[budget] blocked: ${s.tokens} tokens, $${s.costUsd.toFixed(4)} on ${s.day}`))],
  });
  const telegram = createTelegramChannel(config, {
    ...deps.telegram,
    kv,
    gate: async () => ((await budget.check()).ok ? undefined : BUDGET_MESSAGE),
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
    budget,
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
