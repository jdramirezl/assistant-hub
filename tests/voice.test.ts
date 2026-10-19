import { afterEach, describe, expect, it } from 'vitest';
import { mealForHour, mealFromText, mealHint } from '../src/meal.js';
import { createTranscriber, parseTranscript } from '../src/voice/transcribe.js';
import { usageContext, withUsageScope } from '../src/telemetry/context.js';
import { createHub, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel } from './support/scripted-model.js';
import { MockTelegram, voiceUpdate } from './support/mock-telegram.js';
import { MFP_REGISTRY, startFakeMason, type FakeMason } from './support/fake-mason.js';
import { startFakeFinance } from './support/fake-finance.js';

const TZ = 'America/Bogota';
/** 2026-10-19 at `h`:30 in Bogotá (UTC-5). */
const at = (h: number) => Date.UTC(2026, 9, 19, h + 5, 30);

describe('meal from the user\'s words', () => {
  it.each([
    ['cené arroz con pollo', 'dinner'],
    ['anoche me comí una pizza', 'dinner'],
    ['de almuerzo comí lentejas', 'lunch'],
    ['almorcé una arepa', 'lunch'],
    ['la comida de hoy fue sopa', 'lunch'],
    ['desayuné huevos', 'breakfast'],
    ['un snack: una manzana', 'snacks'],
    ['de merienda galletas', 'snacks'],
    ['I had pasta for dinner', 'dinner'],
    ['comí arroz', undefined],
    ['desayuné huevos y almorcé arroz', undefined],
  ])('%s → %s', (text, meal) => {
    expect(mealFromText(text)).toBe(meal);
  });

  it('falls back to the local hour', () => {
    expect([7, 12, 16, 20, 2].map(mealForHour)).toEqual(['breakfast', 'lunch', 'snacks', 'dinner', 'snacks']);
  });

  it('mealHint: word first, hour only for a plain report about now', () => {
    const o = (h: number, date?: string) => ({ timezone: TZ, now: at(h), date });
    expect(mealHint('cené arroz', o(13))).toBe('dinner');
    expect(mealHint('comí una manzana', o(16))).toBe('snacks');
    expect(mealHint('comí una manzana', o(8))).toBe('breakfast');
    expect(mealHint('ayer comí una manzana', o(16))).toBeUndefined();
    expect(mealHint('comí una manzana', o(16, '2026-10-18'))).toBeUndefined();
    expect(mealHint('la segunda', o(16))).toBeUndefined(); // follow-up: keep the model's meal
    expect(mealHint('desayuné huevos y almorcé arroz', o(16))).toBeUndefined();
    expect(mealHint(undefined, o(16))).toBeUndefined();
  });
});

describe('parseTranscript', () => {
  it('reads JSON, fenced JSON, and rejects empty or non-JSON', () => {
    expect(parseTranscript('{"transcript":"cené arroz","language":"ES"}')).toEqual({ transcript: 'cené arroz', language: 'es' });
    expect(parseTranscript('```json\n{"transcript":"hi","language":"en"}\n```')).toEqual({ transcript: 'hi', language: 'en' });
    expect(parseTranscript('{"transcript":"","language":""}')).toBeUndefined();
    expect(parseTranscript('sorry')).toBeUndefined();
  });
});

describe('createTranscriber', () => {
  it('runs as kind "transcribe" under the same request id and keeps the step counter', async () => {
    const seen: unknown[] = [];
    const model = {
      doGenerate: async () => {
        const sc = usageContext.getStore()!;
        seen.push({ kind: sc.kind, requestId: sc.requestId });
        sc.seq++;
        return { content: [{ type: 'text', text: '{"transcript":"hola","language":"es"}' }] };
      },
    };
    const t = createTranscriber(model);
    await withUsageScope({ requestId: 'r1', intent: 'chat', media: 'voice', kind: 'chat' }, async () => {
      expect(await t(new Uint8Array([1]), 'audio/ogg')).toEqual({ transcript: 'hola', language: 'es' });
      expect(usageContext.getStore()!.kind).toBe('chat');
      expect(usageContext.getStore()!.seq).toBe(1);
    });
    expect(seen).toEqual([{ kind: 'transcribe', requestId: 'r1' }]);
  });
  it('never throws', async () => {
    const t = createTranscriber({ doGenerate: async () => { throw new Error('429'); } });
    expect(await t(new Uint8Array([1]), 'audio/ogg')).toBeUndefined();
  });
});

describe('voice notes through Telegram', () => {
  let tg: MockTelegram;
  let mason: FakeMason;
  const closers: (() => Promise<void>)[] = [];
  const hubs: Hub[] = [];
  afterEach(async () => {
    await Promise.all(hubs.splice(0).map((h) => h.stop()));
    for (const c of closers.splice(0)) await c();
  });

  async function boot(script: Parameters<typeof scriptedModel>[0], transcript: Parameters<typeof scriptedModel>[0], hour = 13) {
    tg = await new MockTelegram().start();
    closers.push(() => tg.stop());
    mason = await startFakeMason();
    closers.push(mason.close);
    const fin = await startFakeFinance('t');
    closers.push(fin.close);
    const sm = scriptedModel(script);
    const tm = scriptedModel(transcript);
    const logs: string[] = [];
    const hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: '42' }), {
      model: sm.model as never,
      transcribeModel: tm.model,
      localNow: () => at(hour),
      registry: { servers: { ...MFP_REGISTRY(mason.url).servers, finance: { url: fin.url, headers: { Authorization: { env: 'T', prefix: 'Bearer ' } } } } },
      env: { T: 't' },
      telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: (m) => logs.push(m) },
    });
    hubs.push(hub);
    await hub.start();
    tg.addFile('v', { path: 'v.oga', mime: 'audio/ogg', bytes: Buffer.from('OggS fake audio') });
    return { sm, tm, logs, hub };
  }

  it('transcribes first: the agent gets text, fitness tools only, the spoken meal and language', async () => {
    const { sm, tm, logs } = await boot(
      [
        // the model guesses lunch; the user said "cené"
        { tool: 'log_meal', args: { items: [{ query: 'rice', quantity: 1, unit: 'cup', kcal_estimate: 200, meal: 'lunch' }] } },
        { text: 'Cena registrada.' },
      ],
      [{ text: '{"transcript":"cené una taza de arroz","language":"es"}' }],
    );
    tg.push(voiceUpdate(42, 'v'));
    await tg.waitFor(() => tg.outgoingText(42).includes('Cena registrada'));
    // one transcription call with the audio
    expect(tm.calls).toHaveLength(1);
    expect(JSON.stringify(tm.calls[0]!.prompt)).toContain('audio/ogg');
    // the agent got text, no audio, and only fitness tools
    const prompt = JSON.stringify(sm.calls[0]!.prompt);
    expect(prompt).toContain('[voice note] cené una taza de arroz');
    expect(prompt).not.toContain('audio/ogg');
    expect(prompt).toContain('reply in Spanish');
    expect(sm.calls[0]!.tools.some((t) => t.startsWith('finance_'))).toBe(false);
    expect(sm.calls[0]!.tools).toContain('log_meal');
    // logged as Dinner, not the model's Lunch
    expect(mason.diary).toEqual([expect.objectContaining({ meal: 'Dinner', name: 'Rice, white, cooked' })]);
    expect(logs.join('\n')).toMatch(/meal lunch → dinner/);
    // the transcript itself is never written to the log
    expect(logs.join('\n')).not.toContain('taza de arroz');
  });

  it('falls back to sending the audio when transcription fails', async () => {
    const { sm, logs } = await boot([{ text: 'escuché tu nota' }], [{ text: 'not json at all' }]);
    tg.push(voiceUpdate(42, 'v'));
    await tg.waitFor(() => tg.outgoingText(42).includes('escuché tu nota'));
    expect(JSON.stringify(sm.calls[0]!.prompt)).toContain('audio/ogg');
    expect(sm.calls[0]!.tools).toEqual(expect.arrayContaining(['fitness_log_food', 'finance_create_movement']));
    expect(logs.join('\n')).toMatch(/\[voice\] transcribed .* nothing/);
  });
});
