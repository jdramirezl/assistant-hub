/** The unified status layer: one live message per request, translated errors, /estado. */
import { afterEach, describe, expect, it } from 'vitest';
import { ERROR_TABLE, explain } from '../src/status/errors.js';
import { StatusMessages, toHtml } from '../src/status/messages.js';
import { summarizeOutcome, type ToolOutcome } from '../src/status/outcome.js';
import { StatusTracker } from '../src/status/tracker.js';
import { createRateLimitedFetch, rateLimitContext } from '../src/llm/rate-limit.js';
import { Pacer } from '../src/llm/pacer.js';
import { failedWritesThisTurn, withFalseSaveGuard } from '../src/guards/false-save.js';
import { withUsageScope } from '../src/telemetry/context.js';
import { createHub, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel, type Turn } from './support/scripted-model.js';
import { MockTelegram, callbackUpdate, findButton, textUpdate, voiceUpdate } from './support/mock-telegram.js';
import { MFP_REGISTRY, startFakeMason } from './support/fake-mason.js';
import { startFakeFinance } from './support/fake-finance.js';

const ME = 42;
const persona = { persona: 'alfred', language: 'es', ownerName: 'Julián' } as const;
const msgs = new StatusMessages(persona as never);
const isWrite = (t: string) => t === 'log_meal' || /create|delete|update|log_food|hold|purchase/.test(t);
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

describe('error translation table', () => {
  it('every code has a sentence and an action in both languages, never a bare "falló"', () => {
    for (const code of Object.keys(ERROR_TABLE)) {
      for (const lang of ['es', 'en'] as const) {
        const e = explain(code, '', lang, 'Finanzas');
        expect(e.cause.length, `${code} ${lang}`).toBeGreaterThan(8);
        expect(e.action.length, `${code} ${lang}`).toBeGreaterThan(8);
        expect(e.cause).not.toMatch(/^fall[óo]$/i);
        expect(e.cause).not.toContain('{app}');
      }
    }
  });
  it('covers the codes the apps and the hub emit', () => {
    const codes = ['VALIDATION_ERROR', 'NOT_FOUND', 'UNAUTHORIZED', 'MCP_UNAVAILABLE', 'SESSION_LOST', 'TOOL_ERROR', 'TOOL_UNAVAILABLE', 'BUDGET', 'GEMINI_DAILY_QUOTA', 'GEMINI_RATE_LIMIT', 'TRANSCRIPTION_FAILED'];
    const mfp = ['MFP_UNAVAILABLE', 'MFP_SESSION_EXPIRED', 'MFP_BLOCKED', 'MFP_BAD_REQUEST', 'MFP_ERROR'];
    const cines = ['CINES_UNAVAILABLE', 'CINES_BLOCKED', 'CINES_SCHEMA_CHANGED', 'CINES_NOT_FOUND', 'CINES_BAD_REQUEST', 'CINES_SESSION_EXPIRED', 'CINES_HOLD_EXPIRED', 'CINES_PAYMENT_FAILED', 'CINES_LIMIT_EXCEEDED'];
    for (const c of [...codes, ...mfp, ...cines]) expect(ERROR_TABLE[c], c).toBeDefined();
  });
  it('validation errors name the missing field; unknown codes still show the code', () => {
    expect(explain('VALIDATION_ERROR', "must have required property 'accountId'")).toMatchObject({ cause: 'falta la cuenta', action: '¿Con cuál la pagó?' });
    expect(explain('VALIDATION_ERROR', 'amount must be positive', 'en').cause).toBe('the amount is missing');
    expect(explain('WEIRD_THING', '', 'es', 'Finanzas').cause).toMatch(/Finanzas devolvió un error \(WEIRD_THING\)/);
  });
});

describe('ambiguous-match candidates', () => {
  it('extracts "Name (Meal)" items, names with commas included', async () => {
    const { candidatesOf } = await import('../src/status/errors.js');
    expect(candidatesOf(`Error executing tool fitness_delete_food: 'egg' matches multiple diary entries: Egg, whole, large (Breakfast), Egg white (Lunch); narrow the query`)).toEqual(['Egg, whole, large (Breakfast)', 'Egg white (Lunch)']);
    expect(candidatesOf('matches more than one entry: banana, apple')).toEqual(['banana', 'apple']);
    expect(candidatesOf('no candidates here')).toEqual([]);
  });
});

describe('own validation is quoted verbatim', () => {
  it('CINES_BAD_REQUEST uses the server message, not "Cinépolis no aceptó"', () => {
    expect(explain('CINES_BAD_REQUEST', 'E4 dejaría un asiento libre aislado.').cause).toBe('E4 dejaría un asiento libre aislado');
  });
});

describe('outcome from tool results', () => {
  const mov = (amount: number, notes: string, result: unknown): ToolOutcome => ({ tool: 'finance_create_movement', args: { amount, notes, type: 'EgresoNormal' }, result });
  it('a partial expense batch: "Guardé 2 de 3 gastos. Falló: camisa $262 — falta la cuenta"', () => {
    const o = summarizeOutcome([mov(18000, 'almuerzo', { id: 'm1' }), mov(5000, 'café', { id: 'm2' }), mov(262, 'camisa', { error: { code: 'VALIDATION_ERROR', message: 'accountId is required', retryable: false } })], isWrite);
    const t = msgs.outcome(o, '7f3a2c')!;
    expect(t.text).toBe('⚠️ Guardé 2 de 3 gastos. Falló: camisa $262 — falta la cuenta. ¿Con cuál la pagó?');
    expect(toHtml(t)).toContain('<code>VALIDATION_ERROR · req 7f3a2c</code>');
  });
  it('a later success of ANOTHER item does not hide a failure', () => {
    const bad = { error: { code: 'VALIDATION_ERROR', message: 'insufficient balance', retryable: false } };
    const o = summarizeOutcome([mov(18000, 'almuerzo', { id: 'm1' }), mov(262, 'camisa', bad), mov(5000, 'café', { id: 'm2' })], isWrite);
    expect(o.kind).toBe('partial');
  });
  it('the model retrying the same failing item counts once', () => {
    const bad = { error: { code: 'VALIDATION_ERROR', message: 'insufficient balance in this pocket', retryable: false } };
    const o = summarizeOutcome([mov(18000, 'almuerzo', { id: 'm1' }), mov(262, 'camisa', bad), mov(262, 'camisa', bad), mov(262, 'camisa', bad)], isWrite);
    expect(msgs.outcome(o)!.text).toBe('⚠️ Guardé 1 de 2 gastos. Falló: camisa $262 — no hay saldo suficiente en ese bolsillo. ¿Lo cargo a otra cuenta o bolsillo?');
  });
  it('a validation error the model fixed is not a failure', () => {
    const o = summarizeOutcome([mov(262, 'camisa', { error: true, message: "must have required property 'accountId'" }), mov(262, 'camisa', { id: 'm3' })], isWrite);
    expect(msgs.outcome(o)!.text).toBe('✅ 1 gasto, $262');
  });
  it('a meal: "✅ Desayuno: 3 alimentos, 420 kcal", ambiguous items as ❓', () => {
    const r = { logged: [{ meal: 'breakfast', kcal: 144 }, { meal: 'breakfast', kcal: 200 }, { meal: 'breakfast', kcal: 76 }], ambiguous: [{ query: 'sandwich' }] };
    expect(msgs.outcome(summarizeOutcome([{ tool: 'log_meal', args: {}, result: r }], isWrite))!.text).toBe('✅ Desayuno: 3 alimentos, 420 kcal · ❓ 1 alimento por confirmar');
  });
  it('nothing saved → ❌ with the cause and the action; reads alone report nothing', () => {
    const o = summarizeOutcome([{ tool: 'fitness_log_food', args: { query: 'egg' }, result: { error: { code: 'MFP_SESSION_EXPIRED', message: 'x', retryable: false } } }], isWrite);
    expect(msgs.outcome(o, 'ab12cd')!).toEqual({ text: '❌ No guardé el alimento: egg — la sesión de MyFitnessPal expiró. Hay que correr `mfp-mcp auth` en el Mac servidor.', tech: 'MFP_SESSION_EXPIRED · req ab12cd' });
    expect(msgs.outcome(summarizeOutcome([{ tool: 'fitness_get_day', args: {}, result: { diary: [] } }], isWrite))).toBeUndefined();
  });
  it('a delete that matches nothing is a ❓ with what is logged; a failed delete says "No borré"', () => {
    const nf = { error: { code: 'MFP_NOT_FOUND', message: "No entry matching 'café'. Logged: Coffee with milk (Breakfast), Egg, whole, large (Breakfast)", retryable: false } };
    expect(msgs.outcome(summarizeOutcome([{ tool: 'fitness_delete_food', args: { query: 'café' }, result: nf }], isWrite))!.text).toBe('❓ No encontré «café»; ¿cuál es? Coffee with milk (Breakfast) · Egg, whole, large (Breakfast)');
    const down = { error: { code: 'MFP_UNAVAILABLE', message: 'x', retryable: true } };
    expect(msgs.outcome(summarizeOutcome([{ tool: 'fitness_delete_food', args: { query: 'Egg' }, result: down }], isWrite))!.text).toMatch(/^❌ No borré el alimento: Egg — MyFitnessPal no responde/);
  });
  it('a purchase waiting for a secure code is not "done"; a payment secret adds no ❓ line (the 🔒 prompt is the message)', () => {
    const o = summarizeOutcome([{ tool: 'cines_purchase', args: { holdId: 'h' }, result: { status: 'waiting_for_secure_input', kind: 'cvv' } }], isWrite);
    expect(msgs.outcome(o)).toBeUndefined();
    const e = summarizeOutcome([{ tool: 'cines_hold_seats', args: {}, result: { status: 'waiting_for_secure_input', kind: 'email_code' } }], isWrite);
    expect(msgs.outcome(e)!.text).toBe('❓ 🔒 esperando su código');
  });
  it('a paid purchase with the hold summary is one self-contained line, sent as a NEW message', () => {
    const o = summarizeOutcome([{ tool: 'cines_purchase', args: {}, result: { status: 'paid', bookingNumber: '606808', total: 79, currency: 'MXN', summary: 'Street Fighter · Cinépolis Parque Toreo · mié 21 19:00 · B7' } }], isWrite);
    expect(msgs.outcome(o)).toEqual({ text: '✅ 🎟️ Compra confirmada: Street Fighter · Cinépolis Parque Toreo · mié 21 19:00 · B7 · $79 MXN · reserva 606808 (revise su correo)', fresh: true });
  });
});

describe('StatusTracker (one live message)', () => {
  function fakeApi() {
    const calls: { op: string; id?: number; html?: string }[] = [];
    let n = 100;
    return {
      calls,
      api: {
        send: async (_c: string, html: string) => (calls.push({ op: 'send', html }), ++n),
        edit: async (_c: string, id: number, html: string) => void calls.push({ op: 'edit', id, html }),
        remove: async (_c: string, id: number) => void calls.push({ op: 'remove', id }),
      },
    };
  }
  const tracker = (api: ReturnType<typeof fakeApi>['api'], o: Partial<ConstructorParameters<typeof StatusTracker>[0]> = {}) =>
    new StatusTracker({ api, chatId: '42', requestId: 'aa11bb', msgs, isWrite, minEditGapMs: 0, ...o });

  it('received → working → done, editing the SAME message', async () => {
    const f = fakeApi();
    const t = tracker(f.api);
    const tick = () => new Promise((r) => setTimeout(r, 5));
    await t.received('voice');
    t.transcribed('cené arroz con pollo');
    await tick();
    t.onToolEvent({ kind: 'running', toolCallId: 'c1', toolName: 'log_meal', displayName: 'log_meal', argsSummary: '', args: { items: [1, 2] } });
    await tick();
    t.onToolEvent({ kind: 'result', toolCallId: 'c1', toolName: 'log_meal', displayName: 'log_meal', argsSummary: '', args: {}, result: { logged: [{ meal: 'dinner', kcal: 205 }, { meal: 'dinner', kcal: 284 }] }, resultText: '', durationMs: 1, isError: false });
    await t.finish();
    expect(f.calls.filter((c) => c.op === 'send')).toHaveLength(1);
    expect(f.calls[0]!.html).toBe('📥 Nota recibida, Amo Julián. Transcribiendo…');
    expect(f.calls.some((c) => c.op === 'edit' && /⏳ Buscando 2 alimentos en MyFitnessPal…/.test(c.html!))).toBe(true);
    expect(f.calls.at(-1)).toEqual({ op: 'edit', id: 101, html: '✅ Cena: 2 alimentos, 489 kcal' });
  });

  it('a quick read request leaves no status message; a slow one is cleaned up', async () => {
    const f = fakeApi();
    await tracker(f.api).finish();
    expect(f.calls).toEqual([]);
    const g = fakeApi();
    const t = tracker(g.api, { workingAfterMs: 5 });
    t.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(g.calls[0]!.html).toBe('⏳ Trabajando en ello…');
    await t.finish();
    expect(g.calls.at(-1)).toEqual({ op: 'remove', id: 101 });
  });

  it('⏸️ only for a real 429; the hub\'s own pacing only shows ⏳', async () => {
    const f = fakeApi();
    const t = tracker(f.api);
    t.pacing();
    await new Promise((r) => setTimeout(r, 5));
    t.quota(30);
    await t.finish();
    const texts = f.calls.map((c) => c.html ?? '');
    expect(texts[0]).toMatch(/^⏳/);
    expect(texts).toContain('⏸️ Gemini me pidió esperar 30 s. Sigo en cuanto pueda.');
  });

  it('edits are throttled: bursts collapse to the latest text', async () => {
    const f = fakeApi();
    const t = tracker(f.api, { minEditGapMs: 200 });
    await t.received('photo');
    for (let i = 1; i <= 5; i++) t.onToolEvent({ kind: 'running', toolCallId: `c${i}`, toolName: 'finance_create_movement', displayName: '', argsSummary: '', args: {} });
    await new Promise((r) => setTimeout(r, 300));
    const edits = f.calls.filter((c) => c.op === 'edit');
    expect(edits.length).toBeLessThanOrEqual(2);
    expect(edits.at(-1)!.html).toBe('⏳ Registrando 5 movimientos en finanzas…');
    await t.finish();
  });
});

describe('pacer vs real 429 in the fetch layer', () => {
  it('a pacer wait calls onPacing (no ⏸️); a real 429 calls onQuota', async () => {
    let now = 0;
    const pacer = new Pacer({ now: () => now, sleep: async (ms) => void (now += ms), limits: { 'gemini-x': { rpm: 1, tpm: 1e9 } } });
    const quota: number[] = [];
    const paced: number[] = [];
    let status = 200;
    const f = createRateLimitedFetch({
      fetch: async () => (status === 429 ? ((status = 200), new Response(JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }] } }), { status: 429 })) : new Response('{}')),
      pacer,
      sleep: async () => {},
      log: () => {},
    });
    await rateLimitContext.run({ notify: async () => {}, onQuota: (s) => void quota.push(s), onPacing: (ms) => void paced.push(ms) }, async () => {
      await f('https://g/models/gemini-x:generateContent', { body: '{}' });
      await f('https://g/models/gemini-x:generateContent', { body: '{}' }); // waits 60 s for the pacer
    });
    expect(paced.length).toBe(1);
    expect(quota).toEqual([]);
    status = 429;
    now += 120_000;
    await rateLimitContext.run({ notify: async () => {}, onQuota: (s) => void quota.push(s), onPacing: (ms) => void paced.push(ms) }, () => f('https://g/models/gemini-x:generateContent', { body: '{}' }));
    expect(quota).toEqual([30]);
  });
});

describe('false-save guard: partial results', () => {
  const prompt = (results: { tool: string; value: unknown }[]) => [
    { role: 'user', content: [{ type: 'text', text: 'gasté 3 cosas' }] },
    { role: 'tool', content: results.map((r, i) => ({ type: 'tool-result', toolCallId: `c${i}`, toolName: r.tool, output: { type: 'json', value: r.value } })) },
  ];
  it('counts failed writes not fixed later', () => {
    const p = prompt([{ tool: 'finance_create_movement', value: { id: 1 } }, { tool: 'finance_create_movement', value: { error: { code: 'VALIDATION_ERROR' } } }]);
    expect(failedWritesThisTurn(p as never)).toEqual(['finance_create_movement']);
  });
  it('"todo registrado" with a failed write gets one retry with feedback', async () => {
    const sm = scriptedModel([{ text: 'Listo, todo registrado.' }, { text: 'Registré 1 de 2; falló el segundo, ¿con qué cuenta?' }]);
    const guarded = withFalseSaveGuard(sm.model, () => 'no') as { doStream(o: unknown): Promise<{ stream: ReadableStream<{ type: string; delta?: string }> }> };
    const p = prompt([{ tool: 'finance_create_movement', value: { id: 1 } }, { tool: 'finance_create_movement', value: { error: { code: 'VALIDATION_ERROR' } } }]);
    const out = await withUsageScope({ requestId: 'r', intent: 'expense', media: 'text', kind: 'chat' }, () => guarded.doStream({ prompt: p }));
    const parts: string[] = [];
    const reader = out.stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.type === 'text-delta') parts.push(value.delta ?? '');
    }
    expect(parts.join('')).toMatch(/falló el segundo/);
    expect(JSON.stringify(sm.calls[1]!.prompt)).toMatch(/Not everything was saved/);
  });
});

describe('through Telegram', () => {
  async function boot(script: Turn[], transcript?: string) {
    const tg = await new MockTelegram().start();
    closers.push(() => tg.stop());
    const mason = await startFakeMason();
    closers.push(mason.close);
    const fin = await startFakeFinance('t');
    closers.push(fin.close);
    const sm = scriptedModel(script);
    const logs: string[] = [];
    const hub: Hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME), HUB_VERSION: 'abc1234' }), {
      model: sm.model as never,
      ...(transcript ? { transcribeModel: scriptedModel([{ text: JSON.stringify({ transcript, language: 'es' }) }]).model } : {}),
      env: { T: 't', HUB_VERSION: 'abc1234' },
      registry: { servers: { ...MFP_REGISTRY(mason.url).servers, finance: { url: fin.url, headers: { Authorization: { env: 'T', prefix: 'Bearer ' } } } } },
      telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: (m) => logs.push(m) },
    });
    closers.push(() => hub.stop());
    await hub.start();
    return { tg, sm, hub, logs, mason };
  }
  const statusCalls = (tg: MockTelegram) => tg.calls.filter((c) => /sendMessage|editMessageText/.test(c.method) && c.body.parse_mode === 'HTML');
  const mov = (amount: number, notes: string, pocketId = 'pk-nequi-main') => ({ tool: 'finance_create_movement', args: { pocketId, type: 'EgresoNormal', amount, date: '2026-10-19', description: notes } });

  it('a partial expense batch: one ⚠️ status with the cause, the action and `CODE · req id`', async () => {
    const { tg, hub, logs } = await boot([{ calls: [mov(18000, 'almuerzo'), mov(5000, 'café'), mov(262, 'camisa', 'pk-unknown')] }, { text: 'Registré 2; la camisa no, ¿con qué cuenta?' }]);
    tg.push(textUpdate(ME, 'gasté 18 mil almuerzo, 5 mil café y 262 una camisa, Nequi'));
    await tg.waitFor(() => statusCalls(tg).some((c) => /⚠️/.test(String(c.body.text))), 10_000);
    const s = statusCalls(tg);
    expect(s).toHaveLength(1);
    const text = String(s[0]!.body.text);
    expect(text).toMatch(/^⚠️ Guardé 2 de 3 gastos\. Falló: camisa \$262 — falta la cuenta\. ¿Con cuál la pagó\?\n<code>VALIDATION_ERROR · req ([0-9a-f]{6})<\/code>$/);
    const req = text.match(/req ([0-9a-f]{6})/)![1]!;
    expect(logs.some((l) => l.startsWith(`[req ${req}]`))).toBe(true);
    expect((await hub.usage.rows(0)).every((r) => r.requestId === req)).toBe(true);
    // /estado lists it
    tg.push(textUpdate(ME, '/estado'));
    await tg.waitFor(() => /📊 Estado/.test(tg.outgoingText(ME)), 10_000);
    const estado = tg.outgoingText(ME).slice(tg.outgoingText(ME).indexOf('📊'));
    expect(estado).toMatch(/versión abc1234/);
    expect(estado).toMatch(/🟢 Finanzas: \d+ herramientas/);
    expect(estado).toMatch(/🟢 MyFitnessPal/);
    expect(estado).toMatch(/🤖 Gemini hoy/);
    expect(estado).toMatch(/💸 Presupuesto: .* \/ 2.0M tokens/);
    expect(estado).toContain(`VALIDATION_ERROR · req ${req}`);
  });

  it('a voice note: 📥 received, then ✅ in the same message after the write', async () => {
    const { tg } = await boot([{ tool: 'log_meal', args: { items: [{ query: 'rice', quantity: 1, unit: 'cup', kcal_estimate: 200, meal: 'dinner' }] } }, { text: 'Cena registrada.' }], 'cené una taza de arroz');
    tg.addFile('v', { path: 'v.oga', mime: 'audio/ogg', bytes: Buffer.from('OggS') });
    tg.push(voiceUpdate(ME, 'v'));
    await tg.waitFor(() => statusCalls(tg).some((c) => /^✅/.test(String(c.body.text))), 10_000);
    const s = statusCalls(tg);
    expect(s[0]!.method).toBe('sendMessage');
    expect(s[0]!.body.text).toBe('📥 Nota recibida, Amo Julián. Transcribiendo…');
    const id = (s[0]!.result as { message_id: number }).message_id;
    expect(s.slice(1).every((c) => c.method === 'editMessageText' && c.body.message_id === id)).toBe(true);
    expect(s.at(-1)!.body.text).toBe('✅ Cena: 1 alimento, 205 kcal');
  });

  it('an approved delete: ✅ status after the resumed run', async () => {
    const { tg } = await boot([{ tool: 'finance_delete_movement', args: { id: 'mov-9' } }, { text: 'Borrado.' }]);
    tg.push(textUpdate(ME, 'borra el movimiento mov-9 de Nequi'));
    await tg.waitFor(() => !!findButton(tg, 'tool_approve:'), 10_000);
    const b = findButton(tg, 'tool_approve:')!;
    tg.push(callbackUpdate(ME, { message_id: b.messageId }, b.data));
    await tg.waitFor(() => statusCalls(tg).some((c) => /^✅/.test(String(c.body.text))), 10_000);
    expect(String(statusCalls(tg).at(-1)!.body.text)).toBe('✅ 1 movimiento borrado');
  });

  it('a quick chat answer sends no status message at all', async () => {
    const { tg } = await boot([{ text: 'Buenas noches, Amo Julián.' }]);
    tg.push(textUpdate(ME, 'hola'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('Buenas noches'), 10_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(statusCalls(tg)).toEqual([]);
  });
});

describe('restart and service notices', () => {
  it('🔄 restart names the version and the connected apps; 🔌 down/back', () => {
    expect(msgs.restart('e496959', { finance: { state: 'up' }, mfp: { state: 'up' }, cines: { state: 'down' }, echo: { state: 'skipped' } }).text).toBe(
      '🔄 De vuelta, Amo Julián (versión e496959). Conectados: Finanzas, MyFitnessPal. ⚠️ Sin respuesta: Cinépolis.',
    );
    expect(msgs.serviceDown('mfp', 12 * 60_000).text).toMatch(/^🔌 MyFitnessPal no responde desde hace 12 min, Amo Julián\./);
    expect(msgs.serviceBack('mfp', 14 * 60_000).text).toBe('🔌 MyFitnessPal volvió, Amo Julián (estuvo fuera 14 min).');
  });
});
