/**
 * Hub-side rules for cines-mx-mcp, in code (not just the prompt):
 *
 * Images: a result with `imageUrl` (loopback PNG) is fetched and uploaded with sendPhoto; the
 * model only sees "image sent".
 *
 * Secure input: a result `{status:"needs_input", requestId, kind}` opens ONE pending secure
 * request per chat (LibSQL, no secret stored, ≤ 5 min). The user's next message is taken by
 * the Telegram channel before the agent, deleted from the chat, and sent straight to the
 * hub-only `cines_secure_input`; the agent only sees the (redacted) result.
 *
 * Purchases:
 *   - cines_hold_seats and cines_purchase are approval-gated; cines_release_hold is not.
 *   - Hard cap $1,000 MXN, checked against the total of the hold the HUB saw (never the
 *     model's number); over it the call is refused before it reaches the server.
 *   - The first 3 successful purchases always show a summary card (✅/❌). After that, the
 *     hold's approval also covers a purchase ≤ cap of that same hold.
 *   - Successful purchases are counted in LibSQL; a hold is paid at most once: any attempt
 *     (paid, failed, unknown) blocks another, so a failed payment is never retried.
 */
import type { KvStore } from '../kv.js';
import { fetchLoopbackPng } from './images.js';
import {
  HARD_CAP_MXN,
  HOLD_TOOL,
  PURCHASE_TOOL,
  SECURE_TOOL,
  holdIdOf,
  holdOf,
  imageUrlOf,
  purchaseArgs,
  purchaseOutcome,
  secureArgs,
  secureRequestOf,
  type HoldSummary,
  type SecureKind,
  type SecureRequest,
} from './contract.js';

type Rec = Record<string, unknown>;
export const SECURE_TTL_MS = 5 * 60_000;
/** Purchases that always need the summary card. */
export const ALWAYS_CONFIRM = 3;
const COUNTER = 'cines:purchases:ok';
const HOLD_TTL_MS = 60 * 60_000;
const ATTEMPT_TTL_MS = 30 * 86_400_000;

const sharedError = (code: string, message: string) => ({ error: { code, message, retryable: false } });

export interface CinesHubDeps {
  kv: KvStore;
  toolbox: { execute(name: string, args: Rec, opts?: { raw?: boolean }): Promise<unknown> };
  log?: (m: string) => void;
  now?: () => number;
  fetch?: typeof fetch;
  /** Upload a photo to a chat (Telegram); omitted in Studio-only mode. */
  sendPhoto?: (chatId: string, bytes: Uint8Array) => Promise<void>;
  /** Send a plain message to a chat (the secure-input prompt). */
  sendText?: (chatId: string, text: string) => Promise<void>;
  /** Persona wording of the secure prompt for a kind. */
  securePrompt: (kind: SecureKind) => string;
}

interface PendingSecure {
  requestId: string;
  kind: SecureKind;
  expiresAt: number;
}

export interface CallContext {
  /** Chat the request came from (Telegram private chat id = user id). */
  chatId?: string;
}

export class CinesHub {
  private readonly holds = new Map<string, HoldSummary>();
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  constructor(private readonly d: CinesHubDeps) {
    this.log = d.log ?? (() => {});
    this.now = d.now ?? Date.now;
  }

  /* ---------------------------------------------------------------- purchases */

  async successes(): Promise<number> {
    return (await this.d.kv.get<number>(COUNTER)) ?? 0;
  }

  /** Last hold the hub saw with this id (sync, for the approval card). */
  holdSummary(holdId: string | undefined): HoldSummary | undefined {
    return holdId ? this.holds.get(holdId) : undefined;
  }

  private async hold(holdId: string | undefined): Promise<HoldSummary | undefined> {
    if (!holdId) return undefined;
    const h = this.holds.get(holdId) ?? (await this.d.kv.get<HoldSummary>(`cines:hold:${holdId}`)) ?? undefined;
    if (h) this.holds.set(holdId, h);
    return h;
  }

  /**
   * Does this purchase need the ✅ card? Always for the first 3 successful purchases, for an
   * unknown hold or one over the cap (they are refused anyway, with the card first).
   */
  async purchaseNeedsApproval(input: Rec): Promise<boolean> {
    if ((await this.successes()) < ALWAYS_CONFIRM) return true;
    const h = await this.hold(holdIdOf(input));
    return !h || h.totalMxn > HARD_CAP_MXN; // the hold itself was approved (gated): it covers this purchase
  }

  /**
   * Checks before a money tool reaches the server. Returns the args to send, or a
   * shared-shape error (the server is not called). Runs after the approval (if any).
   */
  async beforeCall(tool: string, input: Rec): Promise<{ args: Rec } | { error: ReturnType<typeof sharedError> }> {
    if (tool !== PURCHASE_TOOL) return { args: input };
    const h = await this.hold(holdIdOf(input));
    if (!h) return { error: sharedError('CINES_BAD_REQUEST', 'Unknown hold: hold the seats with cines_hold_seats first (the hub only pays holds it has seen).') };
    if (!(h.totalMxn > 0) || h.totalMxn > HARD_CAP_MXN) {
      return { error: sharedError('CINES_LIMIT_EXCEEDED', `The total $${h.totalMxn} MXN is over the $${HARD_CAP_MXN} MXN limit per purchase; nothing was charged. Release the hold or choose fewer/cheaper seats.`) };
    }
    // a hold is paid at most once: claim it BEFORE calling, so a crash or timeout never allows a retry
    if (!(await this.d.kv.setIfNotExists(`cines:attempt:${h.holdId}`, this.now(), ATTEMPT_TTL_MS))) {
      return { error: sharedError('CINES_PAYMENT_FAILED', 'A payment for this hold was already attempted; payments are never retried. Ask the user to check their e-mail/bank before anything else.') };
    }
    this.log(`[cines] purchase of ${h.holdId}: $${h.totalMxn} MXN`);
    return { args: purchaseArgs(input, h, true) };
  }

  /* ---------------------------------------------------------------- results */

  /**
   * Inspect a cines result: record holds and purchases, send images, open secure requests.
   * Returns what the model sees.
   */
  async afterResult(tool: string, input: Rec, result: unknown, ctx: CallContext = {}): Promise<unknown> {
    let out = result;
    const h = holdOf(result);
    if (h && (tool === HOLD_TOOL || tool === SECURE_TOOL)) {
      this.holds.set(h.holdId, h);
      await this.d.kv.set(`cines:hold:${h.holdId}`, h, HOLD_TTL_MS);
    }
    const outcome = purchaseOutcome(result);
    if (outcome === 'paid' && (tool === PURCHASE_TOOL || tool === SECURE_TOOL)) {
      const n = await this.d.kv.incr(COUNTER, 1);
      this.log(`[cines] purchase paid (${n} so far)`);
    }
    if (tool === PURCHASE_TOOL && (result as Rec | undefined)?.error) {
      this.log(`[cines] purchase failed: ${String(((result as Rec).error as Rec).code)} (not retried)`);
      out = { ...(result as Rec), error: { ...((result as Rec).error as Rec), retryable: false } };
    }
    const url = imageUrlOf(result);
    if (url) out = { ...(out as Rec), imageUrl: undefined, image: await this.sendImage(url, ctx.chatId) };
    const req = secureRequestOf(result);
    if (req) out = await this.openSecure(req, ctx.chatId);
    return out;
  }

  private async sendImage(url: string, chatId: string | undefined): Promise<string> {
    if (!chatId || !this.d.sendPhoto) return 'not shown (no chat); describe the proposal in words';
    try {
      const bytes = await fetchLoopbackPng(url, { fetch: this.d.fetch });
      await this.d.sendPhoto(chatId, bytes);
      return 'sent to the user in the chat (do not describe or link it)';
    } catch (err) {
      this.log(`[cines] image not sent: ${(err as Error).message}`);
      return `could NOT be shown (${(err as Error).message}); tell the user the map could not be shown and list the proposed seats`;
    }
  }

  /* ---------------------------------------------------------------- secure input */

  async pending(chatId: string): Promise<PendingSecure | undefined> {
    const p = await this.d.kv.get<PendingSecure>(`cines:secure:${chatId}`);
    if (!p) return undefined;
    if (p.expiresAt <= this.now()) {
      await this.d.kv.delete(`cines:secure:${chatId}`);
      return undefined;
    }
    return p;
  }

  async cancelSecure(chatId: string): Promise<void> {
    await this.d.kv.delete(`cines:secure:${chatId}`);
  }

  private async openSecure(req: SecureRequest, chatId: string | undefined): Promise<Rec> {
    if (!chatId || !this.d.sendText) {
      return { status: 'secure_input_unavailable', note: 'This step needs a code the user types privately, which only works in Telegram. Tell the user.' };
    }
    const current = await this.pending(chatId);
    if (current && current.requestId !== req.requestId) {
      return { status: 'secure_input_busy', note: 'Another private code request is already pending; wait for it (or for it to expire) before starting another.' };
    }
    const server = req.expiresAt ? Date.parse(req.expiresAt) : NaN;
    const expiresAt = Math.min(this.now() + SECURE_TTL_MS, Number.isFinite(server) ? server : Infinity);
    const p: PendingSecure = { requestId: req.requestId, kind: req.kind, expiresAt };
    await this.d.kv.set(`cines:secure:${chatId}`, p, expiresAt - this.now());
    if (req.imageUrl) await this.sendImage(req.imageUrl, chatId);
    await this.d.sendText(chatId, this.d.securePrompt(req.kind));
    this.log(`[cines] secure input requested (${req.kind})`);
    return {
      status: 'waiting_for_secure_input',
      kind: req.kind,
      note: 'The hub has asked the user privately (the model never sees the value). Reply ONE short line that you are waiting; do not ask for the value yourself.',
    };
  }

  /**
   * Deliver the user's reply for the pending request to the hub-only tool. Returns the text
   * the agent gets instead of the user's message (never the secret), or undefined when there
   * is nothing to resume (e.g. a bad format: the user is asked again).
   */
  async deliver(chatId: string, value: string, p: PendingSecure): Promise<{ agentText?: string; userText?: string }> {
    await this.d.kv.delete(`cines:secure:${chatId}`);
    const raw = await this.d.toolbox.execute(SECURE_TOOL, secureArgs(p, value.trim()), { raw: true });
    const scrub = (v: unknown) => JSON.parse(JSON.stringify(v ?? null).split(value.trim()).join('•••')) as unknown;
    const err = (raw as Rec | undefined)?.error as Rec | undefined;
    if (err?.code === 'CINES_BAD_REQUEST' && /formato|format/i.test(String(err.message))) {
      // the server keeps the request open on a bad format: ask again, no model call
      await this.d.kv.set(`cines:secure:${chatId}`, p, Math.max(1, p.expiresAt - this.now()));
      return { userText: `⚠️ ${String(err.message)}` };
    }
    const out = await this.afterResult(SECURE_TOOL, {}, scrub(raw), { chatId });
    return { agentText: `[hub] The user sent the ${p.kind} privately (you do not see it). The operation continued; result: ${JSON.stringify(out)}` };
  }
}
