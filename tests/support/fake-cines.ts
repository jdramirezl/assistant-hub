/**
 * Fake cines-mx-mcp for tests and the replay. Serves the EXACT tool definitions exported from
 * cines-mx-mcp main 542f827 (fixtures/cines-tools.json: read + seat tools;
 * fixtures/cines-phase3-tools.json: the final Phase 3 contract v1) and mimics their results.
 *
 * Plain stateless Streamable HTTP (JSON responses) on loopback, like the real server, plus
 * GET /images/<id>.png for seat maps. Default error style: failures are isError with a single
 * JSON text block {error:{code,message,retryable}}.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

type Rec = Record<string, unknown>;
const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as { name: string }[];
export const CINES_TOOLS = fixture('cines-tools.json');
export const CINES_PHASE3_TOOLS = fixture('cines-phase3-tools.json');

/** A tiny valid PNG (solid color), so the hub can check the signature. */
export function tinyPng(w = 4, h = 4): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const CINEMAS = [
  { id: 'toreo', name: 'Cinépolis Parque Toreo', distanceKm: 1.2, vip: false },
  { id: 'carso', name: 'Cinépolis Plaza Carso', distanceKm: 4.8, vip: true },
  { id: 'satelite', name: 'Cinépolis Satélite', distanceKm: 6.5, vip: true },
  { id: 'miyana', name: 'Cinépolis VIP Miyana Polanco', distanceKm: 5.1, vip: true },
];
export const MOVIES = [
  { id: 'm-dune3', title: 'Dune: Mesías', rating: 'B', minutes: 165 },
  { id: 'm-coco2', title: 'Coco 2', rating: 'A', minutes: 105 },
];
/** showtimeId → showtime. All "today" in the fake. */
export const SHOWTIMES = [
  { id: '570-1001', movieId: 'm-dune3', cinemaId: 'toreo', time: '17:10', language: 'SUB', format: '2D', priceMxn: 92 },
  { id: '570-1002', movieId: 'm-dune3', cinemaId: 'toreo', time: '20:30', language: 'SUB', format: '2D', priceMxn: 92 },
  { id: '570-1003', movieId: 'm-dune3', cinemaId: 'toreo', time: '21:15', language: 'ESP', format: '2D', priceMxn: 92 },
  { id: '571-2001', movieId: 'm-dune3', cinemaId: 'carso', time: '21:00', language: 'SUB', format: 'IMAX', priceMxn: 165 },
  { id: '572-3001', movieId: 'm-dune3', cinemaId: 'miyana', time: '20:00', language: 'SUB', format: 'VIP', priceMxn: 260 },
  { id: '570-1101', movieId: 'm-coco2', cinemaId: 'toreo', time: '16:00', language: 'ESP', format: '2D', priceMxn: 85 },
  { id: '570-1102', movieId: 'm-coco2', cinemaId: 'toreo', time: '19:40', language: 'ESP', format: '2D', priceMxn: 85 },
];

export interface CinesAction {
  op: string;
  detail: string;
}
export interface FakeCinesOptions {
  /** Serve the Phase 3 draft tools (hold / purchase / secure input). */
  phase3?: boolean;
  /** cines_hold_seats first asks for the Cinépolis e-mail code. */
  emailCode?: boolean;
  /** cines_purchase asks for these, in order (e.g. ['cvv', 'otp_3ds']). */
  purchaseInputs?: ('cvv' | 'otp_3ds')[];
  /** Price per ticket override (to test the $1,000 cap). */
  priceMxn?: number;
  /** cines_purchase fails with CINES_PAYMENT_FAILED. */
  paymentFails?: boolean;
  /** cines_purchase returns {status:"in_progress"} (PayPal at the Mac); hold_status reports the outcome after N polls. */
  inProgress?: { polls: number; outcome: 'paid' | 'failed' | 'unknown' };
  /** Real (non-dryRun) payment armed on the server Mac; default true. false → "no está armado". */
  paymentArmed?: boolean;
  /** Successful purchases already in the server's ledger. */
  successes?: number;
  /** Like the real server today: a non-dryRun payment fails ("aún no está habilitado"). */
  realPaymentDisabled?: boolean;
}
/** Cinépolis fees per ticket (included in `total`). */
export const FEE_MXN = 7;
export interface FakeCines {
  url: string;
  base: string;
  actions: CinesAction[];
  calls: { tool: string; args: Rec }[];
  /** Values received by cines_secure_input (tests check they never leaked elsewhere). */
  secrets: string[];
  imagesServed: number;
  close(): Promise<void>;
}

const err = (code: string, message: string, retryable = false) => ({ error: { code, message, retryable } });
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
const cinemaOf = (q: unknown) => {
  const n = norm(String(q ?? 'toreo'));
  return CINEMAS.find((c) => c.id === n || norm(c.name).includes(n) || n.includes(c.id));
};
const movieOf = (q: unknown) => {
  const n = norm(String(q ?? ''));
  return MOVIES.find((m) => m.id === n || norm(m.title).includes(n) || n.includes(norm(m.title).split(':')[0]!));
};
const compact = (s: (typeof SHOWTIMES)[number]) => ({
  showtimeId: s.id,
  cinema: CINEMAS.find((c) => c.id === s.cinemaId)!.name,
  time: s.time,
  language: s.language === 'SUB' ? 'subtitulada' : 'doblada',
  format: s.format,
});

export async function startFakeCines(opts: FakeCinesOptions = {}): Promise<FakeCines> {
  const state: FakeCines = { url: '', base: '', actions: [], calls: [], secrets: [], imagesServed: 0, close: async () => {} };
  const images = new Map<string, Buffer>();
  let imageSeq = 0;
  const publish = () => {
    const id = `img${++imageSeq}`;
    images.set(id, tinyPng());
    return `${state.base}/images/${id}.png`;
  };
  const holds = new Map<string, Rec & { holdId: string; totalMxn: number; status: string; seats: string[] }>();
  const paid = new Set<string>();
  const pending = new Map<string, { kind: string; next: (value: string) => unknown }>();
  let reqSeq = 0;
  let successes = opts.successes ?? 0;
  const STATUS: Record<string, string> = { email_code: 'needs_email_code', cvv: 'needs_cvv', otp_3ds: 'needs_3ds' };
  const ask = (kind: string, prompt: string, next: (value: string) => unknown) => {
    const challengeId = `sec_${++reqSeq}`;
    pending.set(challengeId, { kind, next });
    return { status: STATUS[kind], secure: true, challengeId, kind, prompt, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
  };

  const handlers: Record<string, (a: Rec) => unknown> = {
    cines_list_cinemas: () => ({ cinemas: CINEMAS.map((c) => ({ id: c.id, name: c.name, distanceKm: c.distanceKm, vip: c.vip, available: true })) }),
    cines_listings: (a) => {
      const c = cinemaOf(a.cinema);
      if (!c) return err('CINES_NOT_FOUND', `No conozco el cine "${a.cinema}".`);
      const st = SHOWTIMES.filter((s) => s.cinemaId === c.id);
      return {
        date: 'hoy',
        cinemas: [c.name],
        movies: MOVIES.filter((m) => st.some((s) => s.movieId === m.id)).map((m) => ({
          id: m.id,
          title: m.title,
          rating: m.rating,
          showtimes: st.filter((s) => s.movieId === m.id).map((s) => `${s.time} ${s.language} ${s.format}`),
        })),
      };
    },
    cines_find_movie: (a) => {
      const m = movieOf(a.movie);
      if (!m) return err('CINES_NOT_FOUND', `No encontré "${a.movie}" en cartelera.`);
      const cs = [...new Set(SHOWTIMES.filter((s) => s.movieId === m.id).map((s) => s.cinemaId))];
      return { movie: { id: m.id, title: m.title }, cinemas: cs.map((id) => ({ cinema: CINEMAS.find((c) => c.id === id)!.name, dates: ['hoy', 'mañana'] })) };
    },
    cines_showtimes: (a) => {
      const m = movieOf(a.movie);
      if (!m) return err('CINES_NOT_FOUND', `No encontré "${a.movie}".`);
      const st = SHOWTIMES.filter((s) => s.movieId === m.id);
      return { movie: { id: m.id, title: m.title }, count: st.length, showtimes: st.map(compact) };
    },
    cines_best_showtime: (a) => {
      const m = movieOf(a.movie);
      if (!m) return err('CINES_NOT_FOUND', `No encontré "${a.movie}".`);
      const night = a.window === 'night' || a.window === 'evening';
      const st = SHOWTIMES.filter((s) => s.movieId === m.id && (!night || s.time >= '19:00')).sort((x, y) => Number(x.language !== 'SUB') - Number(y.language !== 'SUB'));
      if (!st.length) return { movie: { id: m.id, title: m.title }, best: null, note: 'No hay funciones que cumplan esos criterios.' };
      const qty = Number(a.tickets ?? 1);
      const present = (s: (typeof SHOWTIMES)[number]) => ({
        ...compact(s),
        distanceKm: CINEMAS.find((c) => c.id === s.cinemaId)!.distanceKm,
        why: s.language === 'SUB' ? 'subtitulada, cine cercano' : 'única opción doblada',
        warnings: s.format === 'VIP' ? ['Precio VIP'] : undefined,
        price: { ticketType: 'Admision General', unitMxn: opts.priceMxn ?? s.priceMxn, totalMxn: (opts.priceMxn ?? s.priceMxn) * qty },
      });
      return { movie: { id: m.id, title: m.title }, tickets: qty, best: present(st[0]!), alternatives: st.slice(1, 3).map(present) };
    },
    cines_upcoming: () => ({ upcoming: [{ title: 'Avatar 4', releaseDate: '2026-12-18', presale: true }] }),
    cines_seat_map: (a) => {
      const s = SHOWTIMES.find((x) => x.id === a.showtimeId);
      if (!s) return err('CINES_BAD_REQUEST', `Función desconocida: ${a.showtimeId}`);
      const n = Number(a.tickets ?? 1);
      const premium = s.format !== '2D';
      const row = premium ? 'J' : 'F';
      return {
        showtimeId: s.id,
        imageUrl: publish(),
        proposal: Array.from({ length: n }, (_, i) => `${row}${7 + i}`),
        together: true,
        mode: premium ? 'centro, filas altas' : 'centro, filas medias-bajas',
        available: 120,
        taken: 40,
        next: 'Muestra la imagen; si el usuario elige otros asientos, valida con cines_validate_seats.',
      };
    },
    cines_validate_seats: (a) => {
      const seats = String(a.seats ?? '').split(/[,\s]+/).filter(Boolean).map((x) => x.toUpperCase());
      const bad = seats.filter((x) => !/^[A-N]\d{1,2}$/.test(x));
      return { showtimeId: a.showtimeId, ok: bad.length === 0, seats, errors: bad.length ? bad.map((b) => `${b} no existe`) : undefined, imageUrl: publish() };
    },
  };

  if (opts.phase3) {
    const finishHold = (a: Rec) => {
      const s = SHOWTIMES.find((x) => x.id === a.showtimeId);
      if (!s) return err('CINES_NOT_FOUND', 'No encontré esa función en tus cines.');
      const seats = (Array.isArray(a.seats) ? a.seats.map(String) : String(a.seats ?? '').split(/[,\s]+/)).filter(Boolean).map((x) => x.toUpperCase());
      if (a.tickets !== undefined && Number(a.tickets) !== seats.length) return err('CINES_BAD_REQUEST', `Pediste ${a.tickets} boletos pero ${seats.length} asientos.`);
      const unit = opts.priceMxn ?? s.priceMxn;
      const subtotal = unit * seats.length;
      if (subtotal + FEE_MXN * seats.length > 1000) return err('CINES_LIMIT_EXCEEDED', `El total $${subtotal + FEE_MXN * seats.length} supera el límite de $1000.`);
      const holdId = `hold_${holds.size + 1}`;
      const h = {
        holdId,
        status: 'held',
        expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
        cinemaName: CINEMAS.find((c) => c.id === s.cinemaId)!.name,
        showtimeId: s.id,
        date: '2026-10-19',
        time: s.time,
        language: s.language,
        format: s.format,
        seats,
        ticketType: 'Admision General',
        unitMxn: unit,
        chargesMxn: FEE_MXN * seats.length,
        subtotalMxn: subtotal,
        totalMxn: subtotal + FEE_MXN * seats.length,
      };
      holds.set(holdId, h);
      state.actions.push({ op: 'hold', detail: `${holdId} ${s.id} ${seats.join(',')} $${h.totalMxn}` });
      return {
        ...h,
        cinema: h.cinemaName,
        movie: MOVIES.find((m) => m.id === s.movieId)!.title,
        startsAt: `2026-10-19T${s.time}:00-06:00`,
        total: h.totalMxn,
        currency: 'MXN',
        purchaseApprovalRequired: successes < 3,
        capMxn: 1000,
        next: 'Muestra el resumen. Para pagar llama cines_purchase con holdId y expectedTotal = total; para cancelar, cines_release_hold.',
      };
    };
    // like the server: oldest first (ledger.recent(3))
    const ledger: Rec[] = [];
    let polls = 0;
    const pay = (h: (typeof holds extends Map<string, infer V> ? V : never), a: Rec) => {
      if (opts.paymentArmed === false && !a.dryRun) {
        if (!a.dryRun) paid.delete(h.holdId);
        h.status = 'held';
        return err('CINES_PAYMENT_FAILED', 'El pago real no está armado. En la Mac servidor: bin/cinesctl arm-payment (válido 30 min, un solo intento).');
      }
      if (opts.inProgress) {
        const n = h.holdId.replace(/\D/g, '').padStart(3, '0');
        ledger.push({ purchaseId: `pur_${n}`, at: new Date().toISOString(), total: h.totalMxn, currency: 'MXN', status: 'started', dryRun: a.dryRun || undefined, holdId: h.holdId });
        polls = 0;
        return { status: 'in_progress', jobId: `job_${n}`, note: 'Sigue en curso; consulta con cines_hold_status.' };
      }
      if (opts.paymentFails || (opts.realPaymentDisabled && !a.dryRun)) {
        h.status = 'failed';
        state.actions.push({ op: 'purchase-failed', detail: h.holdId });
        return err('CINES_PAYMENT_FAILED', opts.paymentFails ? 'El banco rechazó el pago. No se reintentará el pago.' : 'El pago real aún no está habilitado. Usa dryRun. No se reintentará el pago.');
      }
      h.status = a.dryRun ? 'held' : 'purchased';
      if (!a.dryRun) successes++;
      state.actions.push({ op: 'purchase', detail: `${h.holdId} $${h.totalMxn}${a.dryRun ? ' dry-run' : ''}` });
      const n = h.holdId.replace(/\D/g, '').padStart(3, '0');
      return { status: 'paid', purchaseId: `pur_${n}`, dryRun: a.dryRun || undefined, bookingNumber: a.dryRun ? `DRYRUN-${n}` : `BK${n}`, total: h.totalMxn, currency: 'MXN', totalMxn: h.totalMxn, seats: h.seats, imageUrl: publish() };
    };
    Object.assign(handlers, {
      cines_hold_seats: (a: Rec) => (opts.emailCode ? ask('email_code', 'Escribe el código de 6 dígitos que Cinépolis envió a tu correo.', () => finishHold(a)) : finishHold(a)),
      cines_release_hold: (a: Rec) => {
        const h = a.holdId ? holds.get(String(a.holdId)) : [...holds.values()].find((x) => x.status === 'held');
        if (!h) return { status: 'none', note: 'No había asientos apartados.' };
        h.status = 'released';
        state.actions.push({ op: 'release', detail: h.holdId });
        return { status: 'released', holdId: h.holdId, seats: h.seats };
      },
      cines_hold_status: () => {
        // the in-progress purchase settles after N polls
        const last = ledger.at(-1);
        if (last && last.status === 'started' && opts.inProgress && ++polls >= opts.inProgress.polls) {
          last.status = opts.inProgress.outcome;
          const h = holds.get(String(last.holdId))!;
          if (last.status === 'paid') {
            last.bookingNumber = last.dryRun ? `DRYRUN-${String(last.purchaseId).slice(4)}` : `BK${String(last.purchaseId).slice(4)}`;
            last.imageUrl = publish();
            if (!last.dryRun) successes++;
            h.status = last.dryRun ? 'held' : 'purchased';
            state.actions.push({ op: 'purchase', detail: `${h.holdId} $${h.totalMxn}${last.dryRun ? ' dry-run' : ''}` });
          } else state.actions.push({ op: `purchase-${last.status}`, detail: h.holdId });
        }
        return {
          hold: [...holds.values()].find((x) => x.status === 'held') ?? null,
          purchases: ledger.slice(-3).map(({ holdId: _h, ...e }) => e),
          successfulPurchases: successes,
          purchaseApprovalRequired: successes < 3,
          paymentArmed: { armed: opts.paymentArmed !== false },
        };
      },
      cines_purchase: (a: Rec) => {
        const h = holds.get(String(a.holdId));
        if (!h) return err('CINES_NOT_FOUND', 'Ese apartado no existe.');
        if (h.status !== 'held' || (!a.dryRun && paid.has(h.holdId))) return err('CINES_PAYMENT_FAILED', `Ya se intentó pagar este apartado (${h.status}); nunca reintento un pago.`);
        if (h.totalMxn > 1000) return err('CINES_LIMIT_EXCEEDED', `El total $${h.totalMxn} supera el límite de $1000.`);
        if (Math.abs(h.totalMxn - Number(a.expectedTotal)) > 0.005) return err('CINES_BAD_REQUEST', `El total no coincide: apartado $${h.totalMxn}, esperado $${a.expectedTotal}.`);
        if (!a.dryRun) paid.add(h.holdId);
        if (!a.dryRun && successes < 3 && a.userApproved !== true) return err('CINES_BAD_REQUEST', 'Las primeras 3 compras requieren la aprobación explícita del usuario (userApproved: true tras el ✅).');
        if (!a.dryRun) h.status = 'purchasing';
        const steps = [...(opts.purchaseInputs ?? [])];
        const prompts: Record<string, string> = { cvv: 'Escribe el CVV de tu tarjeta.', otp_3ds: 'Escribe el código que te envió tu banco.' };
        const step = (): unknown => {
          const k = steps.shift();
          return k ? ask(k, prompts[k]!, step) : pay(h, a);
        };
        return step();
      },
      cines_submit_code: (a: Rec) => {
        const p = pending.get(String(a.challengeId));
        if (!p) return err('CINES_NOT_FOUND', 'Esa solicitud ya no está activa.');
        const v = String(a.code ?? '').replace(/\s+/g, '');
        const re = p.kind === 'email_code' ? /^\d{6}$/ : p.kind === 'cvv' ? /^\d{3,4}$/ : /^[0-9A-Za-z]{4,10}$/;
        if (!re.test(v)) return err('CINES_BAD_REQUEST', 'Formato inválido.');
        pending.delete(String(a.challengeId));
        state.secrets.push(v);
        return p.next(v);
      },
    });
  }

  const tools = [...CINES_TOOLS, ...(opts.phase3 ? CINES_PHASE3_TOOLS : [])];
  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    const img = (req.url ?? '').match(/^\/images\/(\w+)\.png$/);
    if (req.method === 'GET' && img) {
      const b = images.get(img[1]!);
      if (!b) return void res.writeHead(404).end();
      state.imagesServed++;
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': b.length });
      return void res.end(b);
    }
    if (req.method !== 'POST') return void reply(res, 405, { error: 'method not allowed' });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const msg = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { id?: number | string; method?: string; params?: Rec };
    if (msg.id === undefined) return void (res.writeHead(202), res.end());
    const ok = (result: unknown) => reply(res, 200, { jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize':
        return void ok({ protocolVersion: String((msg.params as { protocolVersion?: string })?.protocolVersion ?? '2025-06-18'), capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'cines-mx-mcp', version: 'fake' } });
      case 'ping':
        return void ok({});
      case 'tools/list':
        return void ok({ tools });
      case 'tools/call': {
        const p = msg.params as { name: string; arguments?: Rec };
        state.calls.push({ tool: p.name, args: p.name === 'cines_submit_code' ? { challengeId: p.arguments?.challengeId, code: '<secret>' } : (p.arguments ?? {}) });
        const h = handlers[p.name];
        const out = h ? h(p.arguments ?? {}) : err('CINES_BAD_REQUEST', `Unknown tool ${p.name}`);
        const isError = !!out && typeof out === 'object' && 'error' in (out as Rec);
        return void ok({ isError, content: [{ type: 'text', text: JSON.stringify(out) }] });
      }
      default:
        return void reply(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.url = `${state.base}/mcp`;
  state.close = () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())));
  return state;
}

export const CINES_REGISTRY = (url: string) => ({ servers: { cines: { url } } });
