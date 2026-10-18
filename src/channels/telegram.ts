import type { Message, Thread } from 'chat';
import { TelegramProvider } from '@mastra/telegram';
import type { ChannelHandler, ChannelHandlers } from '@mastra/core/channels';
import type { HubConfig } from '../config.js';
import type { KvStore } from '../kv.js';

/** Media sent to Gemini as file parts: receipts/meal photos and voice notes. */
export const INLINE_MEDIA = ['image/*', 'audio/*', 'application/pdf'];

/** Telegram keeps undelivered updates for 24h; remember handled messages a bit longer. */
export const DEDUP_TTL_MS = 48 * 60 * 60 * 1000;

export interface TelegramDeps {
  /** Override the Bot API origin (tests point this at a mock server). */
  apiBaseUrl?: string;
  /** Persistent store for handled-message ids (dedup across restarts). */
  kv?: KvStore;
  /** Faster polling in tests. */
  longPolling?: { timeout?: number; retryDelayMs?: number };
  log?: (msg: string) => void;
}

/** Defense in depth: the adapter also filters by TELEGRAM_ALLOWED_USER_IDS. */
export function isAllowed(allowed: readonly string[], message: Pick<Message, 'author'>): boolean {
  const id = message.author?.userId;
  return allowed.length > 0 && id !== undefined && allowed.includes(String(id));
}

/**
 * Allowlist + DM-only + persisted dedup in front of the default agent handler.
 *
 * Dedup is at-most-once on purpose: the message id is claimed before the agent runs, so a
 * crash mid-turn drops that message instead of replaying it (a replay could duplicate a
 * write such as a finance movement). The user just resends.
 */
function guarded(allowed: readonly string[], kv: KvStore | undefined, log: (m: string) => void): ChannelHandler {
  return async (thread: Thread, message: Message, defaultHandler) => {
    if (!thread.isDM) return log(`[telegram] ignoring non-DM message in ${thread.id}`);
    if (!isAllowed(allowed, message)) return log(`[telegram] ignoring message from non-allowlisted user ${message.author?.userId}`);
    if (kv && !(await kv.setIfNotExists(`telegram:handled:${message.id}`, Date.now(), DEDUP_TTL_MS))) {
      return log(`[telegram] skipping duplicate message ${message.id}`);
    }
    await defaultHandler(thread, message);
  };
}

/**
 * Build the Telegram channel, or `undefined` (Studio-only mode) when the bot isn't configured.
 * Long polling only: the Mac makes outbound connections, no webhook/ports.
 */
export function createTelegramChannel(config: HubConfig, deps: TelegramDeps = {}): TelegramProvider | undefined {
  const log = deps.log ?? ((m: string) => console.warn(m));
  if (!config.telegram.enabled) {
    log(`[telegram] disabled (${config.telegram.disabledReason}); running in Studio-only mode`);
    return undefined;
  }
  // The adapter reads its allowlist from this env var; make it match config exactly.
  process.env.TELEGRAM_ALLOWED_USER_IDS = config.telegram.allowedUserIds.join(',');

  const handler = guarded(config.telegram.allowedUserIds, deps.kv, log);
  const handlers: ChannelHandlers = {
    onDirectMessage: handler,
    onSubscribedMessage: handler,
    onMention: handler,
  };

  return new TelegramProvider({
    mode: 'polling',
    botToken: config.telegram.botToken,
    ...(deps.apiBaseUrl ? { apiBaseUrl: deps.apiBaseUrl } : {}),
    ...(deps.longPolling ? { longPolling: deps.longPolling } : {}),
    inlineMedia: INLINE_MEDIA,
    handlers,
    commandScope: { type: 'all_private_chats' },
    commands: [
      { command: 'start', description: 'Say hi' },
      { command: 'help', description: 'What I can do' },
    ],
    resolveResourceId: ({ defaultResourceId }) => defaultResourceId, // telegram:<userId>
    tools: false, // no reaction tools; keep the tool list for app MCPs
  });
}

/**
 * Connect the assistant to the bot, retrying with backoff so a network blip at boot
 * doesn't leave the bot dead. Never throws.
 *
 * The installation is persisted in Mastra storage, so after a restart we restore it
 * (`initialize`) instead of connecting again. A changed token (e.g. dev → prod bot)
 * replaces the old installation.
 */
export async function connectTelegram(
  provider: TelegramProvider,
  agentId: string,
  opts: { botToken?: string; retries?: number; baseDelayMs?: number; log?: (m: string) => void } = {},
): Promise<boolean> {
  const { retries = 8, baseDelayMs = 2_000, log = (m: string) => console.warn(m) } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      const existing = await provider.getInstallation(agentId);
      if (existing?.status === 'active' && (!opts.botToken || existing.botToken === opts.botToken)) {
        await provider.initialize();
        log('[telegram] restored installation (long polling)');
      } else {
        if (existing) await provider.disconnect(agentId);
        await provider.connect(agentId, opts.botToken ? { botToken: opts.botToken } : {});
        log('[telegram] connected (long polling)');
      }
      return true;
    } catch (err) {
      if (attempt >= retries) {
        log(`[telegram] giving up connecting: ${(err as Error).message}`);
        return false;
      }
      const delay = Math.min(baseDelayMs * 2 ** attempt, 60_000);
      log(`[telegram] connect failed (${(err as Error).message}); retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
