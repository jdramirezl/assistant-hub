/**
 * The live status message of ONE request: a single Telegram message that goes
 * received → working → result by editing itself (throttled), separate from Alfred's answer.
 *
 * - media (voice/photo/pdf): "📥 received" right away
 * - after WORKING_AFTER_MS without an answer: "⏳ <what it is doing>"
 * - a real Gemini 429: "⏸️ quota wait" (never for the hub's own pacing)
 * - at the end, from the TOOL RESULTS (not the model's words): ✅ done / ⚠️ partial / ❌ failed /
 *   ❓ need info, with `CODE · req id` for failures. A request with nothing to report leaves no
 *   status message (a leftover ⏳ is deleted).
 */
import type { ToolDisplayEvent } from '@mastra/core/channels';
import { codeOfModelError, explain, type Lang } from './errors.js';
import { toHtml, type StatusMessages, type StatusText } from './messages.js';
import { summarizeOutcome, type ToolOutcome } from './outcome.js';

export const WORKING_AFTER_MS = 8_000;
export const MIN_EDIT_GAP_MS = 1_200;

export interface StatusApi {
  send(chatId: string, html: string): Promise<number>;
  edit(chatId: string, messageId: number, html: string): Promise<void>;
  remove(chatId: string, messageId: number): Promise<void>;
}
export interface FailureRecord {
  at: number;
  requestId: string;
  code: string;
  text: string;
}
export interface TrackerDeps {
  api: StatusApi;
  chatId: string;
  requestId: string;
  msgs: StatusMessages;
  isWrite: (tool: string) => boolean;
  /** Tools that exist (hub-local or served). A call to an invented tool is the model's own slip: never a ❌. */
  isKnown?: (tool: string) => boolean;
  log?: (m: string) => void;
  onFailure?: (f: FailureRecord) => void | Promise<void>;
  now?: () => number;
  workingAfterMs?: number;
  minEditGapMs?: number;
}

export class StatusTracker {
  private messageId?: number;
  private shown = '';
  private queued?: string;
  private lastEdit = -Infinity;
  private chain: Promise<void> = Promise.resolve();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private workingTimer?: ReturnType<typeof setTimeout>;
  private finished = false;
  /** Set for approval resumes: the run's end (not the handler's return) closes the message. */
  closeOnRunEnd = false;
  private activityText?: string;
  private transcript?: string;
  private runError?: unknown;
  /** An approval card (or a plan card) is waiting for the user. */
  private awaiting = false;
  private readonly pending = new Map<string, ToolOutcome>();
  private readonly outcomes: ToolOutcome[] = [];
  private readonly starts = new Map<string, number>();
  private readonly now: () => number;
  msgs: StatusMessages;

  constructor(private readonly d: TrackerDeps) {
    this.now = d.now ?? Date.now;
    this.msgs = d.msgs;
  }

  get requestId() {
    return this.d.requestId;
  }
  /** Use the request's language (e.g. a voice note's) for every later message. */
  setLanguage(lang: Lang | undefined) {
    this.msgs = this.msgs.forLang(lang);
  }

  /** Start the clock: a "⏳ working" message appears if the request takes long. */
  start(): void {
    this.workingTimer = setTimeout(() => this.ensureWorking(), this.d.workingAfterMs ?? WORKING_AFTER_MS);
    this.workingTimer.unref?.();
  }
  received(media: 'voice' | 'photo' | 'pdf'): Promise<void> {
    return this.show(this.msgs.received(media), true);
  }
  transcribed(text: string): void {
    this.transcript = text;
    void this.show(this.msgs.transcribed(text));
  }
  /** The hub's own pacing: just make sure the user sees we are working (no ⏸️). */
  pacing(): void {
    this.ensureWorking();
  }
  /** A REAL Gemini 429: ⏸️ with the wait. */
  quota(seconds: number): void {
    void this.show(this.msgs.quota(seconds), true);
  }
  /** The run failed (formatError): the final state becomes ❌ with the translated cause. */
  failed(err: unknown): void {
    this.runError = err;
  }

  /** Channel tool events (running / result / error / approval). */
  onToolEvent(ev: ToolDisplayEvent): void {
    if (this.finished || /workingmemory/i.test(ev.toolName)) return;
    if (this.d.isKnown && !this.d.isKnown(ev.toolName)) {
      this.d.log?.(`[status] ignored a call to an unknown tool (${ev.toolName}); the model retries`);
      return;
    }
    if (ev.kind === 'running') {
      const n = (this.starts.get(ev.toolName) ?? 0) + 1;
      this.starts.set(ev.toolName, n);
      this.pending.set(ev.toolCallId, { tool: ev.toolName, args: (ev.args ?? {}) as Record<string, unknown> });
      this.activityText = this.msgs.activity(ev.toolName, (ev.args ?? {}) as Record<string, unknown>, n);
      if (this.messageId !== undefined) void this.show(this.msgs.working(this.activityText));
      return;
    }
    if (ev.kind === 'approval') {
      this.awaiting = true;
      return;
    }
    if (ev.kind === 'result' && /"status"\s*:\s*"shown_to_user"/.test(JSON.stringify(ev.result ?? ''))) this.awaiting = true;
    if (ev.kind === 'result' || ev.kind === 'error') {
      const base = this.pending.get(ev.toolCallId) ?? { tool: ev.toolName, args: (ev.args ?? {}) as Record<string, unknown> };
      this.pending.delete(ev.toolCallId);
      this.outcomes.push(ev.kind === 'result' ? { ...base, result: ev.result } : { ...base, thrown: ev.errorText.split('\n')[0] });
    }
  }

  /** Final state; call once when the request is over (also after an approval card). */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.workingTimer);
    let final: StatusText | undefined;
    let code: string | undefined;
    if (this.runError !== undefined) {
      const e = explain(codeOfModelError(this.runError), String((this.runError as Error)?.message ?? ''), this.msgs.lang);
      this.d.log?.(`[status] run failed: ${String((this.runError as Error)?.message ?? this.runError).split('\n')[0]!.slice(0, 300)}`);
      final = this.msgs.runError(e, this.d.requestId);
      code = e.code;
    } else {
      const o = summarizeOutcome(this.outcomes, this.d.isWrite, this.msgs.lang);
      final = this.msgs.outcome(o, this.d.requestId);
      code = o.kind === 'partial' || o.kind === 'failed' ? o.failures[0]?.why.code : undefined;
    }
    // waiting for the user's ✅: never "working/executing" before approval
    if (this.awaiting && (!final || /^⏳/.test(final.text))) final = this.msgs.awaitingApproval();
    if (!final && this.transcript) final = this.msgs.transcribed(this.transcript, true);
    if (final) {
      await this.show(final, true, true);
      if (code) {
        this.d.log?.(`[status] ${code}: ${final.text}`);
        await this.d.onFailure?.({ at: this.now(), requestId: this.d.requestId, code, text: final.text });
      }
    } else if (this.messageId !== undefined) {
      // only a "⏳ working" was shown and there is nothing to report: remove it
      await this.chain;
      const id = this.messageId;
      this.messageId = undefined;
      await this.d.api.remove(this.d.chatId, id).catch(() => {});
    }
    await this.chain;
  }

  private ensureWorking(): void {
    if (this.finished || (this.messageId !== undefined && !this.shown.startsWith('📥'))) return;
    if (this.messageId !== undefined && this.transcript === undefined && this.shown.startsWith('📥')) return; // still transcribing
    void this.show(this.msgs.working(this.activityText));
  }

  /** Send or edit the live message; edits are throttled (the latest text wins). */
  private show(m: StatusText | undefined, force = false, final = false): Promise<void> {
    if (this.finished && !final) return this.chain;
    if (m) this.queued = toHtml(m);
    const run = async () => {
      const text = this.queued;
      if (text === undefined || text === this.shown) return;
      if (this.messageId === undefined) {
        try {
          this.messageId = await this.d.api.send(this.d.chatId, text);
          this.shown = text;
        } catch (err) {
          this.d.log?.(`[status] send failed: ${(err as Error).message.split('\n')[0]}`);
        }
        this.lastEdit = this.now();
        return;
      }
      const wait = this.lastEdit + (this.d.minEditGapMs ?? MIN_EDIT_GAP_MS) - this.now();
      if (wait > 0 && !force) {
        clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => void this.show(undefined, true, true).catch(() => {}), wait);
        this.flushTimer.unref?.();
        return;
      }
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      clearTimeout(this.flushTimer);
      const latest = this.queued!;
      if (latest === this.shown) return;
      try {
        await this.d.api.edit(this.d.chatId, this.messageId, latest);
        this.shown = latest;
      } catch (err) {
        this.d.log?.(`[status] edit failed: ${(err as Error).message.split('\n')[0]}`);
      }
      this.lastEdit = this.now();
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }
}

/**
 * Output processor: the end of an agent run finishes the request's status message. Needed for
 * approvals: Mastra resumes an approved tool in the background (the action handler returns
 * before the resumed run ends), so the status must close when the RUN ends.
 */
export class StatusRunEnd {
  readonly id = 'status-run-end' as const;
  readonly name = 'Status message: run end';
  constructor(private readonly current: () => StatusTracker | undefined) {}
  processOutputResult(args: { messages: unknown[] }) {
    const t = this.current();
    if (t?.closeOnRunEnd) void t.finish();
    return args.messages as never;
  }
}
