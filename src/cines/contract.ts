/**
 * The ONE place that knows the shape of cines-mx-mcp's Phase 3 tools: the FINAL contract v1
 * (cines-mx-mcp docs/hub-integration.md, commit 542f827; saved card 0e2f600; PIN arming cddca3d):
 *
 *   cines_hold_seats {showtimeId, seats: string[] | "F7,F8", tickets?, ticketType?, wheelchair?}   GATED
 *     → {status:"held", holdId, cinema, movie, startsAt, seats, ticketType, unitMxn, chargesMxn,
 *        subtotalMxn, total, currency:"MXN", expiresAt, purchaseApprovalRequired, capMxn}
 *   cines_purchase {holdId, expectedTotal, userApproved?, method?: "card"(default)|"paypal", cardLast4?, dryRun?}  GATED
 *     → {status:"paid", purchaseId, bookingNumber, transactionNumber?, total, currency, seats, dryRun?, imageUrl? (PayPal only)}
 *     card: [needs_arm_pin (unarmed + PIN set) →] needs_cvv → paid. Every open challenge is also in
 *     cines_hold_status.pendingInput [{requestId (= challengeId), kind, prompt, expiresAt}]; a
 *     challenge opened by a background job (after in_progress) answers submit_code with
 *     {status:"accepted"} and the job's outcome comes from hold_status (purchases.at(-1) / lastJob).
 *     Errors: CINES_PAYMENT_FAILED (nothing charged; card refusals also released the seats; a
 *     wrong PIN keeps the hold), CINES_UNAVAILABLE "…incierto…" (unknown: never retry or release).
 *   any acting tool may instead return
 *     {status:"needs_email_code"|"needs_cvv"|"needs_3ds", secure:true, challengeId, kind, prompt, expiresAt, imageUrl?}
 *     or {status:"in_progress", jobId}   (poll cines_hold_status)
 *   cines_submit_code {challengeId, code}   HUB ONLY → the paused call's next result
 *   cines_release_hold {holdId?}            ungated → {status:"released"|"none"}
 *   cines_hold_status {}                    read
 *
 * The hub logic only uses the functions below.
 */
type Rec = Record<string, unknown>;

export const HOLD_TOOL = 'cines_hold_seats';
export const PURCHASE_TOOL = 'cines_purchase';
export const RELEASE_TOOL = 'cines_release_hold';
export const SECURE_TOOL = 'cines_submit_code';
export const STATUS_TOOL = 'cines_hold_status';

/** The server refused a real payment because it is not armed on the Mac (nothing was recorded). */
export const NOT_ARMED = /no est[aá] armado|armado del pago expir/i;
/** Tools the model must never see or call. */
export const HUB_ONLY_TOOLS: ReadonlySet<string> = new Set([SECURE_TOOL]);
/** Tools that move money or hold seats: always behind the hub's own checks, never in plans. */
export const MONEY_TOOLS: ReadonlySet<string> = new Set([HOLD_TOOL, PURCHASE_TOOL]);

export const HARD_CAP_MXN = 1000;

export type SecureKind = 'email_code' | 'cvv' | 'otp_3ds' | string;

/** Formats checked by the hub BEFORE forwarding (a bad one is asked again, the server is not called). */
export const SECURE_FORMAT: Record<string, { re: RegExp; es: string; en: string }> = {
  email_code: { re: /^\d{6}$/, es: '6 dígitos', en: '6 digits' },
  cvv: { re: /^\d{3,4}$/, es: '3 o 4 dígitos', en: '3 or 4 digits' },
  otp_3ds: { re: /^[0-9A-Za-z]{4,10}$/, es: '4 a 10 letras o números', en: '4 to 10 letters or digits' },
  arm_pin: { re: /^\d{6,8}$/, es: '6 a 8 dígitos', en: '6 to 8 digits' },
};
/** Secrets that belong to a payment (the hub settles them itself, no model call). */
export const PAYMENT_KINDS: ReadonlySet<string> = new Set(['cvv', 'arm_pin', 'otp_3ds']);
/** The value as forwarded (spaces removed, as the server does). */
export const normalizeSecret = (v: string) => v.replace(/\s+/g, '');

export interface SecureRequest {
  /** challengeId */
  requestId: string;
  kind: SecureKind;
  prompt?: string;
  expiresAt?: string;
  imageUrl?: string;
}
export interface HoldSummary {
  holdId: string;
  cinema: string;
  movie: string;
  /** "2026-10-19 20:30" */
  when: string;
  seats: string[];
  totalMxn: number;
  expiresAt?: string;
  ticketType?: string;
  showtimeId?: string;
  language?: string;
  format?: string;
  unitMxn?: number;
  chargesMxn?: number;
  /** The server's own first-3 rule for this purchase (from the hold result). */
  serverApprovalRequired?: boolean;
  /** What the user asked to pay with (default: the saved card). */
  cardLast4?: string;
  method?: 'paypal';
}

const obj = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);

/** A result asking the hub to collect a secret from the user. */
export function secureRequestOf(result: unknown): SecureRequest | undefined {
  const r = obj(result);
  if (!r || typeof r.status !== 'string' || !r.status.startsWith('needs_') || typeof r.challengeId !== 'string') return undefined;
  return {
    requestId: r.challengeId,
    kind: String(r.kind ?? 'code'),
    prompt: typeof r.prompt === 'string' ? r.prompt : undefined,
    expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : undefined,
    imageUrl: typeof r.imageUrl === 'string' ? r.imageUrl : undefined,
  };
}

/** Challenges listed by cines_hold_status (`pendingInput`), e.g. a CVV asked after an in_progress. */
export function pendingInputOf(status: unknown): SecureRequest[] {
  const list = obj(status)?.pendingInput;
  if (!Array.isArray(list)) return [];
  return list.flatMap((x) => {
    const r = obj(x);
    const id = r && (typeof r.requestId === 'string' ? r.requestId : typeof r.challengeId === 'string' ? r.challengeId : undefined);
    if (!r || !id) return [];
    return [{ requestId: id, kind: String(r.kind ?? 'code'), prompt: typeof r.prompt === 'string' ? r.prompt : undefined, expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : undefined, imageUrl: typeof r.imageUrl === 'string' ? r.imageUrl : undefined }];
  });
}

/** "1234" and "99" from a challenge prompt ("…tu tarjeta *1234 para pagar $99 MXN."). */
export function promptDetails(prompt: string | undefined): { last4?: string; total?: string } {
  const p = prompt ?? '';
  return { last4: p.match(/\*(\d{4})\b/)?.[1], total: p.match(/\$\s?(\d[\d,]*(?:\.\d+)?)/)?.[1] };
}

/**
 * A payment error, by what it means for the user (server texts from cines-mx-mcp card.ts / purchase.ts):
 * unknown = no clear answer after the charge (never retry, never release); 3ds = the bank wants
 * 3-D Secure, refused before any charge (seats released); pin = wrong PIN or "Espera N s" (nothing
 * recorded, the hold stays, Comprar again); pin_disabled = 3rd wrong PIN (arm at the Mac first).
 */
export function paymentErrorKind(code: string, message: string): 'unknown' | '3ds' | 'pin' | 'pin_disabled' | undefined {
  if (code === 'CINES_UNAVAILABLE' && /incierto|uncertain/i.test(message)) return 'unknown';
  if (/3-?D\s*Secure|\b3DS\b/i.test(message)) return '3ds';
  // 3 wrong PINs (now or earlier): PIN arming is off until bin/cinesctl set-arm-pin at the Mac
  if (/\bPIN\b/.test(message) && /desactiv/i.test(message)) return 'pin_disabled';
  if (/\bPIN\b/.test(message) && (code === 'CINES_PAYMENT_FAILED' || code === 'CINES_BAD_REQUEST')) return 'pin';
  return undefined;
}

/** The card the user named in the request ("con la tarjeta terminación 4321", "*4321"), or PayPal. */
export function paymentChoiceOf(text: string | undefined): { cardLast4?: string; method?: 'paypal' } {
  const t = text ?? '';
  if (/\bpay\s?pal\b/i.test(t)) return { method: 'paypal' };
  const m = t.match(/(?:tarjeta|card|terminaci[oó]n|termina(?:da)? en|ending(?: in)?)\D{0,15}?(\d{4})\b|\*(\d{4})\b/i);
  return m ? { cardLast4: m[1] ?? m[2] } : {};
}

/** A successful hold. */
export function holdOf(result: unknown): HoldSummary | undefined {
  const r = obj(result);
  if (!r || r.status !== 'held' || typeof r.holdId !== 'string' || typeof r.total !== 'number') return undefined;
  return {
    holdId: r.holdId,
    showtimeId: typeof r.showtimeId === 'string' ? r.showtimeId : undefined,
    cinema: String(r.cinema ?? r.cinemaName ?? ''),
    movie: String(r.movie ?? ''),
    when: whenOf(r),
    seats: Array.isArray(r.seats) ? r.seats.map(String) : String(r.seats ?? '').split(/[,\s]+/).filter(Boolean),
    totalMxn: r.total,
    ticketType: typeof r.ticketType === 'string' ? r.ticketType : undefined,
    expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : undefined,
    language: typeof r.language === 'string' ? r.language : typeof r.lang === 'string' ? r.lang : undefined,
    format: typeof r.format === 'string' ? r.format : undefined,
    unitMxn: typeof r.unitMxn === 'number' ? r.unitMxn : undefined,
    chargesMxn: typeof r.chargesMxn === 'number' ? r.chargesMxn : undefined,
  };
}

/** "2026-10-19 20:30" from startsAt (ISO with offset; shown in the cinema's local time) or date/time. */
function whenOf(r: Rec): string {
  if (typeof r.date === 'string' && typeof r.time === 'string') return `${r.date} ${r.time}`;
  const s = typeof r.startsAt === 'string' ? r.startsAt : '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : s;
}

/** Outcome of a purchase result: paid (real), dry-run, or not a purchase outcome. */
export function purchaseOutcome(result: unknown): 'paid' | 'dry-run' | undefined {
  const r = obj(result);
  if (!r || r.status !== 'paid') return undefined;
  return r.dryRun ? 'dry-run' : 'paid';
}

export const holdIdOf = (args: Rec) => (typeof args.holdId === 'string' ? args.holdId : undefined);

/**
 * The purchase arguments the hub sends: the total is the hold's (never the model's), and
 * `userApproved` is set by the hub only (the model cannot claim it).
 */
export function purchaseArgs(args: Rec, hold: HoldSummary, userApproved: boolean, opts: { dryRun?: boolean } = {}): Rec {
  const rest = { ...args };
  delete rest.userApproved;
  delete rest.expectedTotal;
  // only the documented values: the card's last four (4 digits) and "card" | "paypal"
  if (rest.cardLast4 !== undefined && !/^\d{4}$/.test(String(rest.cardLast4))) delete rest.cardLast4;
  if (rest.method !== undefined && rest.method !== 'card' && rest.method !== 'paypal') delete rest.method;
  if (rest.method === undefined && hold.method) rest.method = hold.method;
  if (rest.cardLast4 === undefined && hold.cardLast4 && rest.method !== 'paypal') rest.cardLast4 = hold.cardLast4;
  return { ...rest, holdId: hold.holdId, expectedTotal: hold.totalMxn, userApproved, ...(opts.dryRun ? { dryRun: true } : {}) };
}

/** The arguments of the hub-only secure-input call. */
export const secureArgs = (req: Pick<SecureRequest, 'requestId'>, value: string): Rec => ({ challengeId: req.requestId, code: normalizeSecret(value) });

/** Image to send to the user, if the result carries one. */
export function imageUrlOf(result: unknown): string | undefined {
  const r = obj(result);
  return r && typeof r.imageUrl === 'string' ? r.imageUrl : undefined;
}
