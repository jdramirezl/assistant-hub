/** First live Cinépolis run (hub 5fe8d68): invented tool, invented showtimeId, photo log, invented cause. */
import { afterEach, describe, expect, it } from 'vitest';
import { createHub, placeholderArg, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel, lastToolResult, type Turn } from './support/scripted-model.js';
import { MockTelegram, callbackUpdate, findButton, textUpdate } from './support/mock-telegram.js';
import { CINES_REGISTRY, startFakeCines, type FakeCines } from './support/fake-cines.js';

const ME = 42;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

let tg: MockTelegram;
let cines: FakeCines;
async function boot(script: Turn[]) {
  tg = await new MockTelegram().start();
  closers.push(() => tg.stop());
  cines = await startFakeCines({ phase3: true });
  closers.push(cines.close);
  const sm = scriptedModel(script);
  const logs: string[] = [];
  const hub: Hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME) }), {
    model: sm.model as never,
    registry: CINES_REGISTRY(cines.url),
    telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: (m) => logs.push(m) },
  });
  closers.push(() => hub.stop());
  await hub.start();
  return { sm, logs, hub };
}
const status = () => tg.calls.filter((c) => /sendMessage|editMessageText/.test(c.method) && c.body.parse_mode === 'HTML').map((c) => String(c.body.text));
const allText = () => tg.calls.filter((c) => /sendMessage|editMessageText/.test(c.method)).map((c) => String((c.body.rich_message as { markdown?: string } | undefined)?.markdown ?? c.body.text ?? '').replace(/\\/g, '')).join('\n');

describe('placeholders', () => {
  it('flags "...", "<showtimeId>" and "xxx", not real values', () => {
    expect(placeholderArg({ showtimeId: '...' })).toBe('showtimeId="..."');
    expect(placeholderArg({ showtimeId: '<showtimeId>' })).toBe('showtimeId="<showtimeId>"');
    expect(placeholderArg({ holdId: 'xxx' })).toBe('holdId="xxx"');
    expect(placeholderArg({ showtimeId: '570-102603', seats: 'C7' })).toBeUndefined();
  });
});

describe('bug 1: an invented tool the model recovers from is not a ❌', () => {
  it('unknown tool + placeholder → recovered with the real tools: status has no ❌, photo sent and logged', async () => {
    const { logs } = await boot([
      { tool: 'cines_showtime_seats', args: { showtimeId: '...' } }, // does not exist
      { tool: 'cines_seat_map', args: { showtimeId: '...' } }, // placeholder → rejected back to the model
      { tool: 'cines_best_showtime', args: { movie: 'Dune', window: 'night' } },
      (p) => ({ tool: 'cines_seat_map', args: { showtimeId: JSON.parse(lastToolResult(p)).value.best.showtimeId, tickets: 1 } }),
      { text: 'Le propongo el asiento F7.' },
    ]);
    tg.push(textUpdate(ME, 'muéstrame los asientos de la primera'));
    await tg.waitFor(() => allText().includes('Le propongo'), 10_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(status().join('\n')).not.toMatch(/❌|TOOL_ERROR|No guardé/);
    expect(tg.sent('sendPhoto')).toHaveLength(1);
    expect(logs.some((l) => /\[req [0-9a-f]{6}\] \[photo\] sent \d+ bytes \(message \d+\)/.test(l))).toBe(true);
    expect(logs.join('\n')).toMatch(/ignored a call to an unknown tool \(cines_showtime_seats\)/);
    expect(cines.calls.filter((c) => c.tool === 'cines_seat_map').map((c) => c.args.showtimeId)).toEqual(['570-1002']); // the placeholder never reached the server
  });

  it('a read that failed and was not recovered says the cause without "No guardé"', async () => {
    await boot([{ tool: 'cines_listings', args: { cinema: 'Narnia' } }, { text: 'No conozco ese cine.' }]);
    tg.push(textUpdate(ME, '¿qué hay en el cine Narnia?'));
    await tg.waitFor(() => status().some((s) => /^❌/.test(s)), 10_000);
    const last = status().at(-1)!;
    expect(last).toMatch(/^❌ No encontré esa película, cine o función\. Revise el nombre/);
    expect(last).not.toMatch(/No guardé/);
  });
});

describe('bug 3: an invented showtimeId on the hold', () => {
  it('is replaced by the showtime of the seat map the user saw; seats are validated BEFORE the card', async () => {
    const { logs } = await boot([
      { tool: 'cines_best_showtime', args: { movie: 'Dune', window: 'night' } },
      (p) => ({ tool: 'cines_seat_map', args: { showtimeId: JSON.parse(lastToolResult(p)).value.best.showtimeId, tickets: 1 } }),
      { text: 'Le propongo F7.' },
      { tool: 'cines_hold_seats', args: { seats: 'C7', tickets: 1, showtimeId: '588-105001' } }, // invented
      { text: 'Listo.' },
    ]);
    tg.push(textUpdate(ME, 'quiero ver Dune hoy en la noche, muéstrame los asientos'));
    await tg.waitFor(() => allText().includes('Le propongo'), 10_000);
    tg.push(textUpdate(ME, 'elige el asiento c7'));
    await tg.waitFor(() => !!findButton(tg, 'tool_approve:'), 10_000);
    // validated before the card, with the real showtime; the card shows the real function
    expect(cines.calls.map((c) => c.tool)).toContain('cines_validate_seats');
    expect(cines.calls.find((c) => c.tool === 'cines_validate_seats')!.args).toMatchObject({ showtimeId: '570-1002', seats: 'C7' });
    expect(allText()).toMatch(/🎟️ _?Apartar asientos_? \(sin pagar, ~9 min\)\n🎬 Dune: Mesías · Cinépolis Parque Toreo · 20:30 · subtitulada · 2D · C7/);
    const b = findButton(tg, 'tool_approve:')!;
    tg.push(callbackUpdate(ME, { message_id: b.messageId }, b.data));
    await tg.waitFor(() => cines.actions.some((a) => a.op === 'hold'), 10_000);
    expect(cines.actions[0]!.detail).toMatch(/^hold_1 570-1002 C7/);
    expect(logs.join('\n')).toMatch(/showtimeId 588-105001 was never shown to the user; using 570-1002/);
    expect(status().join('\n')).not.toMatch(/CINES_NOT_FOUND|❌/);
  });

  it('invalid seats: no approval card, the error goes back to the model', async () => {
    const { sm } = await boot([
      { tool: 'cines_best_showtime', args: { movie: 'Dune', window: 'night' } },
      (p) => ({ tool: 'cines_hold_seats', args: { seats: 'Z99', showtimeId: JSON.parse(lastToolResult(p)).value.best.showtimeId } }),
      (p) => ({ text: `corrijo: ${/no existe/.test(lastToolResult(p)) ? 'asiento inválido' : 'otro'}` }),
    ]);
    tg.push(textUpdate(ME, 'aparta el asiento Z99 para Dune hoy en la noche'));
    await tg.waitFor(() => allText().includes('corrijo'), 10_000);
    expect(findButton(tg, 'tool_approve:')).toBeUndefined();
    expect(allText()).toContain('asiento inválido');
    expect(cines.actions).toEqual([]);
    expect(sm.calls).toHaveLength(3);
  });
});

describe('bug 4: a failed tool carries its real cause for the model', () => {
  it('the error result has user_message; the prompt tells the model not to invent another', async () => {
    const { sm } = await boot([{ tool: 'cines_find_movie', args: { movie: 'Pelicula Inexistente' } }, { text: 'No la encontré.' }]);
    tg.push(textUpdate(ME, '¿dónde pasan Pelicula Inexistente?'));
    await tg.waitFor(() => allText().includes('No la encontré'), 10_000);
    expect(JSON.stringify(sm.calls[1]!.prompt)).toMatch(/user_message.*no encontré esa película, cine o función/);
  });
});

describe('queued live issues (seat pick during the map run, duplicate failure text)', () => {
  it('a seat pick waits for the open seat-map run, then takes the fast path', async () => {
    const { CinesHub } = await import('../src/cines/service.js');
    const calls: string[] = [];
    const kv = { get: async () => null, set: async () => {}, delete: async () => {}, setIfNotExists: async () => true, incr: async () => 1 };
    const hubc = new CinesHub({
      kv: kv as never,
      toolbox: { execute: async (n: string) => (calls.push(n), { ok: true, showtimeId: '570-2201', seats: ['C7'] }) },
      securePrompt: () => '',
      secureBadFormat: () => '',
      secureExpired: () => '',
    });
    let running = true;
    const p = hubc.seatPick('42', 'Elige C7', { othersRunning: () => running, maxWaitMs: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    await hubc.afterResult('cines_seat_map', {}, { showtimeId: '570-2201', proposal: ['D6'] }, { chatId: '42' });
    running = false;
    const r = await p;
    expect(r?.agentText).toMatch(/"showtimeId":"570-2201","seats":"C7"/);
    expect(calls).toEqual(['cines_validate_seats']);
  });

  it('a reply that only restates the failure is dropped (the ❌ status carries it)', async () => {
    const { restatesFailure, finalFailureCauses } = await import('../src/guards/leak.js');
    const prompt = [
      { role: 'user', content: [{ type: 'text', text: 'aparta C7' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolName: 'cines_hold_seats', output: { type: 'json', value: { error: { code: 'CINES_SCHEMA_CHANGED' }, user_message: 'Cinépolis cambió su sitio. Hay que actualizar cines-mx-mcp; no lo reintento.' } } }] },
    ];
    const causes = finalFailureCauses(prompt as never);
    expect(restatesFailure('Me temo que Cinépolis cambió su sitio y hay que actualizar cines-mx-mcp, Amo Julián.', causes)).toBe(true);
    expect(restatesFailure('Cinépolis cambió su sitio. ¿Quiere que intente otra función?', causes)).toBe(false); // a question stays
    expect(restatesFailure('Le propongo D6.', causes)).toBe(false);
  });
});
