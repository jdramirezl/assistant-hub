/**
 * No availability claims without evidence. "C7 no está disponible" or "solo la hay doblada" are
 * facts about Cinépolis: the reply may state them only if a tool result IN THIS TURN shows it
 * (a seat check / seat map for seats; an unfiltered showtimes listing for "only X"). Otherwise the
 * reply gets ONE retry with feedback (same mechanism as the false-save guard); if it still claims,
 * the claim sentences are removed.
 */
import { usageContext } from '../telemetry/context.js';
import { markTiming } from '../telemetry/timing.js';

type Part = { type: string; delta?: string };
/** The request is about Cinépolis (only then a list of times is a showtime claim). */
const cinesActive = () => {
  const s = usageContext.getStore();
  return s?.intent === 'cines' || (!!s?.domains?.includes('cines') && !s.domains.includes('fitness'));
};
type Msg = { role: string; content: unknown };
type StreamModel = {
  specificationVersion: string;
  provider: string;
  modelId: string;
  supportedUrls?: unknown;
  doGenerate(o: unknown): PromiseLike<unknown>;
  doStream(o: unknown): PromiseLike<{ stream: ReadableStream<Part> }>;
};

const SEAT = /\b[A-N]\d{1,2}\b/;
const UNAVAILABLE = /(no (?:est[aá]|se encuentra|queda|aparece) (?:disponible|libre)|ocupad[oa]s?|no disponible|ya (?:est[aá] )?vendid|not available|unavailable|taken|already sold)/i;
const ONLY = /(\b(?:s[oó]lo|solamente|[uú]nicamente)\b[^.\n]{0,40}\b(?:doblad|subtitulad|en espa[nñ]ol|en ingl[eé]s)|\bonly\b[^.\n]{0,30}\b(?:dubbed|subtitled|in spanish)|\bno hay funciones?\b|\bno (?:la )?(?:pasan|dan|tienen|hay)\b[^.\n]{0,40}\b(?:subtitulad|doblad|en (?:el |la )?(?:toreo|miyana|carso|sat[eé]lite)))/i;

/** "No está en cartelera": only from cines_find_movie found:false (6d7c617), citing what was searched. */
const NOT_SHOWING = /(\bno (?:est[aá]|se encuentra|aparece|figura)[^.\n]{0,25}\ben (?:la )?cartelera|\bno (?:la|lo) (?:est[aá]n )?(?:dando|pasando|proyectando|exhibiendo)\b|\bya no (?:la|lo) (?:pasan|dan|tienen)\b|\bnot (?:showing|playing|in theaters)\b)/i;

export type Claim = 'seat' | 'only' | 'listing' | 'not_showing';
/** 3+ distinct clock times: a showtime listing (must come from a cines tool in this turn). */
const listingLike = (text: string) => new Set(text.match(/\b(?:[01]?\d|2[0-3])[:.][0-5]\d\b/g) ?? []).size >= 3;
export function claimsOf(text: string, opts: { cines?: boolean } = {}): Claim[] {
  const out: Claim[] = [];
  if (opts.cines && listingLike(text)) out.push('listing');
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  if (sentences.some((s) => SEAT.test(s) && UNAVAILABLE.test(s))) out.push('seat');
  if (NOT_SHOWING.test(text)) out.push('not_showing');
  else if (ONLY.test(text)) out.push('only');
  return out;
}

/** Tool results (name + JSON) after the last user message. */
function resultsThisTurn(prompt: Msg[]): { tool: string; json: string }[] {
  const lastUser = prompt.map((m) => m.role).lastIndexOf('user');
  const out: { tool: string; json: string }[] = [];
  for (const m of prompt.slice(lastUser + 1)) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const r of m.content as { type?: string; toolName?: string; output?: { value?: unknown } }[]) {
      if (r.type === 'tool-result' && r.toolName) out.push({ tool: r.toolName, json: JSON.stringify(r.output?.value ?? '') });
    }
  }
  return out;
}

/** A found:false whose searched range the reply names (its last day or publishedThrough). */
function citesMiss(rs: { tool: string; json: string }[], text: string): boolean {
  return rs.some((r) => {
    if (r.tool !== 'cines_find_movie' || !/"found":false/.test(r.json)) return false;
    const days = [...r.json.matchAll(/"(?:to|publishedThrough)":"(\d{4})-(\d{2})-(\d{2})"/g)];
    return days.some((d) => text.includes(`${d[1]}-${d[2]}-${d[3]}`) || new RegExp(`\\b0?${Number(d[3])}\\b`).test(text));
  });
}

export function hasEvidence(claim: Claim, prompt: Msg[], text = ''): boolean {
  const rs = resultsThisTurn(prompt);
  if (claim === 'not_showing') return citesMiss(rs, text);
  // a hub seat-pick check rides in the user turn itself
  const lastUser = [...prompt].reverse().find((m) => m.role === 'user');
  if (claim === 'listing') return rs.some((r) => r.tool.startsWith('cines_'));
  if (claim === 'seat') return rs.some((r) => /^cines_(validate_seats|seat_map|hold_seats)$/.test(r.tool)) || /cines_validate_seats/.test(JSON.stringify(lastUser?.content ?? ''));
  return rs.some((r) => r.tool === 'cines_showtimes' || r.tool === 'cines_listings' || r.tool === 'cines_find_movie' || (r.tool === 'cines_best_showtime' && r.json.includes('at_named_cinemas')));
}

const FEEDBACK: Record<Claim, string> = {
  listing: 'you listed showtimes, but no cines tool was called in this turn: those times are invented. Call the right cines_* tool (cines_listings for a cinema, cines_showtimes / cines_best_showtime for a movie) and answer only from its result',
  seat: 'you said a seat is unavailable/taken, but no seat check in this turn shows it. Call cines_validate_seats with the showtimeId of the seat map the user saw and their seats, then answer from its result',
  not_showing: 'you said the movie is not showing, but only a cines_find_movie result with found:false in this turn can show that, and the reply must name what was searched. Call cines_find_movie {movie, altTitles: [its English / original / Spanish titles]} (e.g. ["Your Name","Kimi no Na wa","Tu Nombre"]); if it is found, say where and from which date; if found is false, say it does not appear between searched.from and searched.to at those cinemas (Cinépolis has published through publishedThrough)',
  only: 'you said only one version exists (or none) at a cinema, but no unfiltered listing in this turn shows it. Call cines_showtimes {movie, date, cinema} (no window/vip/format filters) for the cinemas in question, then say what exists there',
};
const strip = (text: string, claims: Claim[]) =>
  text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !(claims.includes('listing') && listingLike(s)) && !(claims.includes('seat') && SEAT.test(s) && UNAVAILABLE.test(s)) && !(claims.includes('only') && ONLY.test(s)) && !(claims.includes('not_showing') && NOT_SHOWING.test(s)))
    .join(' ')
    .trim();

async function drain(stream: ReadableStream<Part>): Promise<Part[]> {
  const out: Part[] = [];
  const r = stream.getReader();
  for (;;) {
    const { value, done } = await r.read();
    if (done) return out;
    out.push(value);
  }
}
const replay = (parts: Part[]) =>
  new ReadableStream<Part>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
const textOf = (parts: Part[]) => parts.filter((p) => p.type === 'text-delta').map((p) => p.delta ?? '').join('');
const hasToolCall = (parts: Part[]) => parts.some((p) => p.type === 'tool-call');
function withText(parts: Part[], text: string): Part[] {
  let done = false;
  return parts.flatMap((p) => (p.type !== 'text-delta' ? [p] : done ? [] : ((done = true), [{ ...p, delta: text }])));
}

export function withEvidenceGuard(model: unknown, log: (m: string) => void = () => {}): unknown {
  const m = model as StreamModel;
  if (!m || typeof m.doStream !== 'function') return model;
  const guardedStream = async (options: unknown) => {
    const first = await m.doStream(options);
    const parts = await drain(first.stream);
    const prompt = ((options as { prompt?: Msg[] }).prompt ?? []) as Msg[];
    if (hasToolCall(parts)) return { ...first, stream: replay(parts) };
    const cinesTurn = cinesActive();
    const missing = claimsOf(textOf(parts), { cines: cinesTurn }).filter((c) => !hasEvidence(c, prompt, textOf(parts)));
    if (!missing.length) return { ...first, stream: replay(parts) };
    log(`[guard] reply claims ${missing.join(' + ')} availability without evidence; retrying once with feedback`);
    markTiming('guard-evidence');
    const fb = `[hub] Not verified: ${missing.map((c) => FEEDBACK[c]).join('; and ')}. Never state availability a tool did not show in this turn.`;
    const retry = await m.doStream({ ...(options as object), prompt: [...prompt, { role: 'user', content: [{ type: 'text', text: fb }] }] });
    const again = await drain(retry.stream);
    if (hasToolCall(again)) return { ...retry, stream: replay(again) };
    const still = claimsOf(textOf(again), { cines: cinesTurn }).filter((c) => !hasEvidence(c, prompt, textOf(again)));
    if (!still.length) return { ...retry, stream: replay(again) };
    log('[guard] still an unverified availability claim; removed it');
    return { ...retry, stream: replay(withText(again, strip(textOf(again), still))) };
  };
  const wrapped: StreamModel = {
    specificationVersion: m.specificationVersion,
    provider: m.provider,
    modelId: m.modelId,
    get supportedUrls() {
      return m.supportedUrls;
    },
    doGenerate: (o) => m.doGenerate(o),
    doStream: (o) => guardedStream(o),
  };
  return wrapped;
}
