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
import { namedCinemas } from './args.js';
import {
  HARD_CAP_MXN,
  HOLD_TOOL,
  NOT_ARMED,
  PAYMENT_KINDS,
  RELEASE_TOOL,
  STATUS_TOOL,
  SECURE_FORMAT,
  normalizeSecret,
  PURCHASE_TOOL,
  SECURE_TOOL,
  holdIdOf,
  holdOf,
  imageUrlOf,
  paymentChoiceOf,
  paymentErrorKind,
  pendingInputOf,
  promptDetails,
  purchaseArgs,
  purchaseOutcome,
  secureArgs,
  secureRequestOf,
  type HoldSummary,
  type SecureKind,
  type SecureRequest,
} from './contract.js';
import { span, timed } from '../telemetry/timing.js';

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
  /** Persona wording of the secure prompt for a kind (card last four and total from the server's prompt). */
  securePrompt: (kind: SecureKind, details?: { last4?: string; total?: string }) => string;
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
  /** In-progress hold: poll interval (default 5 s) and limit (default 3 min). */
  holdPollMs?: number;
  holdWaitMs?: number;
  holdWaitText?: () => string;
  /** Hub purchase card (Telegram): send (returns message id) and edit (buttons optional). */
  sendCard?: (chatId: string, text: string, keyboard: { text: string; callback_data: string }[][]) => Promise<number>;
  editCard?: (chatId: string, messageId: number, text: string, keyboard?: { text: string; callback_data: string }[][]) => Promise<void>;
  /** After 3 purchases: run the purchase of a just-held hold (like pressing Comprar). */
  autoBuy?: (chatId: string, holdId: string) => Promise<void>;
  lang?: 'es' | 'en';
  /** "❓ C7 no se puede: …" for an invalid seat pick (persona). */
  seatInvalidText?: (seats: string, reason: string) => string;
  /** "⏳ Esperando que apruebe el pago en PayPal en el Mac…" (persona). */
  paypalWaitText?: () => string;
  /** "⏳ Pagando con su tarjeta en Cinépolis…" while a card purchase runs in the background. */
  cardWaitText?: () => string;
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
  /** A payment secret (CVV, arming PIN, bank code): the hub settles the outcome itself, no model call. */
  purpose?: 'payment';
  /** The hold being paid (to close or re-offer its purchase card). */
  holdId?: string;
}

export interface CallContext {
  /** Chat the request came from (Telegram private chat id = user id). */
  chatId?: string;
  /** The user's message for this request (cinemas they named, filters they asked for). */
  userText?: string;
  /** The hold a secure-input result belongs to (cines_submit_code has no holdId). */
  holdId?: string;
}

/** "14:37" in the cinema's timezone and minutes left. */
export function expiryOf(iso: string, now: number): { time: string; min: number } | undefined {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
  return { time, min: Math.max(0, Math.round((t - now) / 60_000)) };
}

/** lastJob of cines_hold_status when it is OUR background job (same jobId). */
function jobOf(st: Rec, jobId: string): Rec | undefined {
  const j = st.lastJob as Rec | null | undefined;
  return j && jobId && String(j.jobId) === jobId ? j : undefined;
}

/** Seats the user picked in a short message ("elige c7", "F7 y F8", "quiero el D5"); undefined otherwise. */
export function seatPickOf(text: string | undefined): string[] | undefined {
  const t = (text ?? '').trim().replace(/[.!¡¿?]+$/g, '').trim();
  if (!t || t.length > 60) return undefined;
  const words = t.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').split(/[\s,]+/).filter(Boolean);
  const FILLER = new Set(['elige', 'elijo', 'escojo', 'escoge', 'aparta', 'apartame', 'quiero', 'dame', 'prefiero', 'mejor', 'ponme', 'pon', 'el', 'la', 'los', 'las', 'asiento', 'asientos', 'lugar', 'lugares', 'butaca', 'butacas', 'y', 'e', 'and', 'seat', 'seats', 'por', 'favor', 'porfa', 'please', 'mejor', 'entonces', 'ok', 'va']);
  const seats: string[] = [];
  for (const w of words) {
    if (/^[a-n]\d{1,2}$/.test(w)) seats.push(w.toUpperCase());
    else if (!FILLER.has(w)) return undefined; // anything else: not a bare seat pick
  }
  return seats.length && seats.length <= 10 ? [...new Set(seats)] : undefined;
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

  /**
   * A recommendation is FILTERED (window, language, vip…). When the user named cinemas, add
   * everything that really exists there that day (unfiltered), so "only dubbed" can never be
   * claimed from a filtered search.
   */
  private async withNamedCinemas(input: Rec, result: Rec, ctx: CallContext): Promise<Rec> {
    const named = namedCinemas(ctx.userText);
    if (!named.length || typeof input.movie !== 'string') return result;
    const st = (await this.d.toolbox.execute('cines_showtimes', { movie: input.movie, cinema: named.join(','), ...(typeof input.date === 'string' ? { date: input.date } : {}) }, { raw: true })) as Rec;
    if (st?.error) return result;
    this.remember(ctx.chatId ?? 'local', 'cines_showtimes', st);
    const all = ((st.showtimes as Rec[] | undefined) ?? []).map((s) => [s.cinema, s.date, s.time, s.lang ?? s.language, s.format, s.showtimeId].filter(Boolean).join(' · '));
    this.log(`[cines] best_showtime: added ${all.length} unfiltered showtimes at ${named.join(', ')}`);
    return {
      ...result,
      at_named_cinemas: all,
      note_named:
        'at_named_cinemas lists ALL showtimes that day at the cinemas the user named (no window/vip/format filter). Answer about those cinemas from it: say what exists (also times just outside their preferred window). Never say "only dubbed" or "none" unless at_named_cinemas shows it.',
    };
  }

  /* ---------------------------------------------------------------- the purchase card */

  /** Holds with a hub purchase card (or an auto-purchase): message id per hold. */
  private readonly cards = new Map<string, { chat: string; messageId?: number; timer?: ReturnType<typeof setTimeout> }>();
  /** Holds whose purchase the hub itself is running (the model's own call is refused). */
  private readonly hubPaying = new Set<string>();
  /** The card / PayPal the user named in the request that asked for the hold, per chat. */
  private readonly choices = new Map<string, { cardLast4?: string; method?: 'paypal' }>();

  private cardText(h: HoldSummary, extra = ''): string {
    const es = (this.d.lang ?? 'es') === 'es';
    const mx = (n: number) => `$${Math.round(n * 100) / 100}`;
    const lf = [h.language === 'SUB' ? (es ? 'subtitulada' : 'subtitled') : h.language === 'ESP' ? (es ? 'doblada' : 'dubbed') : h.language, h.format].filter(Boolean).join(' ');
    const exp = h.expiresAt ? expiryOf(h.expiresAt, this.now()) : undefined;
    const price = h.unitMxn !== undefined && h.chargesMxn !== undefined ? ` (${es ? 'boletos' : 'tickets'} ${mx(h.totalMxn - h.chargesMxn)} + ${es ? 'cargos' : 'fees'} ${mx(h.chargesMxn)})` : '';
    return [
      es ? '🎟️ Asientos apartados — ¿confirmo la compra?' : '🎟️ Seats held — shall I buy them?',
      `🎬 ${h.movie || '?'}`,
      `📍 ${[h.cinema, h.when, lf].filter(Boolean).join(' · ')}`,
      `💺 ${h.seats.join(', ')}${h.ticketType ? ` · ${h.ticketType}` : ''}`,
      `💰 ${mx(h.totalMxn)} MXN${price}`,
      ...(exp ? [es ? `⌛ Expira ${exp.time} (≈${exp.min} min)` : `⌛ Expires ${exp.time} (≈${exp.min} min)`] : []),
      h.method === 'paypal'
        ? es ? '💳 PayPal: apruébelo en la pantalla del Mac.' : '💳 PayPal: approve it on the Mac screen.'
        : es ? `💳 Tarjeta guardada ${h.cardLast4 ? `*${h.cardLast4}` : '(predeterminada)'}; le pediré el CVV en privado.` : `💳 Saved card ${h.cardLast4 ? `*${h.cardLast4}` : '(default)'}; I will ask for the CVV privately.`,
      ...(extra ? ['', extra] : []),
    ].join('\n');
  }
  private cardButtons(h: HoldSummary) {
    const es = (this.d.lang ?? 'es') === 'es';
    return [[{ text: `${es ? '✅ Comprar' : '✅ Buy'} $${h.totalMxn}`, callback_data: `cines:b:${h.holdId}` }, { text: es ? '❌ Cancelar' : '❌ Cancel', callback_data: `cines:r:${h.holdId}` }]];
  }

  /** After a hold: the purchase card, or (after 3 purchases, within the cap) the purchase itself. */
  private async offerPurchase(h: HoldSummary, chat: string): Promise<'card' | 'auto' | undefined> {
    if (!this.d.sendCard) return undefined;
    if (this.cards.has(h.holdId)) return 'card';
    // a hold read back from cines_hold_status has no movie: take it from the showtime the user saw
    if (!h.movie && h.showtimeId) {
      const label = this.shownFor(chat).ids.get(h.showtimeId)?.label;
      if (label) h.movie = label.split(' · ')[0] ?? '';
    }
    const auto = (await this.successes()) >= ALWAYS_CONFIRM && !h.serverApprovalRequired && h.totalMxn > 0 && h.totalMxn <= HARD_CAP_MXN;
    if (auto && this.d.autoBuy) {
      this.cards.set(h.holdId, { chat });
      this.log(`[cines] hold ${h.holdId}: covered by the hold approval (${ALWAYS_CONFIRM}+ purchases); buying`);
      setTimeout(() => void this.d.autoBuy!(chat, h.holdId), 0);
      return 'auto';
    }
    const messageId = await this.d.sendCard(chat, this.cardText(h), this.cardButtons(h)).catch((e: Error) => (this.log(`[cines] purchase card not sent: ${e.message}`), undefined));
    if (messageId === undefined) return undefined;
    const entry: { chat: string; messageId?: number; timer?: ReturnType<typeof setTimeout> } = { chat, messageId };
    const ms = h.expiresAt ? Date.parse(h.expiresAt) - this.now() : 9 * 60_000;
    entry.timer = setTimeout(() => void this.expireCard(h.holdId), Math.max(1000, ms));
    entry.timer.unref?.();
    this.cards.set(h.holdId, entry);
    this.log(`[cines] purchase card shown for ${h.holdId} ($${h.totalMxn})`);
    return 'card';
  }

  private async expireCard(holdId: string): Promise<void> {
    const c = this.cards.get(holdId);
    if (!c?.messageId || !(await this.d.kv.setIfNotExists(`cines:card:${holdId}`, 'expired', HOLD_TTL_MS))) return;
    const es = (this.d.lang ?? 'es') === 'es';
    await this.d.editCard?.(c.chat, c.messageId, es ? '⌛ El apartado expiró; Cinépolis liberó los asientos.' : '⌛ The hold expired; Cinépolis released the seats.').catch(() => {});
    await this.d.toolbox.execute(RELEASE_TOOL, { holdId }, { raw: true }).catch(() => undefined);
    this.log(`[cines] purchase card for ${holdId} expired`);
  }

  /** ✅ on the purchase card (or the auto-purchase): pay exactly this hold. Returns the result. */
  async buyFromCard(holdId: string): Promise<unknown> {
    const h = await this.hold(holdId);
    const c = this.cards.get(holdId);
    if (!h) return { error: { code: 'CINES_HOLD_EXPIRED', message: 'Ese apartado ya no está activo.', retryable: false } };
    if (!(await this.d.kv.setIfNotExists(`cines:card:${holdId}`, 'buy', HOLD_TTL_MS))) return undefined; // double tap / expired
    clearTimeout(c?.timer);
    const es = (this.d.lang ?? 'es') === 'es';
    if (c?.messageId) await this.d.editCard?.(c.chat, c.messageId, this.cardText(h, es ? '⏳ Pagando… (si hace falta, le pido el PIN o el CVV abajo)' : '⏳ Paying… (if needed, I ask for the PIN or CVV below)')).catch(() => {});
    this.hubPaying.add(holdId);
    let r: unknown;
    try {
      r = await this.d.toolbox.execute(PURCHASE_TOOL, { holdId, expectedTotal: h.totalMxn });
    } finally {
      this.hubPaying.delete(holdId);
    }
    if (((r as Rec | undefined)?.error as Rec | undefined)?.code === 'CINES_PAYMENT_NOT_ARMED') {
      await this.reofferCard(holdId, es ? '🔒 El pago real no está armado. En el Mac corra: bin/cinesctl arm-payment (o configure un PIN con bin/cinesctl set-arm-pin para autorizar desde aquí) — y vuelva a tocar Comprar.' : '🔒 Real payment is not armed. On the Mac run: bin/cinesctl arm-payment (or set a PIN with bin/cinesctl set-arm-pin to authorize from here) — then tap Buy again.');
    }
    return r;
  }

  /** Nothing was charged or recorded (not armed, wrong PIN): the card stays valid until the hold expires. */
  private async reofferCard(holdId: string, line: string): Promise<void> {
    const c = this.cards.get(holdId);
    const h = await this.hold(holdId);
    if (!c?.messageId || !h) return;
    await this.d.kv.delete(`cines:card:${holdId}`);
    clearTimeout(c.timer);
    const left = h.expiresAt ? Date.parse(h.expiresAt) - this.now() : 0;
    if (left > 0) {
      c.timer = setTimeout(() => void this.expireCard(holdId), left);
      c.timer.unref?.();
    }
    await this.d.editCard?.(c.chat, c.messageId, this.cardText(h, line), this.cardButtons(h)).catch(() => {});
  }

  /** The purchase settled (paid / failed / unknown): close its card with the outcome, no buttons. */
  private async closeCard(holdId: string | undefined, result: unknown): Promise<void> {
    const c = holdId ? this.cards.get(holdId) : undefined;
    const h = holdId ? await this.hold(holdId) : undefined;
    if (!c?.messageId || !h) return;
    const r = (result ?? {}) as Rec;
    const e = r.error as Rec | undefined;
    const es = (this.d.lang ?? 'es') === 'es';
    let line: string | undefined;
    if (r.status === 'paid') line = `${es ? '✅ Pagado' : '✅ Paid'}${r.bookingNumber ? `: ${es ? 'reserva' : 'booking'} ${String(r.bookingNumber)}` : ''}${r.dryRun ? (es ? ' (simulado)' : ' (simulated)') : ''}`;
    else if (e?.code === 'CINES_PAYMENT_UNKNOWN') line = es ? '⚠️ Resultado incierto: revise su correo de Cinépolis y su banco. No liberé los asientos.' : '⚠️ Outcome unknown: check your Cinépolis e-mail and your bank. Seats not released.';
    else if (e) line = es ? '❌ No se completó el pago; no se reintenta.' : '❌ The payment did not go through; not retried.';
    if (!line) return;
    clearTimeout(c.timer);
    await this.d.editCard?.(c.chat, c.messageId, this.cardText(h, line)).catch(() => {});
  }

  /** ❌ on the purchase card: release the hold. */
  async releaseFromCard(holdId: string): Promise<unknown> {
    const c = this.cards.get(holdId);
    if (!(await this.d.kv.setIfNotExists(`cines:card:${holdId}`, 'release', HOLD_TTL_MS))) return undefined;
    clearTimeout(c?.timer);
    const r = await this.d.toolbox.execute(RELEASE_TOOL, { holdId });
    const es = (this.d.lang ?? 'es') === 'es';
    if (c?.messageId) await this.d.editCard?.(c.chat, c.messageId, es ? '❌ Cancelado: asientos liberados. No se cobró nada.' : '❌ Cancelled: seats released. Nothing was charged.').catch(() => {});
    this.log(`[cines] purchase card: hold ${holdId} released by the user`);
    return r;
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
    if (!s.ids.size || s.ids.has(id)) return id ? { id } : { error: sharedError('MODEL_ARG', 'showtimeId is required (copy it from the latest cines_best_showtime / cines_seat_map result).') };
    const pick = s.lastMap?.id ?? (s.ids.size === 1 ? [...s.ids.keys()][0] : undefined);
    if (pick) {
      this.log(`[cines] showtimeId ${id || '(none)'} was never shown to the user; using ${pick} (the one in play)`);
      return { id: pick, substituted: true };
    }
    const list = [...s.ids.values()].map((x) => `${x.id} (${x.label})`).join('; ');
    return { error: sharedError('MODEL_ARG', `showtimeId ${id || '(none)'} is not one the user was shown. Copy it verbatim from the results: ${list}.`) };
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
  prepareHold(chat: string, input: Rec, userText?: string): Promise<{ args: Rec; preview?: string } | { error: ReturnType<typeof sharedError> }> {
    if (userText) this.choices.set(chat, paymentChoiceOf(userText));
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
        if (v.ok === false) return { error: sharedError('CINES_BAD_REQUEST', [(v.errors as string[] | undefined) ?? []].flat().join(' ') || 'Esos asientos no se pueden apartar.') };
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

  /**
   * Seat-pick fast path: a bare "elige c7" right after a seat map is validated BY THE HUB on
   * that showtime (no model wandering). Valid → an instruction for the agent to hold exactly
   * those seats (the normal approval card); invalid → the server's reason for the user
   * (plus the preview image). undefined when this is not a seat pick after a seat map.
   */
  async seatPick(chat: string, text: string, opts: { othersRunning?: () => boolean; maxWaitMs?: number } = {}): Promise<{ agentText?: string; reply?: string } | undefined> {
    const seats = seatPickOf(text);
    if (!seats) return undefined;
    // the seat map's run may still be open (its reply not sent yet): wait for it, then decide
    const until = this.now() + (opts.maxWaitMs ?? 90_000);
    if (!this.shownFor(chat).lastMap && opts.othersRunning?.()) this.log(`[cines] seat pick ${seats.join(',')} while another run is open; waiting for it`);
    const wait = span('poll', 'cines.seat-pick-wait');
    while (!this.shownFor(chat).lastMap && opts.othersRunning?.() && this.now() < until) await new Promise((r) => setTimeout(r, 250));
    wait.end();
    const map = this.shownFor(chat).lastMap;
    if (!map) {
      this.log(`[cines] seat pick ${seats.join(',')} but no seat map in play; the agent handles it`);
      return undefined;
    }
    const label = this.shownFor(chat).ids.get(map.id)?.label ?? map.id;
    const list = seats.join(',');
    const v = (await this.d.toolbox.execute('cines_validate_seats', { showtimeId: map.id, seats: list, tickets: seats.length }, { raw: true })) as Rec;
    this.log(`[cines] seat pick ${list} on ${map.id}: ${v?.error ? `error ${String((v.error as Rec).code)}` : v?.ok === false ? 'invalid' : 'valid'}`);
    if (v?.error) {
      const e = v.error as Rec;
      return { reply: this.d.seatInvalidText?.(list, String(e.message ?? e.code)) ?? `❓ ${list}: ${String(e.message ?? e.code)}` };
    }
    this.remember(chat, 'cines_validate_seats', v);
    if (v.ok === false) {
      if (typeof v.imageUrl === 'string') await this.sendImage(v.imageUrl, chat);
      const reason = [(v.errors as string[] | undefined) ?? []].flat().join(' ') || 'no disponible';
      return { reply: this.d.seatInvalidText?.(list, reason) ?? `❓ ${list}: ${reason}` };
    }
    return {
      agentText:
        `[hub] The user picked seat(s) ${list} on the seat map they just saw (showtimeId ${map.id}: ${label}). ` +
        `The hub checked them with cines_validate_seats: they are available. Call cines_hold_seats NOW with {"showtimeId":"${map.id}","seats":"${list}","tickets":${seats.length}} ` +
        '(the user gets the approval card). Do not search showtimes again and do not ask anything else.',
    };
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
    // the hub's own purchase card (or auto-purchase) handles this hold: no second approval card
    if (this.cards.has(String(input.holdId ?? ''))) return false;
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
  async beforeCall(tool: string, input: Rec, ctx: CallContext = {}): Promise<{ args: Rec } | { error: unknown }> {
    const chat = ctx.chatId ?? 'local';
    const hid = String(input.holdId ?? '');
    if (tool === PURCHASE_TOOL && this.cards.has(hid) && !this.hubPaying.has(hid)) {
      return { error: { status: 'card_shown', note: 'The user already has the purchase card for this hold (Comprar / Cancelar). Do not call cines_purchase; reply one short line.' } };
    }
    if (tool === HOLD_TOOL) {
      if (ctx.userText) this.choices.set(chat, paymentChoiceOf(ctx.userText));
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
   * cines-mx-mcp returns {status:"in_progress"} for a hold that takes > ~40 s. Poll
   * cines_hold_status (no model calls, never re-calling the hold) until the hold appears; it is
   * then handled exactly like a direct "held" result (summary / purchase card).
   */
  private async waitForHold(input: Rec, jobId = '', unsure = false): Promise<unknown> {
    const started = this.now();
    const limit = this.d.holdWaitMs ?? 3 * 60_000;
    const every = this.d.holdPollMs ?? 5_000;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const known = new Set(this.holds.keys());
    const seats = [input.seats ?? []].flat().join(',').toUpperCase().split(/[,\s]+/).filter(Boolean).sort().join(',');
    this.d.working?.(this.d.holdWaitText?.() ?? '⏳ Apartando en Cinépolis…');
    this.log(`[cines] hold in progress; polling every ${Math.round(every / 1000)} s for up to ${Math.round(limit / 60_000)} min`);
    let polls = 0;
    while (this.now() - started < limit) {
      await sleep(every);
      polls++;
      const st = (await this.d.toolbox.execute(STATUS_TOOL, {}, { raw: true })) as Rec;
      if (st?.error) continue;
      const job = jobOf(st, jobId);
      if (job?.status === 'failed') return this.jobFailed(job, polls, 'hold');
      const h = st.hold as Rec | null | undefined;
      const hSeats = [h?.seats ?? []].flat().map(String).map((x) => x.toUpperCase()).sort().join(',');
      if (h && typeof h.holdId === 'string' && (h.status ?? 'held') === 'held' && (!known.has(h.holdId) || (seats && hSeats === seats))) {
        this.log(`[cines] hold ${h.holdId} appeared after ${polls} polls`);
        return {
          ...h,
          status: 'held',
          cinema: h.cinema ?? h.cinemaName,
          total: typeof h.total === 'number' ? h.total : h.totalMxn,
          currency: h.currency ?? 'MXN',
          ...(typeof st.purchaseApprovalRequired === 'boolean' ? { purchaseApprovalRequired: st.purchaseApprovalRequired } : {}),
        };
      }
      // the server reports a failed hold job: show its error, never retry
      const failure = [st.holdError, st.lastError, (st.job as Rec | undefined)?.error, (st.lastHold as Rec | undefined)?.error].find((x) => x);
      if (failure) {
        const f = typeof failure === 'object' ? (failure as Rec) : { message: String(failure) };
        this.log(`[cines] hold failed after ${polls} polls (not retried)`);
        return { error: { code: String(f.code ?? 'CINES_BAD_REQUEST'), message: String(f.message ?? failure), retryable: false } };
      }
    }
    this.log(`[cines] hold not confirmed after ${Math.round(limit / 60_000)} min (not retried)`);
    if (unsure) return { error: { code: 'CINES_HOLD_UNKNOWN', message: 'no hold visible in cines_hold_status yet', retryable: false } };
    return { error: { code: 'CINES_UNAVAILABLE', message: 'Cinépolis no confirmó el apartado a tiempo; no lo reintento. Revise en un momento si quedó apartado.', retryable: false } };
  }

  /**
   * PayPal is approved at the Mac's screen (up to CINES_PAYPAL_WAIT_MIN): the purchase call
   * returned in_progress. Poll cines_hold_status (no model calls, never re-calling
   * cines_purchase) until the newest purchase is paid / failed / unknown, or time runs out.
   */
  private jobFailed(job: Rec, polls: number, what: string): Rec {
    const e = (job.error ?? {}) as Rec;
    this.log(`[cines] ${what} job ${String(job.jobId)} failed after ${polls} polls: ${String(e.code ?? '?')} (not retried)`);
    return { error: { code: String(e.code ?? 'CINES_UNAVAILABLE'), message: String(e.message ?? 'El trabajo en segundo plano falló.'), retryable: false } };
  }

  private async waitForPurchase(jobId = '', unsure = false, ctx: CallContext = {}, paypal = false): Promise<unknown> {
    const started = this.now();
    // after a timed-out call, only a purchase that started around it counts (not an older one)
    const since = unsure ? started - 5 * 60_000 : -Infinity;
    let limit = ((this.d.paypalWaitMin ?? 15) + 2) * 60_000;
    const every = this.d.pollMs ?? 10_000;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const es = (this.d.lang ?? 'es') === 'es';
    const busy = () => (paypal ? (this.d.paypalWaitText?.() ?? '⏳ Esperando que apruebe el pago en PayPal en el Mac…') : (this.d.cardWaitText?.() ?? (es ? '⏳ Pagando con su tarjeta en Cinépolis…' : '⏳ Paying with your card at Cinépolis…')));
    this.d.working?.(busy());
    this.log(`[cines] purchase in progress (${paypal ? 'PayPal at the Mac' : 'card'}); polling every ${Math.round(every / 1000)} s for up to ${Math.round(limit / 60_000)} min`);
    let polls = 0;
    /** Challenges this poller opened (a CVV/PIN asked after the in_progress), and which are still open. */
    const opened = new Set<string>();
    let waitingFor: string | undefined;
    while (this.now() - started < limit) {
      await sleep(every);
      polls++;
      const st = (await this.d.toolbox.execute(STATUS_TOOL, {}, { raw: true })) as Rec;
      if (st?.error) continue; // transient: keep waiting
      // the background job asks for a secret (cines_hold_status.pendingInput): secure mode from here
      const open = pendingInputOf(st).filter((r) => PAYMENT_KINDS.has(r.kind));
      for (const req of open) {
        if (opened.has(req.requestId)) continue;
        opened.add(req.requestId);
        this.log(`[cines] secure input from cines_hold_status (${req.kind})`);
        await this.openSecure(req, ctx.chatId, { holdId: ctx.holdId });
        waitingFor = req.requestId;
        this.d.working?.(this.waitingText(req.kind));
        // the user has the challenge's whole TTL (≤ 5 min) to answer, then the charge itself
        const ttl = Math.min(SECURE_TTL_MS, Math.max(0, (req.expiresAt ? Date.parse(req.expiresAt) : this.now() + SECURE_TTL_MS) - this.now()));
        limit = Math.max(limit, this.now() - started + ttl + 3 * 60_000);
      }
      if (waitingFor && !open.some((r) => r.requestId === waitingFor)) {
        waitingFor = undefined; // answered (or lapsed): back to "paying"
        this.d.working?.(busy());
      }
      const job = jobOf(st, jobId);
      if (job?.status === 'failed') {
        const e = this.jobFailed(job, polls, 'purchase');
        // the server's "no está armado" etc. keep their own handling upstream
        return (e.error as Rec).code === 'CINES_PAYMENT_FAILED' || NOT_ARMED.test(String((e.error as Rec).message)) ? e : { error: { ...(e.error as Rec), code: (e.error as Rec).code === 'CINES_UNAVAILABLE' ? 'CINES_PAYMENT_UNKNOWN' : (e.error as Rec).code } };
      }
      const list = (st.purchases as Rec[] | undefined) ?? [];
      // the server lists the last purchases oldest first: the newest is ours
      const p0 = list.at(-1);
      const p = p0 && Date.parse(String(p0.at ?? '')) >= since ? p0 : unsure ? undefined : p0;
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
    const jobId = String((result as Rec | undefined)?.jobId ?? '');
    const unsure = (result as Rec | undefined)?.transport === true; // our call timed out: the server may have done it
    // polling loops are timed apart ("poll"): waiting for PayPal at the Mac is not slowness
    if (tool === HOLD_TOOL && (result as Rec | undefined)?.status === 'in_progress') result = await timed('poll', 'cines.hold', () => this.waitForHold(input, jobId, unsure));
    else if ((tool === PURCHASE_TOOL || tool === SECURE_TOOL) && (result as Rec | undefined)?.status === 'in_progress') {
      const hid = holdIdOf(input) ?? ctx.holdId;
      const paypal = input.method === 'paypal' || (await this.hold(hid))?.method === 'paypal';
      result = await timed('poll', paypal ? 'cines.paypal' : 'cines.purchase', () => this.waitForPurchase(jobId, unsure, { ...ctx, holdId: hid }, paypal));
    }
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
    const payHold = tool === PURCHASE_TOOL ? holdIdOf(input) : tool === SECURE_TOOL ? ctx.holdId : undefined;
    const perr = (result as Rec | undefined)?.error as Rec | undefined;
    if ((tool === PURCHASE_TOOL || tool === SECURE_TOOL) && perr) {
      const kind = paymentErrorKind(String(perr.code ?? ''), String(perr.message ?? ''));
      const es = (this.d.lang ?? 'es') === 'es';
      if (kind === 'unknown') {
        this.log('[cines] payment outcome uncertain (not retried, hold kept)');
        result = { error: { ...perr, code: 'CINES_PAYMENT_UNKNOWN', retryable: false } };
      } else if (kind === '3ds') {
        this.log('[cines] card refused: the bank asks for 3-D Secure (nothing charged)');
        result = { error: { ...perr, code: 'CINES_CARD_3DS', retryable: false } };
      } else if (kind === 'pin' || kind === 'pin_disabled') {
        // a wrong / too-early / disabled PIN: nothing recorded or charged, the hold stays
        const next = kind === 'pin' ? (es ? 'Puede volver a tocar Comprar.' : 'You can tap Buy again.') : es ? 'Después vuelva a tocar Comprar.' : 'Then tap Buy again.';
        if (payHold) {
          await this.d.kv.delete(`cines:attempt:${payHold}`);
          await this.reofferCard(payHold, `🔒 ${String(perr.message)} ${next}`);
        }
        this.log(`[cines] arming PIN refused${kind === 'pin_disabled' ? ' (PIN arming disabled)' : ''} (nothing charged)`);
        result = { error: { ...perr, code: kind === 'pin' ? 'CINES_ARM_PIN' : 'CINES_ARM_PIN_DISABLED', retryable: false } };
      }
    }
    if ((tool === PURCHASE_TOOL || tool === SECURE_TOOL) && (purchaseOutcome(result) || ((result as Rec | undefined)?.error && !['CINES_ARM_PIN', 'CINES_ARM_PIN_DISABLED'].includes(String(((result as Rec).error as Rec).code))))) {
      await this.closeCard(payHold, result);
    }
    let out = result;
    this.remember(ctx.chatId ?? 'local', tool, result);
    if (tool === 'cines_best_showtime' && !(result as Rec | undefined)?.error) out = await this.withNamedCinemas(input, result as Rec, ctx);
    const h = holdOf(result);
    if (h && (tool === HOLD_TOOL || tool === SECURE_TOOL)) {
      h.serverApprovalRequired = (result as Rec).purchaseApprovalRequired === true;
      // what to pay with, from the user's words when they asked for the hold (before the ✅)
      Object.assign(h, this.choices.get(ctx.chatId ?? 'local') ?? paymentChoiceOf(ctx.userText));
      this.holds.set(h.holdId, h);
      await this.d.kv.set(`cines:hold:${h.holdId}`, h, HOLD_TTL_MS);
      // the HUB (not the model) offers the purchase: a summary card with Comprar / Cancelar
      const offered = ctx.chatId ? await this.offerPurchase(h, ctx.chatId) : undefined;
      out = {
        ...(result as Rec),
        // the purchase card is the message: the model's text after it is dropped (leak guard)
        ...(offered === 'card' ? { card: 'shown_to_user' } : {}),
        next:
          offered === 'card'
            ? 'The hub has shown the user the purchase card (summary + Comprar / Cancelar). Reply ONE short line; do NOT call cines_purchase.'
            : offered === 'auto'
              ? 'The hub is completing the purchase now (covered by the hold approval). Reply ONE short line; do NOT call cines_purchase.'
              : `If the user asked to BUY, call cines_purchase now with holdId "${h.holdId}" and expectedTotal ${h.totalMxn}. If they only asked to hold, show the total and stop.`,
      };
    }
    const outcome = purchaseOutcome(result);
    if (outcome && (tool === PURCHASE_TOOL || tool === SECURE_TOOL)) {
      const ph = await this.hold(payHold);
      if (ph) out = { ...(out as Rec), summary: this.summaryOf(ph) };
    }
    if (outcome === 'paid' && (tool === PURCHASE_TOOL || tool === SECURE_TOOL)) {
      const n = await this.d.kv.incr(COUNTER, 1);
      this.log(`[cines] purchase paid (${n} so far)`);
    }
    if ((tool === PURCHASE_TOOL || tool === SECURE_TOOL) && (result as Rec | undefined)?.error) {
      this.log(`[cines] purchase failed: ${String(((result as Rec).error as Rec).code)} (not retried)`);
      out = { ...(result as Rec), error: { ...((result as Rec).error as Rec), retryable: false } };
    }
    const url = imageUrlOf(result);
    if (url) out = { ...(out as Rec), imageUrl: undefined, image: await this.sendImage(url, ctx.chatId) };
    const req = secureRequestOf(result);
    if (req) out = await this.openSecure(req, ctx.chatId, { holdId: payHold });
    return out;
  }

  private async sendImage(url: string, chatId: string | undefined): Promise<string> {
    if (!chatId || !this.d.sendPhoto) {
      this.log(`[photo] not sent: ${chatId ? 'Telegram is off' : 'no chat for this request'}`);
      return 'not shown (no chat); describe the proposal in words';
    }
    try {
      const bytes = await timed('tool', 'cines.image', () => fetchLoopbackPng(url, { fetch: this.d.fetch }));
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

  /** "Street Fighter · Cinépolis Parque Toreo · mié 21 19:00 · B7" for the confirmation line. */
  private summaryOf(h: HoldSummary): string {
    const es = (this.d.lang ?? 'es') === 'es';
    const m = h.when.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
    let when = h.when;
    if (m) {
      const d = new Date(`${m[1]}T12:00:00Z`);
      const wd = new Intl.DateTimeFormat(es ? 'es-MX' : 'en-US', { weekday: 'short', timeZone: 'UTC' }).format(d).replace('.', '');
      when = `${wd} ${d.getUTCDate()} ${m[2]}`;
    }
    return [h.movie, h.cinema, when, h.seats.join(', ')].filter(Boolean).join(' · ');
  }

  /** "🔒 Esperando el CVV de su tarjeta…" (status line while a payment secret is pending). */
  private waitingText(kind: SecureKind): string {
    const es = (this.d.lang ?? 'es') === 'es';
    const what = { cvv: es ? 'el CVV de su tarjeta' : 'your card CVV', arm_pin: es ? 'su PIN de compras' : 'your purchase PIN', otp_3ds: es ? 'el código de su banco' : 'your bank code' }[kind as string];
    return `🔒 ${es ? 'Esperando' : 'Waiting for'} ${what ?? (es ? 'su código' : 'your code')}…`;
  }

  private async openSecure(req: SecureRequest, chatId: string | undefined, extra: { holdId?: string } = {}): Promise<Rec> {
    if (!chatId || !this.d.sendText) {
      return { status: 'secure_input_unavailable', note: 'This step needs a code the user types privately, which only works in Telegram. Tell the user.' };
    }
    const current = await this.pending(chatId);
    if (current && current.requestId !== req.requestId) {
      return { status: 'secure_input_busy', note: 'Another private code request is already pending; wait for it (or for it to expire) before starting another.' };
    }
    const server = req.expiresAt ? Date.parse(req.expiresAt) : NaN;
    const expiresAt = Math.min(this.now() + SECURE_TTL_MS, Number.isFinite(server) ? server : Infinity);
    const p: PendingSecure = { requestId: req.requestId, kind: req.kind, expiresAt, ...(PAYMENT_KINDS.has(req.kind) ? { purpose: 'payment' as const } : {}), ...(extra.holdId ? { holdId: extra.holdId } : {}) };
    await this.d.kv.set(`cines:secure:${chatId}`, p, expiresAt - this.now() + LATE_GRACE_MS);
    if (req.imageUrl) await this.sendImage(req.imageUrl, chatId);
    await this.d.sendText(chatId, this.d.securePrompt(req.kind, promptDetails(req.prompt)));
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
  async deliver(chatId: string, value: string, p: PendingSecure): Promise<{ agentText?: string; userText?: string; payment?: { result: unknown } }> {
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
    // whole tokens only: a 3-digit CVV must not mangle "*1234" or a total
    const token = new RegExp(`(?<![0-9A-Za-z])${secret.replace(/[^0-9A-Za-z]/g, '')}(?![0-9A-Za-z])`, 'g');
    const scrub = (v: unknown) => JSON.parse(JSON.stringify(v ?? null).replace(token, '•••')) as unknown;
    const err = (raw as Rec | undefined)?.error as Rec | undefined;
    if (err?.code === 'CINES_BAD_REQUEST' && /formato|format/i.test(String(err.message))) {
      // the server keeps the request open on a bad format: ask again, no model call
      await this.d.kv.set(`cines:secure:${chatId}`, p, Math.max(1, p.expiresAt - this.now()));
      return { userText: `⚠️ ${String(err.message)}` };
    }
    const out = await this.afterResult(SECURE_TOOL, {}, scrub(raw), { chatId, holdId: p.holdId });
    if (p.purpose === 'payment') {
      // a payment secret: the hub reports the outcome itself (status line, purchase card); no model call
      this.log(`[cines] ${p.kind} delivered; result ${String((out as Rec)?.status ?? ((out as Rec)?.error as Rec | undefined)?.code ?? '?')}`);
      return { payment: { result: out } };
    }
    return { agentText: `[hub] The user sent the ${p.kind} privately (you do not see it). The operation continued; result: ${JSON.stringify(out)}` };
  }
}
