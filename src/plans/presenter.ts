import { TelegramApi } from '../telegram-api.js';
import type { Language } from '../persona.js';
import { renderPlan } from './render.js';
import type { StoredPlan } from './types.js';

/** Where plans are shown and decided. Telegram in production; the log when it's off. */
export interface PlanPresenter {
  /** Show the plan with Approve all / Edit / Cancel; returns the message ids. */
  show(plan: StoredPlan): Promise<number[]>;
  /** Replace the plan's buttons with a status line (Running…, Done, Cancelled, …). */
  update(plan: StoredPlan, status: string): Promise<void>;
  /** A separate message to the owner (refusals, edit prompt, the result summary). */
  say(text: string): Promise<void>;
}

export class TelegramPlanPresenter implements PlanPresenter {
  constructor(
    private readonly api: TelegramApi,
    private readonly chatId: string,
    private readonly lang: Language,
    private readonly ttlMinutes: number,
    private readonly log: (m: string) => void,
  ) {}

  async show(plan: StoredPlan): Promise<number[]> {
    const { chunks, keyboard } = renderPlan(plan, this.lang, this.ttlMinutes);
    const ids: number[] = [];
    for (const [i, chunk] of chunks.entries()) {
      ids.push(await this.api.send(this.chatId, chunk, i === chunks.length - 1 ? keyboard : undefined));
    }
    return ids;
  }

  async update(plan: StoredPlan, status: string): Promise<void> {
    const last = plan.messageIds.at(-1);
    if (last === undefined) return void (await this.say(status));
    const { chunks } = renderPlan(plan, this.lang, this.ttlMinutes);
    const base = chunks.at(-1)!.replace(/\n\n⏳ [^\n]*$/, ''); // drop the "expires" footer
    await this.api.editFinal(this.chatId, last, `${base}\n\n${status}`).catch((err: Error) => this.log(`[plan] edit failed: ${err.message}`));
  }

  async say(text: string): Promise<void> {
    await this.api.send(this.chatId, text).catch((err: Error) => this.log(`[plan] send failed: ${err.message}`));
  }
}

/** Telegram is off (Studio-only): plans are only logged and can't be approved. */
export class LogPlanPresenter implements PlanPresenter {
  constructor(
    private readonly lang: Language,
    private readonly log: (m: string) => void,
  ) {}
  async show(plan: StoredPlan): Promise<number[]> {
    this.log(`[plan] (telegram off) ${renderPlan(plan, this.lang).chunks.join('\n')}`);
    return [];
  }
  async update(plan: StoredPlan, status: string): Promise<void> {
    this.log(`[plan] ${plan.id}: ${status}`);
  }
  async say(text: string): Promise<void> {
    this.log(`[plan] ${text}`);
  }
}
