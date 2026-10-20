/** Live accuracy bugs (hub 3457de6): "elige c7", wrong year, false "only dubbed", silent runs. */
import { afterEach, describe, expect, it } from 'vitest';
import { checkDate, namedCinemas, resolveRelativeDate, sanitizeFilters } from '../src/cines/args.js';
import { seatPickOf } from '../src/cines/service.js';
import { claimsOf, hasEvidence } from '../src/guards/evidence.js';
import { createHub, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel, lastToolResult, type Turn } from './support/scripted-model.js';
import { MockTelegram, findButton, textUpdate } from './support/mock-telegram.js';
import { CINES_REGISTRY, startFakeCines, type FakeCines } from './support/fake-cines.js';

const ME = 42;
const TZ = 'America/Bogota';
const NOW = Date.UTC(2026, 9, 20, 17, 0); // Tue 2026-10-20 12:00 Bogotá
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

describe('dates', () => {
  it('relative words → YYYY-MM-DD in the user timezone', () => {
    expect(resolveRelativeDate('hoy', TZ, NOW)).toBe('2026-10-20');
    expect(resolveRelativeDate('mañana', TZ, NOW)).toBe('2026-10-21');
    expect(resolveRelativeDate('viernes', TZ, NOW)).toBe('2026-10-23');
    expect(resolveRelativeDate('el sábado', TZ, NOW)).toBe('2026-10-24');
    expect(resolveRelativeDate('martes', TZ, NOW)).toBe('2026-10-20');
    expect(resolveRelativeDate('2026-10-23', TZ, NOW)).toBeUndefined();
  });
  it('the wrong year never reaches the server; valid dates pass', () => {
    expect(checkDate('2025-10-24', TZ, NOW)).toEqual({ error: expect.stringMatching(/in the past \(today is 2026-10-20\)\. Did you mean 2026-10-24\?/) });
    expect(checkDate('2027-03-01', TZ, NOW)).toEqual({ error: expect.stringMatching(/more than 60 days ahead/) });
    expect(checkDate('2026-10-23', TZ, NOW)).toBeUndefined();
    expect(checkDate('viernes', TZ, NOW)).toEqual({ date: '2026-10-23' });
  });
});

describe('filters and named cinemas', () => {
  it('drops vip/format the user did not ask for; vip:"exclude" never with Miyana', () => {
    expect(sanitizeFilters('cines_best_showtime', { movie: 'Clayface', vip: 'exclude', format: 'REGULAR', language: 'SUB', window: 'night' }, 'hay en miyana o toreo?')).toEqual({
      args: { movie: 'Clayface', language: 'SUB', window: 'night' },
      dropped: ['vip=exclude', 'format=REGULAR'],
    });
    expect(sanitizeFilters('cines_best_showtime', { vip: 'only' }, 'quiero VIP').args).toEqual({ vip: 'only' });
    expect(sanitizeFilters('cines_best_showtime', { format: 'IMAX' }, 'en IMAX').args).toEqual({ format: 'IMAX' });
    expect(namedCinemas('¿hay en Miyana o Toreo?')).toEqual(['toreo', 'miyana']);
  });
});

describe('seat picks', () => {
  it.each([
    ['elige c7', ['C7']],
    ['C7', ['C7']],
    ['F7 y F8', ['F7', 'F8']],
    ['quiero los asientos f7, f8', ['F7', 'F8']],
    ['el D5 por favor', ['D5']],
    ['quiero ver Dune', undefined],
    ['elige la de las 8', undefined],
    ['no, sí se puede, es solo 1 ticket; mira que E4 está ocupado y tiene a E3 solo', undefined],
  ])('%s → %j', (t, seats) => expect(seatPickOf(t)).toEqual(seats));
});

describe('availability claims need evidence', () => {
  const p = (tools: string[], extra = '') => [
    { role: 'user', content: [{ type: 'text', text: `elige c7 ${extra}` }] },
    { role: 'tool', content: tools.map((t, i) => ({ type: 'tool-result', toolCallId: `c${i}`, toolName: t, output: { type: 'json', value: {} } })) },
  ];
  it('detects the live false claims', () => {
    expect(claimsOf('Me temo que el asiento C7 no se encuentra disponible. Le sugiero D5.')).toEqual(['seat']);
    expect(claimsOf('En Parque Toreo y Miyana solo la hay doblada al español a las 21:30.')).toEqual(['only']);
    expect(claimsOf('Le propongo el D5, al centro.')).toEqual([]);
  });
  it('a seat claim needs a seat check in this turn', () => {
    expect(hasEvidence('seat', p(['cines_showtimes']) as never)).toBe(false);
    expect(hasEvidence('seat', p(['cines_validate_seats']) as never)).toBe(true);
    expect(hasEvidence('only', p(['cines_showtimes']) as never)).toBe(true);
  });
});

describe('through Telegram (fake cines)', () => {
  let tg: MockTelegram;
  let cines: FakeCines;
  async function boot(script: Turn[], timings?: { workingAfterMs?: number; slowAfterMs?: number }) {
    tg = await new MockTelegram().start();
    closers.push(() => tg.stop());
    cines = await startFakeCines({ phase3: true });
    closers.push(cines.close);
    const sm = scriptedModel(script);
    const logs: string[] = [];
    const hub: Hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME) }), {
      model: sm.model as never,
      registry: CINES_REGISTRY(cines.url),
      statusTimings: { minEditGapMs: 0, ...(timings ?? {}) },
      telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: (m) => logs.push(m) },
    });
    closers.push(() => hub.stop());
    await hub.start();
    return { sm, logs };
  }
  const allText = () => tg.calls.filter((c) => /sendMessage|editMessageText/.test(c.method)).map((c) => String((c.body.rich_message as { markdown?: string } | undefined)?.markdown ?? c.body.text ?? '').replace(/\\/g, '')).join('\n');

  it('"elige c7" after a seat map: the hub validates C7 on THAT showtime, the model holds it (card), no re-search', async () => {
    const { sm, logs } = await boot([
      { tool: 'cines_best_showtime', args: { movie: 'Clayface', date: 'viernes', window: 'night', language: 'SUB' } },
      (p) => ({ tool: 'cines_seat_map', args: { showtimeId: JSON.parse(lastToolResult(p)).value.best.showtimeId, tickets: 1 } }),
      { text: 'Le propongo D5.' },
      (p) => {
        // the hub's instruction carries the real showtime and the validated seat
        const m = JSON.stringify(p).match(/"showtimeId\\":\\"([\d-]+)\\",\\"seats\\":\\"C7\\"/);
        return { tool: 'cines_hold_seats', args: { showtimeId: m?.[1] ?? 'missing', seats: 'C7', tickets: 1 } };
      },
      { text: 'Listo.' },
    ]);
    tg.push(textUpdate(ME, 'Clayface viernes noche, 1, subtitulada, muéstrame asientos'));
    await tg.waitFor(() => allText().includes('Le propongo D5'), 10_000);
    const before = cines.calls.length;
    tg.push(textUpdate(ME, 'elige c7'));
    await tg.waitFor(() => !!findButton(tg, 'tool_approve:'), 10_000);
    const after = cines.calls.slice(before).map((c) => c.tool);
    expect(after[0]).toBe('cines_validate_seats');
    expect(after).not.toContain('cines_showtimes');
    expect(after).not.toContain('cines_best_showtime');
    expect(cines.calls.slice(before)[0]!.args).toMatchObject({ showtimeId: '419-48705', seats: 'C7' });
    expect(logs.join('\n')).toMatch(/seat pick C7 on 419-48705: valid/);
    expect(JSON.stringify(sm.calls.at(-1)!.prompt)).not.toContain('elige c7');
  });

  it('an invalid seat pick: ❓ with the server reason, no model call', async () => {
    const { sm } = await boot([
      { tool: 'cines_seat_map', args: { showtimeId: '570-2201', tickets: 1 } },
      { text: 'Le propongo F7.' },
    ]);
    tg.push(textUpdate(ME, 'asientos de Clayface en el Toreo a las 18:30'));
    await tg.waitFor(() => allText().includes('Le propongo F7'), 10_000);
    const calls = sm.calls.length;
    tg.push(textUpdate(ME, 'elige a1'));
    await tg.waitFor(() => /❓ A1 no se puede/.test(allText()), 10_000);
    expect(allText()).toMatch(/❓ A1 no se puede, Master Julian: A1 está ocupado\. ¿Elige otro asiento\?/);
    expect(tg.sent('sendPhoto').length).toBe(2); // the seat map, then the preview with the choice
    expect(sm.calls.length).toBe(calls); // no model call
  });

  it('a wrong-year date is refused before the server; the filtered best gets the named cinemas unfiltered', async () => {
    const { logs } = await boot([
      { tool: 'cines_best_showtime', args: { movie: 'Clayface', date: '2025-10-24', window: 'night', language: 'SUB' } },
      { tool: 'cines_best_showtime', args: { movie: 'Clayface', date: 'viernes', window: 'night', vip: 'exclude', format: 'REGULAR', language: 'SUB' } },
      (p) => ({ text: /at_named_cinemas/.test(lastToolResult(p)) && /18:30/.test(lastToolResult(p)) && /20:30/.test(lastToolResult(p)) ? 'Toreo 18:30 SUB; Miyana 20:30 SUB.' : 'falta' }),
    ]);
    tg.push(textUpdate(ME, '¿hay Clayface en Miyana o Toreo el viernes en la noche, subtitulada?'));
    await tg.waitFor(() => /Toreo 18:30|falta/.test(allText()), 10_000);
    expect(allText()).toContain('Toreo 18:30 SUB; Miyana 20:30 SUB.');
    expect(cines.calls.some((c) => c.args.date === '2025-10-24')).toBe(false);
    const best = cines.calls.filter((c) => c.tool === 'cines_best_showtime');
    expect(best[0]!.args).not.toHaveProperty('vip');
    expect(best[0]!.args).not.toHaveProperty('format');
    expect(logs.join('\n')).toMatch(/refused date 2025-10-24/);
    expect(logs.join('\n')).toMatch(/dropped filters the user did not ask for \(vip=exclude, format=REGULAR\)/);
  });

  it('a false "only dubbed" without evidence is retried with feedback', async () => {
    const { logs, sm } = await boot([{ text: 'En Toreo y Miyana solo la hay doblada.' }, { tool: 'cines_showtimes', args: { movie: 'Clayface', cinema: 'toreo,miyana' } }, { text: 'Toreo 18:30 subtitulada; Miyana 20:30 subtitulada.' }]);
    tg.push(textUpdate(ME, '¿hay Clayface en Miyana o Toreo?'));
    await tg.waitFor(() => allText().includes('Miyana 20:30'), 10_000);
    expect(allText()).not.toMatch(/solo la hay doblada/);
    expect(logs.join('\n')).toMatch(/claims only availability without evidence/);
    expect(JSON.stringify(sm.calls[1]!.prompt)).toMatch(/Not verified/);
  });

  it('a listing invented without a tool call is retried: the model must call cines_listings', async () => {
    const { logs } = await boot([
      { text: 'En el Toreo hoy: Guasón 2 a las 15:30, 18:45 y 21:30.' },
      { tool: 'cines_listings', args: { cinema: 'toreo', date: 'hoy' } },
      { text: 'Hoy en el Toreo: Dune 17:10, 20:30, 21:15.' },
    ]);
    tg.push(textUpdate(ME, '¿qué hay en el Toreo hoy?'));
    await tg.waitFor(() => allText().includes('Dune 17:10'), 10_000);
    expect(allText()).not.toContain('Guasón');
    expect(logs.join('\n')).toMatch(/claims listing availability without evidence/);
    expect(cines.calls.map((c) => c.tool)).toEqual(['cines_listings']);
  });

  it('every run shows ⏳ after the working delay (also intent chat) and a "slow" update later', async () => {
    const { MastraLanguageModelV2Mock, simulateReadableStream } = await import('@mastra/core/test-utils/llm-mock');
    tg = await new MockTelegram().start();
    closers.push(() => tg.stop());
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => {
        await new Promise((r) => setTimeout(r, 400));
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: 'Hola, Master Julian.' },
              { type: 'text-end', id: 't' },
              { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            ] as never[],
          }) as never,
        };
      },
    });
    const hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME) }), {
      model: model as never,
      registry: { servers: {} },
      statusTimings: { workingAfterMs: 50, slowAfterMs: 200, minEditGapMs: 0 },
      telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: () => {} },
    });
    closers.push(() => hub.stop());
    await hub.start();
    tg.push(textUpdate(ME, 'hola'));
    await tg.waitFor(() => allText().includes('Hola, Master Julian'), 10_000);
    const st = tg.calls.filter((c) => c.body.parse_mode === 'HTML').map((c) => String(c.body.text));
    expect(st[0]).toBe('⏳ Trabajando en ello…');
    expect(st).toContain('⏳ Sigo en ello; Gemini está lento…');
  });
});

describe('invented listings', () => {
  it('3+ times in a cines reply need a cines tool result in this turn', async () => {
    expect(claimsOf('Hoy: 15:30, 18:45 y 21:30.', { cines: true })).toEqual(['listing']);
    expect(claimsOf('Hoy: 15:30, 18:45 y 21:30.')).toEqual([]);
    const prompt = [{ role: 'user', content: [{ type: 'text', text: 'qué hay hoy' }] }];
    expect(hasEvidence('listing', prompt as never)).toBe(false);
  });
});
