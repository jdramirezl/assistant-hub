import { Agent } from '@mastra/core/agent';
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
import { modelChain } from './models.js';
import { createNotifier, type Notify } from './notify.js';
import { Digest, type DigestResult, type DigestSection } from './digest.js';
import { createDigestWorkflow } from './workflows/weekly-digest.js';

export interface HubDeps {
  /** Test seam: model used by the assistant and reporter instead of Gemini. */
  model?: AssistantOptions['model'];
  telegram?: Omit<TelegramDeps, 'kv' | 'gate'>;
  /** Inline registry (tests); default: load config.mcpRegistryPath. */
  registry?: unknown;
  env?: Record<string, string | undefined>;
  /** Clock for budget/scheduling (tests). */
  now?: () => number;
  /** Per-app weekly digest sections (empty until the app forks provide them). */
  digestSections?: DigestSection[];
}

export interface Hub {
  mastra: Mastra;
  kv: KvStore;
  toolbox: McpToolbox;
  budget: Budget;
  digest: Digest;
  notify: Notify;
  telegram?: TelegramProvider;
  /** Connect channels (network) and catch up a missed digest. Safe without Telegram. */
  start(opts?: { connectRetries?: number }): Promise<void>;
  /** Run the weekly-digest workflow now. */
  runDigest(input?: { trigger?: string; force?: boolean }): Promise<DigestResult | undefined>;
  stop(): Promise<void>;
}

const REPORTER_INSTRUCTIONS =
  "You write the user's periodic reports (finance, fitness, …) for Telegram. Be concise, concrete and friendly. Never invent numbers.";

/**
 * Build the hub from config. Every subsystem is created here so tests can build a hub
 * with a temp data dir and mocked dependencies.
 */
export function createHub(config: HubConfig, deps: HubDeps = {}): Hub {
  const log = deps.telegram?.log ?? ((m: string) => console.warn(m));
  const client = createDbClient(config);
  const storage = createStorage(config, client);
  const kv = createKv(client);
  const memory = createMemory(storage);
  const budget = new Budget(kv, config.budget, config.timezone, deps.now);
  const guard = new BudgetGuard(budget, (s) => log(`[budget] blocked: ${s.tokens} tokens, $${s.costUsd.toFixed(4)} on ${s.day}`));
  const registry = deps.registry !== undefined ? parseRegistry(deps.registry) : loadRegistry(config.mcpRegistryPath);
  const toolbox = new McpToolbox(registry, deps.env ?? process.env, { log });

  const assistant = createAssistantAgent({
    timezone: config.timezone,
    model: deps.model,
    memory,
    tools: () => toolbox.getTools(),
    extraInstructions: () => toolbox.statusNote(),
    guards: [guard],
  });
  const reporter = new Agent({
    id: 'reporter',
    name: 'Reporter',
    description: 'Writes the weekly digest on the stronger model',
    instructions: REPORTER_INSTRUCTIONS,
    model: (deps.model ?? modelChain('report')) as never,
    inputProcessors: [guard],
    outputProcessors: [guard],
  });

  const notify = createNotifier(config, { apiBaseUrl: deps.telegram?.apiBaseUrl, log });
  const digest = new Digest({
    kv,
    sections: deps.digestSections ?? [],
    compose: async (prompt) => (await reporter.generate(prompt)).text,
    notify,
    timezone: config.timezone,
    now: deps.now,
    log,
  });
  const weeklyDigest = createDigestWorkflow(digest, config.timezone);

  const telegram = createTelegramChannel(config, {
    ...deps.telegram,
    kv,
    gate: async () => ((await budget.check()).ok ? undefined : BUDGET_MESSAGE),
  });

  const mastra = new Mastra({
    storage,
    agents: { assistant, reporter },
    workflows: { weeklyDigest },
    ...(telegram ? { channels: { telegram } } : {}),
    server: { host: config.server.host, port: config.server.port },
  });

  async function runDigest(input: { trigger?: string; force?: boolean } = {}) {
    const run = await mastra.getWorkflow('weeklyDigest').createRun();
    const res = await run.start({ inputData: { trigger: input.trigger ?? 'manual', force: input.force ?? false } });
    if (res.status !== 'success') {
      log(`[digest] workflow ${res.status}${'error' in res && res.error ? `: ${String((res.error as Error).message ?? res.error)}` : ''}`);
      return undefined;
    }
    return res.result as DigestResult;
  }

  return {
    mastra,
    kv,
    toolbox,
    budget,
    digest,
    notify,
    telegram,
    runDigest,
    async start(opts = {}) {
      await toolbox.getTools(); // discover apps at boot so status is logged early
      if (telegram && config.telegram.enabled) {
        await connectTelegram(telegram, ASSISTANT_ID, {
          botToken: config.telegram.botToken,
          retries: opts.connectRetries,
          log,
        });
      }
      try {
        if (await digest.isMissed()) await runDigest({ trigger: 'catch-up' });
      } catch (err) {
        log(`[digest] catch-up failed: ${(err as Error).message}`);
      }
    },
    async stop() {
      await toolbox.close();
      if (!telegram) return;
      const install = await telegram.getInstallation(ASSISTANT_ID);
      if (install) await telegram.getAdapter(install.id)?.stopPolling();
    },
  };
}
