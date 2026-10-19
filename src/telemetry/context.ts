import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { Domain, Intent, Media } from './intent.js';

/** What a model HTTP call belongs to. Set around each chat turn, resume, plan run and digest. */
export interface UsageScope {
  requestId: string;
  intent: Intent | 'digest' | 'resume';
  media: Media;
  /** chat = user message; resume = approval card; plan = approved plan summary; digest = weekly report. */
  kind: 'chat' | 'resume' | 'plan' | 'digest' | 'transcribe' | 'other';
  /** Calls made so far in this request (step number of the next one). */
  seq: number;
  /** App tool sets for this request (omit = all). */
  domains?: Domain[];
  /** The user's message text for this request (a voice note's transcript). Never logged. */
  text?: string;
  /** Language of a voice note (ISO 639-1), from its transcription. */
  language?: string;
  /** Telegram chat of the request (private chat id = user id), for hub-sent photos/prompts. */
  chatId?: string;
}

export const usageContext = new AsyncLocalStorage<UsageScope>();

export function newRequestId(): string {
  return randomBytes(5).toString('base64url');
}

export function withUsageScope<T>(scope: Omit<UsageScope, 'seq'> & { seq?: number }, fn: () => T): T {
  return usageContext.run({ seq: 0, ...scope }, fn);
}
