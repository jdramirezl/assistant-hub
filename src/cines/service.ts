/**
 * Hub-side rules for cines-mx-mcp, in code (not just the prompt):
 *
 * Images: a result with `imageUrl` (loopback PNG) is fetched and uploaded with sendPhoto; the
 * model only sees "image sent".
 *
 * Secure input: a result `{status:"needs_cvv"|"needs_3ds"|"needs_email_code", challengeId, kind}`
 * opens ONE pending secure request per chat (LibSQL, no secret stored, ≤ 5 min / the server's
 * expiresAt). The user's next message is taken by the Telegram channel before the agent,
 * deleted from the chat, format-checked and sent straight to the hub-only `cines_submit_code`;
 * the agent only sees the (redacted) result. A late reply after expiry is still swallowed.
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
  NOT_ARMED,
  RELEASE_TOOL,
  STATUS_TOOL,
  SECURE_FORMAT,
  normalizeSecret,
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
  sendPhoto?: (chatId: string, bytes: Uint8Array) => Promise<number | void>;
  /** Send a plain message to a chat (the secure-input prompt). */
  sendText?: (chatId: string, text: string) => Promise<void>;
  /** Persona wording of the secure prompt for a kind. */
  securePrompt: (kind: SecureKind) => string;
  /** "⚠️ That doesn't look right (3–4 digits); send it again" for a kind. */
  secureBadFormat: (kind: SecureKind) => string;
  /** "⌛ The request expired; I did not use your message" */
  secureExpired: () => string;
  /** Force dryRun on every purchase (setup day / tests): nothing is charged. */
  dryRun?: boolean;
  /** PayPal approval at the Mac: how long the server waits (CINES_PAYPAL_WAIT_MIN, default 15). */
  paypalWaitMin?: number;
  /** Poll interval for an in-progress purchase (default 10 s). */
  pollMs?: number;
  /** "⏳ Esperando que apruebe el pago en PayPal en el Mac…" (persona). */
  paypalWaitText?: () => string;
  /** Show a "working" line in the request's live status message. */
  working?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** After expiry, a reply that looks like the secret is still swallowed for this long. */
export const LATE_GRACE_MS = 10 * 60_000;

export interface PendingSecure {
  requestId: string;
  kind: SecureKind;
  expiresAt: number;
  /** True after expiresAt (within LATE_GRACE_MS): only swallow a late secret, do not deliver it. */
  expired?: boolean;
}

export interface CallContext {
  /** Chat the request came from (Telegram private chat id = user id). */
  chatId?: string;
}

/** How long a showtime the user was shown stays "in play" (holds must use one of them). */
export const SHOWN_TTL_MS = 30 * 60_000;
export interface ShownShowtime {
  id: string;
  /** "Dune · Cinépolis Parque Toreo · 20:30 SUB 2D" */
  label: string;
  at: number;
}
type Shown = { ids: Map<string, ShownShowtime>; lastMap?: { id: string; at: number } };
const showtimesIn = (r: Rec): Rec[] => {
  const out: Rec[] = [];
  for (const k of ['best', 'showtime']) if (r[k] && typeof r[k] === 'object') out.push(r[k] as Rec);
  for (const k of ['alternatives', 'showtimes']) if (Array.isArray(r[k])) out.push(...(r[k] as Rec[]));
  return out.filter((x) => typeof x.showtimeId === 'string');
};
const movieOf = (r: Rec) => String((r.movie as Rec | undefined)?.title ?? (typeof r.movie === 'string' ? r.movie : '') ?? '');

export class CinesHub {
  private readonly holds = new Map<string, HoldSummary>();
  /** Showtimes the user was shown, per chat (the ids a hold may use). */
  private readonly shown = new Map<string, Shown>();
  /** Hold checks by args: run before the approval card, reused when the call executes. */
  private readonly prepared = new Map<string, Promise<{ args: Rec; preview?: string } | { error: ReturnType<typeof sharedError> }>>();
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  constructor(private readonly d: CinesHubDeps) {
    this.log = d.log ?? (() => {});
    this.now = d.now ?? Date.now;
  }

  /* ---------------------------------------------------------------- showtimes in play */

  private shownFor(chat: string): Shown {
    let s = this.shown.get(chat);
    if (!s) this.shown.set(chat, (s = { ids: new Map() }));
    const now = this.now();
    for (const [id, x] of s.ids) if (now - x.at > SHOWN_TTL_MS) s.ids.delete(id);
    if (s.lastMap && now - s.lastMap.at > SHOWN_TTL_MS) s.lastMap = undefined;
    return s;
  }

  private remember(chat: string, tool: string, result: unknown): void {
    const r = (result ?? {}) as Rec;
    if (r.error) return;
    const s = this.shownFor(chat);
    const now = this.now();
    const movie = movieOf(r);
    for (const x of showtimesIn(r)) {
      const label = [movie, x.cinema, [x.date, x.time].filter(Boolean).join(' '), x.lang ?? x.language, x.format].filter(Boolean).join(' · ');
      s.ids.set(String(x.showtimeId), { id: String(x.showtimeId), label, at: now });
    }
    if ((tool === 'cines_seat_map' || tool === 'cines_validate_seats') && typeof r.showtimeId === 'string') {
      const prev = s.ids.get(r.showtimeId);
      s.ids.set(r.showtimeId, { id: r.showtimeId, label: prev?.label ?? r.showtimeId, at: now });
      s.lastMap = { id: r.showtimeId, at: now };
    }
  }

  /**
   * The showtime a seat tool must use: the one given if the user was shown it; otherwise the
   * one whose seat map the user saw last (or the only one shown); otherwise an error listing
   * the real ids. Models sometimes invent ids ("588-105001") or pass placeholders.
   */
  resolveShowtime(chat: string, given: unknown): { id: string; substituted?: boolean } | { error: ReturnType<typeof sharedError> } {
    const id = typeof given === 'string' ? given.trim() : '';
    const s = this.shownFor(chat);
    if (!s.ids.size || s.ids.has(id)) return id ? { id } : { error: sharedError('CINES_BAD_REQUEST', 'showtimeId is required (copy it from the latest cines_best_showtime / cines_seat_map result).') };
    const pick = s.lastMap?.id ?? (s.ids.size === 1 ? [...s.ids.keys()][0] : undefined);
    if (pick) {
      this.log(`[cines] showtimeId ${id || '(none)'} was never shown to the user; using ${pick} (the one in play)`);
      return { id: pick, substituted: true };
    }
    const list = [...s.ids.values()].map((x) => `${x.id} (${x.label})`).join('; ');
    return { error: sharedError('CINES_BAD_REQUEST', `showtimeId ${id || '(none)'} is not one the user was shown. Copy it verbatim from the results: ${list}.`) };
  }

  /** What the hold card shows for these args (sync; after prepareHold). */
  holdPreview(input: Rec): string | undefined {
    return this.previews.get(JSON.stringify(input));
  }
  private readonly previews = new Map<string, string>();

  /**
   * Before the hold's approval card: fix the showtime (see resolveShowtime) and check the seats
   * with cines_validate_seats, so the user never approves a hold that cannot work. Memoized per
   * args: the approval check and the execution share one result.
   */
  prepareHold(chat: string, input: Rec): Promise<{ args: Rec; preview?: string } | { error: ReturnType<typeof sharedError> }> {
    const key = JSON.stringify(input);
    let p = this.prepared.get(key);
    if (!p) {
      p = (async () => {
        const st = this.resolveShowtime(chat, input.showtimeId);
        if ('error' in st) return st;
        const args = { ...input, showtimeId: st.id };
        const seats = Array.isArray(input.seats) ? input.seats.join(',') : String(input.seats ?? '');
        const v = (await this.d.toolbox.execute('cines_validate_seats', { showtimeId: st.id, seats, ...(typeof input.tickets === 'number' ? { tickets: input.tickets } : {}) }, { raw: true })) as Rec;
        const verr = (v as Rec)?.error as Rec | undefined;
        if (verr) return { error: sharedError(String(verr.code ?? 'CINES_BAD_REQUEST'), String(verr.message ?? 'seat check failed')) };
        if (v.ok === false) return { error: sharedError('CINES_BAD_REQUEST', `Those seats cannot be held: ${[(v.errors as string[] | undefined) ?? []].flat().join(' ')}`.trim()) };
        const label = this.shownFor(chat).ids.get(st.id)?.label;
        const preview = [label ?? st.id, seats.toUpperCase()].join(' · ');
        this.previews.set(key, preview);
        return { args, preview };
      })();
      this.prepared.set(key, p);
      setTimeout(() => (this.prepared.delete(key), this.previews.delete(key)), 15 * 60_000).unref?.();
    }
    return p;
  }

  /** Seat tools (validate/seat map) use a showtime the user was shown. */
  fixSeatTool(chat: string, input: Rec): { args: Rec } | { error: ReturnType<typeof sharedError> } {
    const st = this.resolveShowtime(chat, input.showtimeId);
    return 'error' in st ? st : { args: { ...input, showtimeId: st.id } };
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
    // the hold itself was approved (gated): it covers this purchase, unless the server still
    // requires explicit approval (its own ledger) or the total is over the cap
    return !h || h.serverApprovalRequired === true || h.totalMxn > HARD_CAP_MXN;
  }

  /**
   * Checks before a money tool reaches the server. Returns the args to send, or a
   * shared-shape error (the server is not called). Runs after the approval (if any).
   */
  async beforeCall(tool: string, input: Rec, ctx: CallContext = {}): Promise<{ args: Rec } | { error: ReturnType<typeof sharedError> }> {
    const chat = ctx.chatId ?? 'local';
    if (tool === HOLD_TOOL) {
      const r = await this.prepareHold(chat, input);
      return 'error' in r ? r : { args: r.args };
    }
    if (tool === 'cines_validate_seats' || tool === 'cines_seat_map') return this.fixSeatTool(chat, input);
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
    return { args: purchaseArgs(input, h, true, { dryRun: this.d.dryRun }) };
  }

  /**
   * PayPal is approved at the Mac's screen (up to CINES_PAYPAL_WAIT_MIN): the purchase call
   * returned in_progress. Poll cines_hold_status (no model calls, never re-calling
   * cines_purchase) until the newest purchase is paid / failed / unknown, or time runs out.
   */
  private async waitForPurchase(): Promise<unknown> {
    const started = this.now();
    const limit = ((this.d.paypalWaitMin ?? 15) + 2) * 60_000;
    const every = this.d.pollMs ?? 10_000;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.d.working?.(this.d.paypalWaitText?.() ?? '⏳ Esperando que apruebe el pago en PayPal en el Mac…');
    this.log(`[cines] purchase in progress (PayPal at the Mac); polling every ${Math.round(every / 1000)} s for up to ${Math.round(limit / 60_000)} min`);
    let polls = 0;
    while (this.now() - started < limit) {
      await sleep(every);
      polls++;
      const st = (await this.d.toolbox.execute(STATUS_TOOL, {}, { raw: true })) as Rec;
      if (st?.error) continue; // transient: keep waiting
      const list = (st.purchases as Rec[] | undefined) ?? [];
      // the server lists the last purchases oldest first: the newest is ours
      const p = list.at(-1);
      const s = String(p?.status ?? '');
      if (s === 'paid') {
        this.log(`[cines] purchase paid after ${polls} polls`);
        return { status: 'paid', purchaseId: p!.purchaseId, bookingNumber: p!.bookingNumber, total: p!.total, currency: p!.currency ?? 'MXN', imageUrl: p!.imageUrl, dryRun: p!.dryRun };
      }
      if (s === 'failed') {
        this.log(`[cines] purchase failed after ${polls} polls (not retried)`);
        return { error: { code: 'CINES_PAYMENT_FAILED', message: String(p!.error ?? 'El pago no se completó.'), retryable: false } };
      }
      if (s === 'unknown') {
        this.log(`[cines] purchase outcome unknown after ${polls} polls (not retried, hold kept)`);
        return { error: { code: 'CINES_PAYMENT_UNKNOWN', message: String(p!.error ?? 'outcome unknown'), retryable: false } };
      }
    }
    this.log(`[cines] purchase still not settled after ${Math.round(limit / 60_000)} min (not retried)`);
    return { error: { code: 'CINES_PAYMENT_UNKNOWN', message: 'still in progress after the PayPal wait', retryable: false } };
  }

  /* ---------------------------------------------------------------- results */

  /**
   * Inspect a cines result: record holds and purchases, send images, open secure requests.
   * Returns what the model sees.
   */
  async afterResult(tool: string, input: Rec, given: unknown, ctx: CallContext = {}): Promise<unknown> {
    let result = given;
    if ((tool === PURCHASE_TOOL || tool === SECURE_TOOL) && (result as Rec | undefined)?.status === 'in_progress') result = await this.waitForPurchase();
    if (tool === PURCHASE_TOOL) {
      const e = (result as Rec | undefined)?.error as Rec | undefined;
      if (e && NOT_ARMED.test(String(e.message ?? ''))) {
        // refused before anything was recorded: the user may try again once it is armed
        const holdId = holdIdOf(input);
        if (holdId) await this.d.kv.delete(`cines:attempt:${holdId}`);
        this.log('[cines] purchase refused: real payment is not armed on the Mac (nothing charged)');
        return { error: { code: 'CINES_PAYMENT_NOT_ARMED', message: String(e.message), retryable: false } };
      }
    }
    let out = result;
    this.remember(ctx.chatId ?? 'local', tool, result);
    const h = holdOf(result);
    if (h && (tool === HOLD_TOOL || tool === SECURE_TOOL)) {
      h.serverApprovalRequired = (result as Rec).purchaseApprovalRequired === true;
      // the server's `next` says "show the summary"; the HUB shows it (the purchase card)
      out = {
        ...(result as Rec),
        next: `If the user asked to BUY, call cines_purchase now with holdId "${h.holdId}" and expectedTotal ${h.totalMxn} (the hub shows the confirmation card; do not ask in text). If they only asked to hold, show the total and stop.`,
      };
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
    if (!chatId || !this.d.sendPhoto) {
      this.log(`[photo] not sent: ${chatId ? 'Telegram is off' : 'no chat for this request'}`);
      return 'not shown (no chat); describe the proposal in words';
    }
    try {
      const bytes = await fetchLoopbackPng(url, { fetch: this.d.fetch });
      const messageId = await this.d.sendPhoto(chatId, bytes);
      this.log(`[photo] sent ${bytes.byteLength} bytes${messageId !== undefined ? ` (message ${messageId})` : ''}`);
      return 'sent to the user in the chat (do not describe or link it)';
    } catch (err) {
      this.log(`[photo] failed: ${(err as Error).message.split('\n')[0]}`);
      return `could NOT be shown (${(err as Error).message}); tell the user the map could not be shown and list the proposed seats`;
    }
  }

  /* ---------------------------------------------------------------- secure input */

  /** The pending request (or, shortly after it expired, an `expired` marker); undefined when none. */
  async pending(chatId: string): Promise<PendingSecure | undefined> {
    const p = await this.d.kv.get<PendingSecure>(`cines:secure:${chatId}`);
    if (!p) return undefined;
    if (p.expiresAt <= this.now()) return { ...p, expired: true };
    return p;
  }

  /** Is this text shaped like the secret of that kind (to swallow a late reply)? */
  looksLikeSecret(kind: SecureKind, text: string): boolean {
    const f = SECURE_FORMAT[kind];
    return f ? f.re.test(normalizeSecret(text)) : /^\s*[0-9A-Za-z]{3,10}\s*$/.test(text);
  }

  /** ❌ on a purchase card: release the hold right away (never leaves seats held). */
  async releaseAfterDeny(holdId: string | undefined): Promise<void> {
    const r = await this.d.toolbox.execute(RELEASE_TOOL, holdId ? { holdId } : {}, { raw: true }).catch((e: Error) => ({ error: { message: e.message } }));
    this.log(`[cines] purchase denied: hold ${holdId ?? '(active)'} ${(r as Rec)?.error ? 'NOT released' : 'released'}`);
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
    await this.d.kv.set(`cines:secure:${chatId}`, p, expiresAt - this.now() + LATE_GRACE_MS);
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
    if (p.expired) {
      // a late reply: never forward it; tell the user, and the agent that the step lapsed
      await this.d.kv.delete(`cines:secure:${chatId}`);
      return { userText: this.d.secureExpired(), agentText: `[hub] The private ${p.kind} request expired before the user answered; nothing was sent. The server cancelled that step. Tell the user briefly and offer to start again.` };
    }
    const secret = normalizeSecret(value);
    const fmt = SECURE_FORMAT[p.kind];
    if (fmt && !fmt.re.test(secret)) return { userText: this.d.secureBadFormat(p.kind) }; // still pending, server not called
    await this.d.kv.delete(`cines:secure:${chatId}`);
    const raw = await this.d.toolbox.execute(SECURE_TOOL, secureArgs(p, secret), { raw: true });
    const scrub = (v: unknown) => JSON.parse(JSON.stringify(v ?? null).split(secret).join('•••')) as unknown;
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
