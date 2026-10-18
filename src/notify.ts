import type { HubConfig } from './config.js';

export interface NotifierDeps {
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  log?: (m: string) => void;
}

export type Notify = (text: string) => Promise<void>;

const TELEGRAM_MAX = 4096;

/**
 * Proactive messages (digests, "I'm up") to the owner. Uses a plain Bot API `sendMessage`,
 * so it also works from one-off scripts while the service holds the long-poll.
 * Never throws; falls back to the log when Telegram isn't configured.
 */
export function createNotifier(config: HubConfig, deps: NotifierDeps = {}): Notify {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const doFetch = deps.fetch ?? fetch;
  return async (text: string) => {
    if (!config.telegram.enabled) {
      log(`[notify] (telegram off) ${text}`);
      return;
    }
    const base = deps.apiBaseUrl ?? 'https://api.telegram.org';
    const chatId = config.telegram.allowedUserIds[0]!;
    const body = text.length > TELEGRAM_MAX ? `${text.slice(0, TELEGRAM_MAX - 1)}…` : text;
    try {
      const res = await doFetch(`${base}/bot${config.telegram.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: body }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) log(`[notify] telegram sendMessage failed: HTTP ${res.status}`);
    } catch (err) {
      log(`[notify] telegram sendMessage failed: ${(err as Error).message}`);
    }
  };
}
