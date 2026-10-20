/**
 * Local test entry point: the REAL Telegram pipeline (router, guards, status layer, cards,
 * photos, live MCP apps) driven over loopback HTTP, with a capture sink instead of Telegram.
 *
 *   POST /debug/chat  {text?, voice?: path, image?: path, caption?, allowWrites?}
 *   POST /debug/press {button, allowWrites?}     button = callback data or label substring
 *   GET  /debug/health
 *
 * Safety: 127.0.0.1 only; a random token (0600 file in the data dir) in `x-debug-token`; its own
 * data dir and user id (never the user's Telegram memory); DEV Gemini key only (refuses the prod
 * key); paced well under the free tier, with per-request and daily call budgets; read-only unless
 * the request says allowWrites:true (approval-gated tools also need an explicit press);
 * cines_purchase is never allowed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config.js';
import { createHub, type Hub, type HubDeps } from '../hub.js';
import { Pacer } from '../llm/pacer.js';
import { usageContext } from '../telemetry/context.js';
import { TelegramSink } from './sink.js';

type Rec = Record<string, unknown>;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const DEBUG_USER_ID = 7_000_001;

export class DebugRefused extends Error {}

/** The DEV Gemini key; refuses when there is none or it is the production key. */
export function debugKey(env: Record<string, string | undefined>, repo = process.cwd()): string {
  const key = env.DEV_GOOGLE_API_KEY || env.REPLAY_GOOGLE_API_KEY;
  if (!key) throw new DebugRefused('set DEV_GOOGLE_API_KEY (or REPLAY_GOOGLE_API_KEY) to a key from the dev Google project; the debug entry point never uses the production key');
  const serverFile = join(repo, '.env.server');
  const prodFromFile = existsSync(serverFile) ? readFileSync(serverFile, 'utf8').match(/^GOOGLE_API_KEY=(.*)$/m)?.[1]?.trim() : undefined;
  if (key === env.GOOGLE_API_KEY || key === prodFromFile || key === env.PROD_GOOGLE_API_KEY) throw new DebugRefused('the dev key equals the production key; refusing');
  return key;
}

export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK.has(host)) throw new DebugRefused(`refusing to bind ${host}: the debug entry point only listens on loopback`);
}

export const defaultDebugDir = (env: Record<string, string | undefined>) => env.DEBUG_DATA_DIR ?? join(env.HUB_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'assistant-hub'), 'debug');

/** Gemini fetch with call budgets (per request and per day, persisted) and pacing well below 15 RPM. */
export function budgetedFetch(opts: { perRequest: number; perDay: number; file: string; base?: typeof fetch; now?: () => number; timezone: string }) {
  const perReq = new Map<string, number>();
  let inflight = 0;
  const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: opts.timezone }).format((opts.now ?? Date.now)());
  const load = (): { day: string; calls: number } => {
    try {
      const j = JSON.parse(readFileSync(opts.file, 'utf8')) as { day: string; calls: number };
      return j.day === day() ? j : { day: day(), calls: 0 };
    } catch {
      return { day: day(), calls: 0 };
    }
  };
  const f = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const id = usageContext.getStore()?.requestId ?? 'none';
    const used = load();
    if (used.calls >= opts.perDay) throw new DebugRefused(`debug daily Gemini budget reached (${opts.perDay} calls; DEBUG_DAILY_CALLS)`);
    const n = (perReq.get(id) ?? 0) + 1;
    if (n > opts.perRequest) throw new DebugRefused(`debug per-request Gemini budget reached (${opts.perRequest} calls; DEBUG_REQUEST_CALLS)`);
    perReq.set(id, n);
    writeFileSync(opts.file, JSON.stringify({ day: used.day, calls: used.calls + 1 }), { mode: 0o600 });
    inflight++;
    try {
      return await (opts.base ?? fetch)(input, init);
    } finally {
      inflight--;
    }
  }) as typeof fetch;
  return { fetch: f, busy: () => inflight > 0, used: () => load().calls };
}

export interface DebugServerOptions {
  env?: Record<string, string | undefined>;
  dataDir?: string;
  host?: string;
  port?: number;
  /** Test seams (scripted model, inline registry). */
  hubDeps?: HubDeps;
  /** Idle time that ends a request (default 3 s) and the hard cap (default 240 s). */
  quietMs?: number;
  maxWaitMs?: number;
}

export async function startDebugServer(o: DebugServerOptions = {}) {
  const env = { ...(o.env ?? process.env) };
  const host = o.host ?? env.DEBUG_HOST ?? '127.0.0.1';
  assertLoopbackHost(host);
  const key = o.hubDeps?.model ? 'test' : debugKey(env);
  const dataDir = resolve(o.dataDir ?? defaultDebugDir(env));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tokenFile = join(dataDir, 'debug-token');
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString('hex'), { mode: 0o600 });
  const token = readFileSync(tokenFile, 'utf8').trim();

  const sink = await new TelegramSink(join(dataDir, 'photos'), DEBUG_USER_ID).start();
  const hubEnv: Record<string, string | undefined> = {
    ...env,
    NODE_ENV: 'development',
    GOOGLE_API_KEY: key,
    DEV_GOOGLE_API_KEY: key,
    HUB_DATA_DIR: join(dataDir, 'hub'),
    TELEGRAM_BOT_TOKEN: '1:debug-sink',
    TELEGRAM_ALLOWED_USER_IDS: String(DEBUG_USER_ID),
    HEALTHCHECK_URL: undefined,
  };
  mkdirSync(hubEnv.HUB_DATA_DIR!, { recursive: true, mode: 0o700 });
  const config = loadConfig(hubEnv);
  const budget = budgetedFetch({
    perRequest: Number(env.DEBUG_REQUEST_CALLS ?? 8),
    perDay: Number(env.DEBUG_DAILY_CALLS ?? 80),
    file: join(dataDir, 'debug-calls.json'),
    timezone: config.timezone,
  });
  const rpm = Number(env.DEBUG_RPM ?? 6);
  let allowWrites = false;
  const logs: string[] = [];
  const hub: Hub = createHub(config, {
    env: hubEnv,
    geminiFetch: budget.fetch,
    geminiPacer: new Pacer({ limits: { 'gemini-3.5-flash-lite': { rpm, tpm: 200_000 }, 'gemini-3.8-flash': { rpm: Math.min(2, rpm), tpm: 200_000 } } }),
    debug: { allowWrites: () => allowWrites },
    ...o.hubDeps,
    telegram: { apiBaseUrl: sink.url, longPolling: { timeout: 0, retryDelayMs: 100 }, log: (m) => (logs.push(m), console.warn(`[debug-hub] ${m}`)) },
  });
  await hub.start({ ops: false, catchUp: false, connectRetries: 1 });

  const settle = async (t0: number) => {
    const quiet = o.quietMs ?? 3000;
    const max = o.maxWaitMs ?? 240_000;
    await new Promise((r) => setTimeout(r, 300));
    while (Date.now() - t0 < max) {
      if (!budget.busy() && hub.openRequests() === 0 && Date.now() - sink.lastActivity > quiet) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const transcript = async (from: number, logFrom: number, t0: number) => {
    const calls = sink.calls.slice(from).filter((c) => c.method !== 'sendChatAction' && c.method !== 'answerCallbackQuery');
    const messages = calls
      .filter((c) => /send|edit|delete/.test(c.method))
      .map((c) => {
        const text = String((c.body.rich_message as { markdown?: string } | undefined)?.markdown ?? c.body.text ?? c.body.caption ?? '');
        const kb = (c.body.reply_markup as { inline_keyboard?: { text?: string; callback_data?: string }[][] } | undefined)?.inline_keyboard?.flat() ?? [];
        return {
          kind: c.method === 'sendPhoto' ? 'photo' : c.method === 'deleteMessage' ? 'delete' : c.body.parse_mode === 'HTML' ? 'status' : kb.length ? 'card' : 'message',
          op: c.method,
          id: Number(c.body.message_id ?? (c.result as { message_id?: number } | undefined)?.message_id ?? 0),
          ...(text ? { text } : {}),
          ...(kb.length ? { buttons: kb.map((b) => ({ label: b.text, data: b.callback_data })) } : {}),
          ...(c.method === 'sendPhoto' ? { file: (c.body.photo as { file?: string } | undefined)?.file } : {}),
        };
      });
    const reqIds = [...new Set(logs.slice(logFrom).map((l) => l.match(/^\[req ([0-9a-f]{6})\]/)?.[1]).filter(Boolean))] as string[];
    const rows = (await hub.usage.rows(t0)).map((r) => ({ requestId: r.requestId, kind: r.kind, model: r.model, status: r.status, input: r.inputTokens, cached: r.cachedTokens, output: r.outputTokens, tools: r.toolsCalled }));
    return { requestIds: reqIds, messages, llmCalls: rows, geminiCallsToday: budget.used(), log: logs.slice(logFrom) };
  };

  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => undefined);
    return p;
  };
  const run = (body: Rec, act: () => string | undefined) =>
    serial(async () => {
      allowWrites = body.allowWrites === true;
      const from = sink.calls.length;
      const logFrom = logs.length;
      const t0 = Date.now();
      try {
        const err = act();
        if (err) return { status: 400, body: { error: err } };
        await settle(t0);
        return { status: 200, body: { allowWrites, ...(await transcript(from, logFrom, t0)) } };
      } finally {
        allowWrites = false;
      }
    });

  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body, null, 1));
  };
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    const hostHeader = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!LOOPBACK.has(hostHeader)) return reply(res, 403, { error: 'loopback only' });
    if (req.headers['x-debug-token'] !== token) return reply(res, 401, { error: 'missing or wrong x-debug-token' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/debug/health') return reply(res, 200, { ok: true, apps: hub.toolbox.status(), geminiCallsToday: budget.used() });
    if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: Rec;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Rec;
    } catch {
      return reply(res, 400, { error: 'invalid JSON' });
    }
    const readFile = (p: unknown) => (typeof p === 'string' && existsSync(p) ? readFileSync(p) : undefined);
    const mimeOf = (p: string) => (/\.(png)$/i.test(p) ? 'image/png' : /\.(jpe?g)$/i.test(p) ? 'image/jpeg' : /\.wav$/i.test(p) ? 'audio/wav' : /\.mp3$/i.test(p) ? 'audio/mpeg' : 'audio/ogg');
    if (url.pathname === '/debug/chat') {
      const r = await run(body, () => {
        if (body.voice) {
          const b = readFile(body.voice);
          if (!b) return `voice file not found: ${String(body.voice)}`;
          sink.voice(b, mimeOf(String(body.voice)));
        } else if (body.image) {
          const b = readFile(body.image);
          if (!b) return `image file not found: ${String(body.image)}`;
          sink.photo(b, mimeOf(String(body.image)), typeof body.caption === 'string' ? body.caption : typeof body.text === 'string' ? body.text : undefined);
        } else if (typeof body.text === 'string' && body.text.trim()) sink.text(body.text);
        else return 'pass text, voice or image';
        return undefined;
      });
      return reply(res, r.status, r.body);
    }
    if (url.pathname === '/debug/press') {
      const r = await run(body, () => (typeof body.button === 'string' && sink.press(body.button) ? undefined : `no button matching ${JSON.stringify(body.button)}`));
      return reply(res, r.status, r.body);
    }
    return reply(res, 404, { error: 'unknown endpoint' });
  });
  const port = o.port ?? Number(env.DEBUG_PORT ?? 4112);
  await new Promise<void>((r, j) => (server.once('error', j), server.listen(port, host, () => r())));
  const url = `http://${host}:${(server.address() as AddressInfo).port}`;
  return {
    url,
    token,
    tokenFile,
    hub,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await hub.stop();
      await sink.stop();
    },
  };
}

// `npm run debug-server`
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  startDebugServer()
    .then((s) => console.warn(`[debug] listening on ${s.url} (token in ${s.tokenFile}; data in ${dirname(s.tokenFile)})`))
    .catch((e: Error) => {
      console.error(`[debug] ${e.message}`);
      process.exit(1);
    });
}
