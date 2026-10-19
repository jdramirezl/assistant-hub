/**
 * The ONE place that knows the shape of cines-mx-mcp's Phase 3 tools: the FINAL contract v1
 * (cines-mx-mcp docs/hub-integration.md, commit 542f827):
 *
 *   cines_hold_seats {showtimeId, seats: string[] | "F7,F8", tickets?, ticketType?, wheelchair?}   GATED
 *     → {status:"held", holdId, cinema, movie, startsAt, seats, ticketType, unitMxn, chargesMxn,
 *        subtotalMxn, total, currency:"MXN", expiresAt, purchaseApprovalRequired, capMxn}
 *   cines_purchase {holdId, expectedTotal, userApproved?, method?: "paypal"|"card", dryRun?}  GATED
 *     → {status:"paid", purchaseId, bookingNumber, transactionNumber?, total, currency, seats, dryRun?}
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
};
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
  /** The server's own first-3 rule for this purchase (from the hold result). */
  serverApprovalRequired?: boolean;
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

/** A successful hold. */
export function holdOf(result: unknown): HoldSummary | undefined {
  const r = obj(result);
  if (!r || r.status !== 'held' || typeof r.holdId !== 'string' || typeof r.total !== 'number') return undefined;
  return {
    holdId: r.holdId,
    cinema: String(r.cinema ?? r.cinemaName ?? ''),
    movie: String(r.movie ?? ''),
    when: whenOf(r),
    seats: Array.isArray(r.seats) ? r.seats.map(String) : String(r.seats ?? '').split(/[,\s]+/).filter(Boolean),
    totalMxn: r.total,
    ticketType: typeof r.ticketType === 'string' ? r.ticketType : undefined,
    expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : undefined,
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
  return { ...rest, holdId: hold.holdId, expectedTotal: hold.totalMxn, userApproved, ...(opts.dryRun ? { dryRun: true } : {}) };
}

/** The arguments of the hub-only secure-input call. */
export const secureArgs = (req: Pick<SecureRequest, 'requestId'>, value: string): Rec => ({ challengeId: req.requestId, code: normalizeSecret(value) });

/** Image to send to the user, if the result carries one. */
export function imageUrlOf(result: unknown): string | undefined {
  const r = obj(result);
  return r && typeof r.imageUrl === 'string' ? r.imageUrl : undefined;
}
