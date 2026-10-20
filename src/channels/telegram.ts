import type { Message, Thread } from 'chat';
import { TelegramProvider } from '@mastra/telegram';
import type { ChannelHandler, ChannelHandlers, ToolDisplayEvent, ToolDisplayFn, ToolDisplayResult } from '@mastra/core/channels';
import type { HubConfig } from '../config.js';
import type { KvStore } from '../kv.js';
import { describeModelError, rateLimitContext } from '../llm/rate-limit.js';
import type { Voice } from '../persona.js';
import { classifyIntent, domainsFor, mediaOf, type Domain } from '../telemetry/intent.js';
import { newRequestId, usageContext, withUsageScope } from '../telemetry/context.js';
import type { Transcribe } from '../voice/transcribe.js';
import type { StatusTracker } from '../status/tracker.js';

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
  /**
   * Checked before the agent runs. Return a message to reply with *instead of* running the
   * agent (e.g. the daily budget is used up); undefined to proceed.
   */
  gate?: (requestId: string) => Promise<string | undefined>;
  /** Live status message per request (received → working → result). */
  status?: (chatId: string, requestId: string) => StatusTracker;
  /** Persona wording for rate-limit notices. */
  voice?: Voice;
  /** Batch-plan buttons (plan:<a|e|c>:<id>); everything else goes to the built-in approvals. */
  onPlanAction?: (actionId: string, userId: string | undefined, notify: (text: string) => Promise<void>) => Promise<void>;
  /** Slash commands answered by the hub without the model (e.g. /usage); return the reply text. */
  commands?: Record<string, () => Promise<string>>;
  /** Voice-note transcription before the agent (omit: the audio goes to the agent as a file). */
  transcribe?: Transcribe;
  /** Custom approval card for some tools (e.g. a cines purchase summary); undefined = built-in. */
  approvalCard?: (event: ToolDisplayEvent) => ToolDisplayResult | undefined;
  /** Secure input: the user's next message goes to a tool, never to the model. */
  secureInput?: SecureInputPort;
  /**
   * Deterministic shortcuts before the agent (e.g. a seat pick after a seat map): a `reply` is
   * posted instead of running the agent; an `agentText` replaces the user's message for it.
   */
  preAgent?: (chatId: string, text: string) => Promise<{ reply?: string; agentText?: string } | undefined>;
}

type Pending = { requestId: string; kind: string; expiresAt: number; expired?: boolean };
export interface SecureInputPort {
  /** Pending request; `expired` = lapsed recently (only a late secret is swallowed). */
  pending(chatId: string): Promise<Pending | undefined>;
  cancel(chatId: string): Promise<void>;
  /** Does this text look like the secret of that kind (a late reply after expiry)? */
  looksLikeSecret(kind: string, text: string): boolean;
  /** Deliver the value; returns the text the agent gets instead (never the value), and/or a text for the user. */
  deliver(chatId: string, value: string, p: Pending): Promise<{ agentText?: string; userText?: string }>;
}

const CANCEL = /^\s*(cancel|cancelar|cancela|stop|para|no)\s*[.!]?\s*$/i;

/** Last request's domains per user, so a short follow-up ("la de las 20:30", "sí", a button) keeps them. */
type RecentTopics = Map<string, { domains: Domain[]; at: number }>;

/** How long a conversation topic (e.g. cines) carries over to unclear follow-ups. */
export const STICKY_MS = 20 * 60_000;

/** Prefix of a transcribed voice note in the agent's (and memory's) user message. */
export const VOICE_PREFIX = '[voice note] ';

/**
 * Replace a voice note's audio with its transcript, in place (the channel then sends plain
 * text to the agent). Returns the transcript, or undefined (audio kept) on any failure.
 */
export async function transcribeInPlace(message: Message, transcribe: Transcribe, log: (m: string) => void) {
  const audio = (message.attachments ?? []).find((a) => (a.mimeType ?? '').startsWith('audio/'));
  if (!audio?.fetchData) return undefined;
  let bytes: Uint8Array;
  try {
    const buf = await audio.fetchData();
    bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf as Uint8Array);
  } catch (err) {
    log(`[voice] could not download the voice note: ${(err as Error).message}`);
    return undefined;
  }
  const t = await transcribe(bytes, audio.mimeType!);
  if (!t) return undefined;
  const caption = (message.text ?? '').trim();
  message.text = `${VOICE_PREFIX}${t.transcript}${caption ? `\n${caption}` : ''}`;
  message.formatted = undefined as never;
  message.attachments = (message.attachments ?? []).filter((a) => a !== audio);
  return t;
}

/**
 * Keep the chat clean: only approval cards (built-in Approve/Deny buttons) and short failure
 * notes are shown. Successful calls and internal tools (working memory) stay invisible; the
 * agent's reply already says what happened.
 */
export const toolDisplay: ToolDisplayFn = (_event) => {
  // undefined → built-in card with buttons for approvals; tool failures are reported by the
  // request's status message (translated, with the request id), not as raw tool errors
  return undefined;
};

/** A resumed (approved) run that never reports its end still closes its status message. */
const RESUME_FINISH_TIMEOUT_MS = 25 * 60_000; // a purchase may wait ~15 min for PayPal at the Mac

/** Media that get an immediate "📥 received" status. */
const RECEIVED_MEDIA = new Set(['voice', 'photo', 'pdf']);

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
function guarded(
  allowed: readonly string[],
  kv: KvStore | undefined,
  log: (m: string) => void,
  gate?: (requestId: string) => Promise<string | undefined>,
  voice?: Voice,
  transcribe?: Transcribe,
  secure?: SecureInputPort,
  recent: RecentTopics = new Map(),
  status?: (chatId: string, requestId: string) => StatusTracker,
  preAgent?: TelegramDeps['preAgent'],
): ChannelHandler {
  return async (thread: Thread, message: Message, defaultHandler) => {
    if (!thread.isDM) return log(`[telegram] ignoring non-DM message in ${thread.id}`);
    if (!isAllowed(allowed, message)) return log(`[telegram] ignoring message from non-allowlisted user ${message.author?.userId}`);
    if (kv && !(await kv.setIfNotExists(`telegram:handled:${message.id}`, Date.now(), DEDUP_TTL_MS))) {
      return log(`[telegram] skipping duplicate message ${message.id}`);
    }
    const chatId = String(message.author?.userId ?? '');
    // Secure input: this message is a secret for a tool. It never reaches the model, memory,
    // logs or llm_calls; it is deleted from the chat and replaced by the (redacted) tool result.
    let resumed: string | undefined;
    let pendingSecret = secure ? await secure.pending(chatId).catch(() => undefined) : undefined;
    if (pendingSecret?.expired && !secure!.looksLikeSecret(pendingSecret.kind, message.text ?? '')) {
      await secure!.cancel(chatId); // lapsed and this is an ordinary message: handle it normally
      pendingSecret = undefined;
    }
    if (pendingSecret) {
      const value = message.text ?? '';
      message.text = '';
      message.formatted = undefined as never;
      await thread.adapter.deleteMessage(thread.id, message.id).catch((e: Error) => log(`[secure] could not delete the message: ${e.message.split('\n')[0]}`));
      if (CANCEL.test(value) && !pendingSecret.expired) {
        await secure!.cancel(chatId);
        log('[secure] cancelled by the user');
        resumed = '[hub] The user cancelled the private code request. Nothing was sent. Ask what they want to do (e.g. release the hold).';
      } else {
        log(`[secure] reply for ${pendingSecret.kind} taken (not shown to the model)`);
        const r = await secure!.deliver(chatId, value, pendingSecret).catch((e: Error) => ({ agentText: `[hub] Delivering the private code failed: ${e.message.split('\n')[0]}`, userText: undefined }));
        if (r.userText) await thread.post(r.userText);
        if (!r.agentText) return;
        resumed = r.agentText;
      }
      message.text = resumed;
      message.attachments = [];
    }
    const requestId = newRequestId();
    const blocked = await gate?.(requestId);
    if (blocked) {
      await thread.post(blocked);
      return;
    }
    const notify = async (text: string) => void (await thread.post(text));
    const media = mediaOf(message.attachments ?? []);
    const tracker = status?.(chatId, requestId);
    await withUsageScope({ requestId, intent: 'chat', media, kind: 'chat', status: tracker }, () =>
      rateLimitContext.run({ notify, format: voice?.rateLimit, waiting: voice?.waiting, ...(tracker ? { onQuota: (s: number) => tracker.quota(s), onPacing: () => tracker.pacing() } : {}) }, async () => {
        const scope = usageContext.getStore()!;
        scope.chatId = chatId;
        tracker?.start();
        try {
          await route();
        } finally {
          await tracker?.finish().catch((e: Error) => log(`[status] ${e.message}`));
        }
      }),
    );

    async function route() {
      const scope = usageContext.getStore()!;
      log(`[req ${requestId}] [telegram] ${resumed ? 'secure input' : media} message`);
        if (resumed) {
          scope.text = resumed;
          scope.intent = 'cines';
          scope.domains = ['cines'];
          recent.set(chatId, { domains: scope.domains, at: Date.now() });
          return defaultHandler(thread, message);
        }
        // a seat pick right after a seat map: the hub checks it itself (no model wandering)
        if (preAgent && media === 'text' && message.text) {
          const r = await preAgent(chatId, message.text).catch((e: Error) => (log(`[telegram] preAgent failed: ${e.message.split('\n')[0]}`), undefined));
          if (r?.reply) {
            await thread.post(r.reply);
            return;
          }
          if (r?.agentText) {
            message.text = r.agentText;
            message.formatted = undefined as never;
            scope.text = r.agentText;
            scope.intent = 'cines';
            scope.domains = ['cines'];
            recent.set(chatId, { domains: scope.domains, at: Date.now() });
            return defaultHandler(thread, message);
          }
        }
        // a voice note / photo takes a while: say it arrived instead of silence
        if (tracker && RECEIVED_MEDIA.has(media)) await tracker.received(media as 'voice' | 'photo' | 'pdf');
        // a transcribed voice note is routed like the text it says
        const t = media === 'voice' && transcribe ? await transcribeInPlace(message, transcribe, log) : undefined;
        if (t && tracker) {
          tracker.setLanguage(t.language === 'en' || t.language === 'es' ? t.language : undefined);
          tracker.transcribed(t.transcript);
        }
        const routed = t ? 'text' : media;
        scope.text = message.text ?? '';
        scope.intent = classifyIntent(scope.text, routed);
        const user = String(message.author?.userId ?? '');
        const last = recent.get(user);
        const sticky = last && Date.now() - last.at < STICKY_MS ? last.domains : undefined;
        scope.domains = domainsFor(scope.text, routed, sticky);
        // a short follow-up in a cines conversation is a cines request
        if (scope.intent === 'chat' && sticky?.includes('cines') && scope.domains.includes('cines')) scope.intent = 'cines';
        recent.set(user, { domains: scope.domains, at: Date.now() });
        if (t?.language) scope.language = t.language;
        return defaultHandler(thread, message);
    }
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

  const recent: RecentTopics = new Map();
  const handler = guarded(config.telegram.allowedUserIds, deps.kv, log, deps.gate, deps.voice, deps.transcribe, deps.secureInput, recent, deps.status, deps.preAgent);
  const display: ToolDisplayFn = (event, ctx) => {
    usageContext.getStore()?.status?.onToolEvent(event);
    return deps.approvalCard?.(event) ?? toolDisplay(event, ctx);
  };
  const handlers: ChannelHandlers = {
    onDirectMessage: handler,
    onSubscribedMessage: handler,
    onMention: handler,
    onSlashCommand: async (event, defaultHandler) => {
      const userId = event.user?.userId;
      if (!userId || !config.telegram.allowedUserIds.includes(String(userId))) {
        return log(`[telegram] ignoring /command from non-allowlisted user ${userId}`);
      }
      const name = event.command.replace(/^\//, '').split('@')[0]!.toLowerCase();
      const own = deps.commands?.[name];
      if (own) return void (await event.channel.post(await own()));
      await withUsageScope({ requestId: newRequestId(), intent: 'chat', media: 'text', kind: 'chat' }, () => defaultHandler());
    },
    onAction: async (event, defaultHandler) => {
      if (!event.actionId.startsWith('plan:')) {
        const chatId = event.user?.userId ? String(event.user.userId) : undefined;
        // an approval resumes the same conversation: keep its topic's tools (fewer tokens)
        const last = chatId ? recent.get(chatId) : undefined;
        const domains = last && Date.now() - last.at < STICKY_MS ? last.domains : undefined;
        const requestId = newRequestId();
        const tracker = chatId ? deps.status?.(chatId, requestId) : undefined;
        return withUsageScope({ requestId, intent: 'resume', media: 'text', kind: 'resume', chatId, status: tracker, ...(domains ? { domains } : {}) }, () =>
          rateLimitContext.run({ notify: async () => {}, ...(tracker ? { onQuota: (s: number) => tracker.quota(s), onPacing: () => tracker.pacing() } : {}) }, async () => {
            // Mastra resumes the approved tool in the background: the RUN's end closes the
            // status message (StatusRunEnd), with a safety timeout
            if (tracker) {
              tracker.closeOnRunEnd = true;
              setTimeout(() => void tracker.finish().catch(() => {}), RESUME_FINISH_TIMEOUT_MS).unref?.();
            }
            await defaultHandler();
          }),
        );
      }
      const userId = event.user?.userId;
      if (!userId || !config.telegram.allowedUserIds.includes(String(userId))) {
        return log(`[telegram] ignoring plan button from non-allowlisted user ${userId}`);
      }
      const notify = async (text: string) => void (await event.thread?.post(text));
      await withUsageScope({ requestId: newRequestId(), intent: 'plan', media: 'text', kind: 'plan' }, () =>
        rateLimitContext.run({ notify, format: deps.voice?.rateLimit, waiting: deps.voice?.waiting }, () =>
          deps.onPlanAction ? deps.onPlanAction(event.actionId, String(userId), notify) : Promise.resolve(),
        ),
      );
    },
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
      { command: 'usage', description: 'Gemini usage today and last 7 days' },
      { command: 'estado', description: 'Estado: apps, cuota, presupuesto, últimos fallos' },
    ],
    resolveResourceId: ({ defaultResourceId }) => defaultResourceId, // telegram:<userId>
    tools: false, // no reaction tools; keep the tool list for app MCPs
    // A display function enables Approve/Deny inline-keyboard buttons for approval-gated tools
    // (with the default 'text' they would stay suspended with no way to answer).
    toolDisplay: display,
    formatError: (err: Error) => {
      // the request's status message shows the translated failure with its request id
      const tracker = usageContext.getStore()?.status;
      if (tracker) {
        tracker.failed(err);
        return '';
      }
      return describeModelError(err, deps.voice);
    },
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
