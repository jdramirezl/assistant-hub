import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { classifyIntent, domainsFor } from '../src/telemetry/intent.js';
import { requiresApproval } from '../src/approvals.js';
import { assertLoopbackImageUrl, fetchLoopbackPng, ImageRefused } from '../src/cines/images.js';
import { holdOf, purchaseArgs, secureRequestOf } from '../src/cines/contract.js';
import { createHub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel, lastToolResult, type Turn } from './support/scripted-model.js';
import { callbackUpdate, findButton, MockTelegram, textUpdate } from './support/mock-telegram.js';
import { CINES_PHASE3_TOOLS, CINES_REGISTRY, CINES_TOOLS, startFakeCines, tinyPng, type FakeCines, type FakeCinesOptions } from './support/fake-cines.js';
import { MFP_REGISTRY, startFakeMason } from './support/fake-mason.js';

const ME = 42;
const FAST = { timeout: 0, retryDelayMs: 50 };

describe('cines topic router', () => {
  it.each([
    ['¿qué hay en el Toreo hoy?'],
    ['¿dónde pasan Dune?'],
    ['quiero ver Dune hoy en la noche'],
    ['¿qué películas hay en cartelera?'],
    ['horarios de Coco 2 en Satélite'],
    ['muéstrame los asientos'],
    ['F7,F8'],
    ['compra F7 para la de las 20:30'],
    ['f7 y f8'],
    ['compra 2 boletos para la de las 20:30'],
    ['¿hay preventa de Avatar?'],
  ])('%s → cines only', (text) => {
    expect(domainsFor(text)).toEqual(['cines']);
    expect(classifyIntent(text)).toBe('cines');
  });
  it('other topics do not load cines tools; a cinema expense is finance (+ cines)', () => {
    expect(domainsFor('comí 2 huevos')).toEqual(['fitness']);
    expect(domainsFor('gasté 25k en almuerzo con Nequi')).toEqual(['finance']);
    expect(domainsFor('hola Alfred')).toEqual(['fitness', 'finance']);
    expect(domainsFor('gasté 300 pesos en el cine con Nequi')).toEqual(['cines', 'finance']);
  });
  it('an unclear follow-up keeps cines when the last request was about it', () => {
    expect(domainsFor('la de las 20:30', 'text', ['cines'])).toEqual(['fitness', 'finance', 'cines']);
    expect(domainsFor('sí', 'text', ['fitness'])).toEqual(['fitness', 'finance']);
    expect(domainsFor('comí arroz', 'text', ['cines'])).toEqual(['fitness']); // a clear topic wins
  });
});

describe('cines contract and guards (unit)', () => {
  it('tool fixtures are the real definitions', () => {
    expect(CINES_TOOLS.map((t) => t.name)).toEqual(['cines_list_cinemas', 'cines_listings', 'cines_find_movie', 'cines_showtimes', 'cines_best_showtime', 'cines_upcoming', 'cines_seat_map', 'cines_validate_seats']);
    expect(CINES_PHASE3_TOOLS.map((t) => t.name).sort()).toEqual(['cines_hold_seats', 'cines_hold_status', 'cines_purchase', 'cines_release_hold', 'cines_submit_code']);
    const purchase = CINES_PHASE3_TOOLS.find((t) => t.name === 'cines_purchase') as unknown as { inputSchema: { properties: Record<string, unknown>; required: string[] } };
    expect(Object.keys(purchase.inputSchema.properties)).not.toContain('cvv'); // no secrets as arguments
    expect(purchase.inputSchema.required).toEqual(['holdId', 'expectedTotal']);
  });
  it('hold and purchase are gated; release is never gated', () => {
    expect(requiresApproval('cines_hold_seats', undefined)).toBe(true);
    expect(requiresApproval('cines_purchase', { destructiveHint: false })).toBe(true);
    expect(requiresApproval('cines_release_hold', { destructiveHint: true })).toBe(false);
    expect(requiresApproval('cines_seat_map', { readOnlyHint: true })).toBe(false);
  });
  it('the purchase total and userApproved come from the hub, not the model', () => {
    const hold = holdOf({ status: 'held', holdId: 'h1', total: 198, currency: 'MXN', seats: ['F7', 'F8'], cinema: 'Toreo', movie: 'Dune', startsAt: '2026-10-19T20:30:00-06:00', ticketType: 'Admision General' })!;
    expect(hold).toMatchObject({ holdId: 'h1', totalMxn: 198, when: '2026-10-19 20:30', cinema: 'Toreo', ticketType: 'Admision General' });
    expect(holdOf({ status: 'needs_email_code', challengeId: 'c' })).toBeUndefined();
    expect(purchaseArgs({ holdId: 'h1', expectedTotal: 1, userApproved: false, method: 'card' }, hold, true)).toEqual({ holdId: 'h1', expectedTotal: 198, userApproved: true, method: 'card' });
    expect(purchaseArgs({ holdId: 'h1' }, hold, true, { dryRun: true })).toMatchObject({ dryRun: true });
    for (const status of ['needs_cvv', 'needs_3ds', 'needs_email_code']) {
      expect(secureRequestOf({ status, secure: true, challengeId: 'sec_1', kind: 'cvv', expiresAt: 'x' })).toMatchObject({ requestId: 'sec_1', kind: 'cvv' });
    }
    expect(secureRequestOf({ status: 'held' })).toBeUndefined();
    expect(secureRequestOf({ status: 'in_progress', jobId: 'j' })).toBeUndefined();
  });
  it('images: loopback http(s) only, PNG only', async () => {
    expect(() => assertLoopbackImageUrl('https://evil.example/x.png')).toThrow(ImageRefused);
    expect(() => assertLoopbackImageUrl('http://192.168.1.2/x.png')).toThrow(/loopback/);
    expect(() => assertLoopbackImageUrl('file:///etc/passwd')).toThrow(/protocol/);
    expect(assertLoopbackImageUrl('http://127.0.0.1:8686/images/a.png').port).toBe('8686');
    const png = tinyPng();
    const f = (type: string, body: Uint8Array) => (async () => new Response(body, { headers: { 'content-type': type } })) as unknown as typeof fetch;
    expect((await fetchLoopbackPng('http://127.0.0.1/a.png', { fetch: f('image/png', png) })).byteLength).toBe(png.length);
    await expect(fetchLoopbackPng('http://127.0.0.1/a.png', { fetch: f('text/html', png) })).rejects.toThrow(/content-type/);
    await expect(fetchLoopbackPng('http://127.0.0.1/a.png', { fetch: f('image/png', new Uint8Array([1, 2, 3])) })).rejects.toThrow(/not a PNG/);
  });
});

describe('CinesHub secure input (unit)', () => {
  const kvMem = () => {
    const m = new Map<string, { v: unknown; exp: number | null }>();
    let t = 0;
    const kv = {
      now: () => t,
      advance: (ms: number) => void (t += ms),
      get: async (k: string) => { const e = m.get(k); return e && (e.exp === null || e.exp > t) ? e.v : null; },
      set: async (k: string, v: unknown, ttl?: number) => void m.set(k, { v, exp: ttl ? t + ttl : null }),
      setIfNotExists: async (k: string, v: unknown, ttl?: number) => (m.has(k) ? false : (m.set(k, { v, exp: ttl ? t + ttl : null }), true)),
      incr: async (k: string, by: number) => { const n = Number((m.get(k)?.v as number) ?? 0) + by; m.set(k, { v: n, exp: null }); return n; },
      delete: async (k: string) => void m.delete(k),
    };
    return kv;
  };
  it('one pending request per chat, expiring after 5 min', async () => {
    const { CinesHub } = await import('../src/cines/service.js');
    const kv = kvMem();
    const sent: string[] = [];
    const hub = new CinesHub({ kv: kv as never, toolbox: { execute: async () => ({}) }, now: kv.now, securePrompt: (k) => `🔒 ${k}`, secureBadFormat: () => 'bad', secureExpired: () => 'expired', sendText: async (_c, t) => void sent.push(t) });
    const a = await hub.afterResult('cines_purchase', {}, { status: 'needs_cvv', challengeId: 'r1', kind: 'cvv', secure: true }, { chatId: '42' });
    expect(a).toMatchObject({ status: 'waiting_for_secure_input', kind: 'cvv' });
    const b = await hub.afterResult('cines_purchase', {}, { status: 'needs_3ds', challengeId: 'r2', kind: 'otp_3ds', secure: true }, { chatId: '42' });
    expect(b).toMatchObject({ status: 'secure_input_busy' });
    expect(sent).toEqual(['🔒 cvv']);
    expect(await hub.pending('42')).toMatchObject({ requestId: 'r1' });
    kv.advance(5 * 60_000 + 1);
    expect(await hub.pending('42')).toMatchObject({ expired: true }); // a late reply is still swallowed
    expect(hub.looksLikeSecret('cvv', ' 123 ')).toBe(true);
    expect(hub.looksLikeSecret('cvv', 'qué pasó')).toBe(false);
    kv.advance(10 * 60_000);
    expect(await hub.pending('42')).toBeUndefined();
    // no chat (Studio): nothing is opened
    expect(await hub.afterResult('cines_purchase', {}, { status: 'needs_cvv', challengeId: 'r3', kind: 'cvv' }, {})).toMatchObject({ status: 'secure_input_unavailable' });
  });
});

describe('cines through Telegram (fake cines-mx-mcp)', () => {
  let tg: MockTelegram;
  let cines: FakeCines;
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function boot(script: Turn[], opts: FakeCinesOptions = {}, extra: { dataDir?: string; withMason?: boolean } = {}) {
    tg = await new MockTelegram().start();
    cleanups.push(() => tg.stop());
    cines = await startFakeCines(opts);
    cleanups.push(cines.close);
    const servers: Record<string, unknown> = { ...CINES_REGISTRY(cines.url).servers };
    if (extra.withMason) {
      const mason = await startFakeMason();
      cleanups.push(mason.close);
      Object.assign(servers, MFP_REGISTRY(mason.url).servers);
    }
    const sm = scriptedModel(script);
    const logs: string[] = [];
    const cfg = testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME), ...(extra.dataDir ? { HUB_DATA_DIR: extra.dataDir } : {}) });
    const hub = createHub(cfg, { model: sm.model as never, registry: { servers }, telegram: { apiBaseUrl: tg.url, longPolling: FAST, log: (m) => logs.push(m) } });
    cleanups.push(() => hub.stop());
    await hub.start();
    return { sm, hub, logs, cfg };
  }
  const press = async (needle: string) => {
    await tg.waitFor(() => !!findButton(tg, needle), 10_000);
    const b = findButton(tg, needle)!;
    tg.push(callbackUpdate(ME, { message_id: b.messageId }, b.data));
    return b;
  };

  it('"¿qué hay en el Toreo hoy?" loads only cines tools and calls cines_listings', async () => {
    const { sm } = await boot([{ tool: 'cines_listings', args: { cinema: 'Toreo', date: 'hoy' } }, (p) => ({ text: `cartelera: ${lastToolResult(p).slice(0, 300)}` })], {}, { withMason: true });
    tg.push(textUpdate(ME, '¿qué hay en el Toreo hoy?'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('cartelera'));
    const tools = sm.calls[0]!.tools;
    expect(tools.filter((t) => !t.startsWith('cines_')).sort()).toEqual(['propose_plan', 'updateWorkingMemory']);
    expect(tools).toEqual(expect.arrayContaining(['cines_listings', 'cines_best_showtime', 'cines_seat_map']));
    expect(cines.calls.map((c) => c.tool)).toEqual(['cines_listings']);
    expect(tg.outgoingText(ME)).toContain('Dune');
    expect(sm.calls[0]!.prompt.find((m) => (m as { role: string }).role === 'system')).toBeDefined();
    expect(JSON.stringify(sm.calls[0]!.prompt)).toContain('## Cines');
  });

  it('errors keep the shared shape with the cines code', async () => {
    const { hub } = await boot([]);
    expect(await hub.toolbox.execute('cines_listings', { cinema: 'Narnia' })).toEqual({
      error: { code: 'CINES_NOT_FOUND', message: expect.stringContaining('Narnia'), retryable: false },
      user_message: 'no encontré esa película, cine o función. Revise el nombre o elija otra función.',
      note: expect.stringMatching(/Do not guess another reason/),
    });
  });

  it('a seat map is sent as a photo; the model sees neither the image nor its URL', async () => {
    const { sm } = await boot([{ tool: 'cines_seat_map', args: { showtimeId: '570-1002', tickets: 2 } }, { text: 'Le propongo F7 y F8.' }]);
    tg.push(textUpdate(ME, 'muéstrame los asientos de la de las 20:30, somos 2'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('F7 y F8'));
    const photo = tg.sent('sendPhoto');
    expect(photo).toHaveLength(1);
    expect(String(photo[0]!.body.chat_id)).toBe(String(ME));
    const bytes = (photo[0]!.body.photo as { bytes: Buffer }).bytes;
    expect(bytes.subarray(0, 4).toString('hex')).toBe('89504e47');
    // the photo went out before the text reply
    const iPhoto = tg.calls.indexOf(photo[0]!);
    const iText = tg.calls.findIndex((c) => /sendMessage|sendRichMessage|editMessageText/.test(c.method) && JSON.stringify(c.body).includes('F7 y F8'));
    expect(iText).toBeGreaterThan(0);
    expect(iPhoto).toBeLessThan(iText);
    const prompt = JSON.stringify(sm.calls[1]!.prompt);
    expect(prompt).not.toContain('/images/');
    expect(prompt).not.toContain(bytes.toString('base64').slice(0, 20));
    expect(prompt).toMatch(/sent to the user/);
    expect(cines.imagesServed).toBe(1);
  });

  it('the hub-only secure tool is never offered to the model', async () => {
    const { sm } = await boot([{ text: 'ok' }], { phase3: true });
    tg.push(textUpdate(ME, '¿qué hay en cartelera?'));
    await tg.waitFor(() => sm.calls.length === 1);
    expect(sm.calls[0]!.tools).toEqual(expect.arrayContaining(['cines_hold_seats', 'cines_purchase', 'cines_release_hold']));
    expect(sm.calls[0]!.tools).not.toContain('cines_submit_code');
  });

  /** hold → ✅ card → purchase → ✅ summary card → secure CVV → secure OTP → paid */
  async function buyFlow(opts: FakeCinesOptions & { approvePurchase?: boolean } = {}, dataDir?: string) {
    const script: Turn[] = [
      { tool: 'cines_hold_seats', args: { showtimeId: '570-1002', seats: 'F7,F8' } },
      (p) => {
        const o = JSON.parse(lastToolResult(p));
        const v = o.value ?? o;
        return v.holdId ? { tool: 'cines_purchase', args: { holdId: v.holdId, expectedTotal: 1, userApproved: false } } : { text: `hold: ${JSON.stringify(v)}` };
      },
      (p) => ({ text: `resultado: ${lastToolResult(p)}` }),
      (p) => ({ text: `resultado: ${lastToolResult(p)}` }),
      (p) => ({ text: `resultado: ${lastToolResult(p)}` }),
    ];
    const ctx = await boot(script, { phase3: true, ...opts }, { dataDir });
    tg.push(textUpdate(ME, 'compra F7 y F8 para la de las 20:30'));
    await press('tool_approve:'); // hold card
    return ctx;
  }

  it('full purchase: summary card, CVV and OTP via secure input; secrets never reach the model, DB or logs', async () => {
    const CVV = '7391';
    const OTP = 'Q8Z4K2';
    const { sm, logs, cfg, hub } = await buyFlow({ purchaseInputs: ['cvv', 'otp_3ds'] });
    // the purchase card is a summary, not tool args
    await tg.waitFor(() => /confirmo la compra/.test(tg.outgoingText(ME)), 10_000);
    const card = tg.outgoingText(ME);
    expect(card).toMatch(/Dune: Mesías/);
    expect(card).toMatch(/Parque Toreo/);
    expect(card).toMatch(/20:30/);
    expect(card).toMatch(/F7, F8/);
    expect(card).toMatch(/\$198 MXN/);
    await press('cines:b:');
    // the server got the hub's total and userApproved, not the model's
    await tg.waitFor(() => /CVV/.test(tg.outgoingText(ME)), 10_000);
    expect(cines.calls.find((c) => c.tool === 'cines_purchase')!.args).toMatchObject({ expectedTotal: 198, userApproved: true });
    expect(tg.outgoingText(ME)).toMatch(/🔒 Envíe el CVV de su tarjeta, Amo Julián\. No lo verá el modelo/);
    const cvvMsg = textUpdate(ME, CVV);
    tg.push(cvvMsg);
    await tg.waitFor(() => /🔒 Envíe el código que le envió su banco/.test(tg.outgoingText(ME)), 10_000);
    const otpMsg = textUpdate(ME, OTP);
    tg.push(otpMsg);
    // the agent resumes with the redacted result (as a hub note, not the user's message)
    await tg.waitFor(() => sm.calls.some((c) => /sent the otp_3ds privately[\s\S]*BK001/.test(JSON.stringify(c.prompt))), 10_000);
    expect(cines.secrets).toEqual([CVV, OTP]);
    expect(cines.actions.map((a) => a.op)).toEqual(['hold', 'purchase']);
    // both secret messages were deleted from the chat
    const deleted = tg.sent('deleteMessage').map((c) => Number(c.body.message_id));
    expect(deleted).toEqual(expect.arrayContaining([cvvMsg.message.message_id, otpMsg.message.message_id]));
    // nowhere: model prompts, logs, any file in the data dir (memory, llm_calls, kv, …)
    const everything = [JSON.stringify(sm.calls.map((c) => c.prompt)), logs.join('\n')];
    expect(readdirSync(cfg.dataDir).some((f) => f.endsWith('.db'))).toBe(true);
    for (const f of readdirSync(cfg.dataDir)) everything.push(readFileSync(join(cfg.dataDir, f)).toString('latin1'));
    for (const blob of everything) {
      expect(blob).not.toContain(CVV);
      expect(blob).not.toContain(OTP);
    }
    expect(await hub.cines.successes()).toBe(1);
  }, 30_000);

  it('a bad format asks again without the model; "cancelar" stops; a pending request expires', async () => {
    const { sm, hub } = await buyFlow({ purchaseInputs: ['cvv'] });
    await press('cines:b:');
    await tg.waitFor(() => /CVV/.test(tg.outgoingText(ME)), 10_000);
    const calls = sm.calls.length;
    tg.push(textUpdate(ME, '12'));
    await tg.waitFor(() => /no parece correcto/.test(tg.outgoingText(ME)));
    expect(sm.calls.length).toBe(calls); // no model call
    expect(await hub.cines.pending(String(ME))).toBeDefined();
    tg.push(textUpdate(ME, 'cancelar'));
    await tg.waitFor(() => sm.calls.length === calls + 1);
    expect(JSON.stringify(sm.calls.at(-1)!.prompt)).toMatch(/cancelled the private code request/);
    expect(await hub.cines.pending(String(ME))).toBeUndefined();
    expect(cines.secrets).toEqual([]);
  }, 30_000);

  it('over $1,000 MXN is refused by the hub before the server is called', async () => {
    const { hub } = await boot([], { phase3: true });
    // a hold the hub saw with a total over the cap (the real server also refuses such holds)
    await hub.cines.afterResult('cines_hold_seats', {}, { status: 'held', holdId: 'big', total: 1210, currency: 'MXN', seats: ['A1'] });
    expect(await hub.cines.purchaseNeedsApproval({ holdId: 'big' })).toBe(true);
    expect(await hub.toolbox.execute('cines_purchase', { holdId: 'big', expectedTotal: 1210, userApproved: true })).toMatchObject({ error: { code: 'CINES_LIMIT_EXCEEDED' } });
    expect(await hub.toolbox.execute('cines_purchase', { holdId: 'unknown', expectedTotal: 10 })).toMatchObject({ error: { code: 'CINES_BAD_REQUEST' } });
    expect(cines.calls.map((c) => c.tool)).not.toContain('cines_purchase');
  });

  it('❌ on the purchase card releases the hold', async () => {
    await buyFlow();
    await tg.waitFor(() => /confirmo la compra/.test(tg.outgoingText(ME)), 10_000);
    await press('cines:r:');
    await tg.waitFor(() => cines.actions.some((a) => a.op === 'release'), 10_000);
    expect(cines.actions.map((a) => a.op)).toEqual(['hold', 'release']);
  }, 30_000);

  it('a bad format is checked by the hub (the server is not called); a late reply after expiry is swallowed', async () => {
    const { sm, hub } = await buyFlow({ purchaseInputs: ['cvv'] });
    await press('cines:b:');
    await tg.waitFor(() => /CVV/.test(tg.outgoingText(ME)), 10_000);
    tg.push(textUpdate(ME, '12ab'));
    await tg.waitFor(() => /no parece correcto/.test(tg.outgoingText(ME)));
    expect(cines.calls.map((c) => c.tool)).not.toContain('cines_submit_code');
    // expire it, then the user sends the CVV late: deleted, not forwarded, not shown to the model
    const p = (await hub.cines.pending(String(ME)))!;
    await hub.kv.set(`cines:secure:${ME}`, { ...p, expiresAt: Date.now() - 1 }, 60_000);
    const late = textUpdate(ME, '4821');
    tg.push(late);
    await tg.waitFor(() => /expiró/.test(tg.outgoingText(ME)));
    expect(tg.sent('deleteMessage').map((c) => Number(c.body.message_id))).toContain(late.message.message_id);
    expect(cines.calls.map((c) => c.tool)).not.toContain('cines_submit_code');
    expect(JSON.stringify(sm.calls.map((c) => c.prompt))).not.toMatch(/(?<!\d)4821(?!\d)/); // (timestamps may contain the digits)
  }, 30_000);

  it('a failed payment is never retried, even if the model calls it again or Comprar is tapped twice', async () => {
    const script: Turn[] = [
      { tool: 'cines_hold_seats', args: { showtimeId: '570-1002', seats: 'F7' } },
      { tool: 'cines_purchase', args: { holdId: 'hold_1', expectedTotal: 99 } }, // refused: the card handles it
      { text: 'Le dejé la compra lista.' },
    ];
    await boot(script, { phase3: true, paymentFails: true });
    tg.push(textUpdate(ME, 'compra F7 para la de las 20:30'));
    await press('tool_approve:call-0');
    const b = await press('cines:b:');
    await tg.waitFor(() => /❌ El pago no se completó/.test(tg.outgoingText(ME)), 10_000);
    tg.push(callbackUpdate(ME, { message_id: b.messageId }, b.data)); // second tap
    await new Promise((r) => setTimeout(r, 800));
    expect(cines.calls.filter((c) => c.tool === 'cines_purchase')).toHaveLength(1);
  }, 30_000);

  it('after 3 successful purchases (persisted across restarts) the hold approval covers the purchase', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dataDir = mkdtempSync(join(tmpdir(), 'hub-cines-'));
    const first = await boot([], { phase3: true }, { dataDir });
    await first.hub.cines.afterResult('cines_purchase', {}, { status: 'paid', purchaseId: 'p1', bookingNumber: 'X1', total: 99 });
    await first.hub.cines.afterResult('cines_purchase', {}, { status: 'paid', purchaseId: 'p2', bookingNumber: 'X2', total: 99 });
    await first.hub.cines.afterResult('cines_purchase', {}, { status: 'paid', dryRun: true, bookingNumber: 'D' }); // dry runs do not count
    await first.hub.cines.afterResult('cines_purchase', {}, { status: 'paid', purchaseId: 'p3', bookingNumber: 'X3', total: 99 });
    expect(await first.hub.cines.successes()).toBe(3);
    for (const c of cleanups.splice(0).reverse()) await c();

    await buyFlow({ successes: 3 }, dataDir); // restart on the same data dir; hold card pressed
    await tg.waitFor(() => /BK001/.test(tg.outgoingText(ME)), 10_000); // paid without a purchase card
    expect(tg.outgoingText(ME)).not.toMatch(/confirmo la compra/);
    expect(cines.actions.map((a) => a.op)).toEqual(['hold', 'purchase']);
  }, 30_000);

  it('the server\'s own first-3 rule wins: hub at 3, server below 3 → the card is still shown', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dataDir = mkdtempSync(join(tmpdir(), 'hub-cines-'));
    const first = await boot([], { phase3: true }, { dataDir });
    for (const id of ['a', 'b', 'c']) await first.hub.cines.afterResult('cines_purchase', {}, { status: 'paid', purchaseId: id, total: 1 });
    for (const c of cleanups.splice(0).reverse()) await c();
    await buyFlow({ successes: 1 }, dataDir);
    await tg.waitFor(() => /confirmo la compra/.test(tg.outgoingText(ME)), 10_000);
  }, 30_000);

  it('CINES_PURCHASE_DRY_RUN=1 sends every purchase as dryRun and does not count it', async () => {
    tg = await new MockTelegram().start();
    cleanups.push(() => tg.stop());
    cines = await startFakeCines({ phase3: true, realPaymentDisabled: true });
    cleanups.push(cines.close);
    const sm = scriptedModel([
      { tool: 'cines_hold_seats', args: { showtimeId: '570-1002', seats: ['F7'] } },
      { tool: 'cines_purchase', args: { holdId: 'hold_1', expectedTotal: 99 } },
      (p) => ({ text: `resultado: ${lastToolResult(p)}` }),
    ]);
    const hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME), CINES_PURCHASE_DRY_RUN: '1' }), { model: sm.model as never, registry: CINES_REGISTRY(cines.url), telegram: { apiBaseUrl: tg.url, longPolling: FAST, log: () => {} } });
    cleanups.push(() => hub.stop());
    await hub.start();
    tg.push(textUpdate(ME, 'compra F7 para la de las 20:30'));
    await press('tool_approve:call-0');
    await press('cines:b:');
    await tg.waitFor(() => /DRYRUN-001/.test(tg.outgoingText(ME)), 10_000);
    expect(cines.calls.find((c) => c.tool === 'cines_purchase')!.args).toMatchObject({ dryRun: true, expectedTotal: 99, userApproved: true });
    expect(await hub.cines.successes()).toBe(0);
  }, 30_000);

  it('money tools cannot be put in a batch plan; release is ungated', async () => {
    const { hub } = await boot([], { phase3: true });
    const r = (await hub.plans.propose(
      { title: 'x', groups: [{ title: 'g', actions: [{ tool: 'cines_purchase', args: { holdId: 'h' }, summary: 'pay' }] }] } as never,
      { owner: `telegram:${ME}` } as never,
    ).catch((e: Error) => ({ error: e.message }))) as unknown;
    expect(JSON.stringify(r)).toMatch(/cannot be part of a plan/);
    expect(hub.toolbox.isGated('cines_release_hold')).toBe(false);
  });
});
