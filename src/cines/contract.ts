/**
 * The ONE place that knows the shape of cines-mx-mcp's Phase 3 tools (holds, purchases,
 * secure input). Built against thread 4's draft (cines-mx-mcp working tree, Oct 2026):
 *
 *   cines_hold_seats {showtimeId, seats:"F7,F8", ticketType?, wheelchair?}
 *     → {status:"held", holdId, cinemaName, date, time, language, format, seats[], totalMxn, movie, …}
 *       or {status:"needs_input", kind:"email_code", requestId, prompt, expiresAt, secure:true}
 *   cines_purchase {holdId, expectedTotalMxn, method?:"paypal"|"card", userApproved?, dryRun?}
 *     → {status:"paid", bookingNumber, totalMxn, seats, dryRun?}
 *       or needs_input (kind "cvv" | "otp_3ds")
 *   cines_secure_input {requestId, value}   HUB ONLY: never shown to the model
 *   cines_release_hold {holdId?}            ungated
 *
 * When the final contract lands, align it here (and the fixtures); the hub logic only uses
 * the functions below.
 */
type Rec = Record<string, unknown>;

export const HOLD_TOOL = 'cines_hold_seats';
export const PURCHASE_TOOL = 'cines_purchase';
export const RELEASE_TOOL = 'cines_release_hold';
export const SECURE_TOOL = 'cines_secure_input';
/** Tools the model must never see or call. */
export const HUB_ONLY_TOOLS: ReadonlySet<string> = new Set([SECURE_TOOL]);
/** Tools that move money or hold seats: always behind the hub's own checks, never in plans. */
export const MONEY_TOOLS: ReadonlySet<string> = new Set([HOLD_TOOL, PURCHASE_TOOL]);

export const HARD_CAP_MXN = 1000;

export type SecureKind = 'email_code' | 'cvv' | 'otp_3ds' | string;
export interface SecureRequest {
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
}

const obj = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);

/** A result asking the hub to collect a secret from the user. */
export function secureRequestOf(result: unknown): SecureRequest | undefined {
  const r = obj(result);
  if (!r || r.status !== 'needs_input' || typeof r.requestId !== 'string') return undefined;
  return {
    requestId: r.requestId,
    kind: String(r.kind ?? 'code'),
    prompt: typeof r.prompt === 'string' ? r.prompt : undefined,
    expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : undefined,
    imageUrl: typeof r.imageUrl === 'string' ? r.imageUrl : undefined,
  };
}

/** A successful hold. */
export function holdOf(result: unknown): HoldSummary | undefined {
  const r = obj(result);
  if (!r || typeof r.holdId !== 'string' || typeof r.totalMxn !== 'number' || (r.status !== undefined && r.status !== 'held')) return undefined;
  return {
    holdId: r.holdId,
    cinema: String(r.cinemaName ?? r.cinema ?? ''),
    movie: String(r.movie ?? ''),
    when: [r.date, r.time].filter(Boolean).join(' '),
    seats: Array.isArray(r.seats) ? r.seats.map(String) : String(r.seats ?? '').split(/[,\s]+/).filter(Boolean),
    totalMxn: r.totalMxn,
    expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : undefined,
  };
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
export function purchaseArgs(args: Rec, hold: HoldSummary, userApproved: boolean): Rec {
  const rest = { ...args };
  delete rest.userApproved;
  delete rest.expectedTotalMxn;
  return { ...rest, holdId: hold.holdId, expectedTotalMxn: hold.totalMxn, userApproved };
}

/** The arguments of the hub-only secure-input call. */
export const secureArgs = (req: Pick<SecureRequest, 'requestId'>, value: string): Rec => ({ requestId: req.requestId, value });

/** Image to send to the user, if the result carries one. */
export function imageUrlOf(result: unknown): string | undefined {
  const r = obj(result);
  return r && typeof r.imageUrl === 'string' ? r.imageUrl : undefined;
}
