/** BUG A (planning text leak), BUG B (approval status order), BUG C (clear_day). */
import { afterEach, describe, expect, it } from 'vitest';
import { leaks, stripLeaks } from '../src/guards/leak.js';
import { createHub, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel, type Turn } from './support/scripted-model.js';
import { MockTelegram, callbackUpdate, findButton, textUpdate } from './support/mock-telegram.js';
import { MFP_REGISTRY, startFakeMason, type FakeMason } from './support/fake-mason.js';

const ME = 42;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const LIVE_LEAK =
  "The user wants to: Clear the entire MyFitnessPal diary for today and tomorrow. Rule check: 'Batch approvals…' Let's call fitness_get_day for today. Wait, can we do tool calls in this turn?";

describe('planning leak detector', () => {
  it('flags the live leak and tool names; not a normal answer', () => {
    expect(leaks(LIVE_LEAK)).toBe(true);
    expect(leaks('Voy a llamar a fitness_delete_food')).toBe(true);
    expect(leaks('Muy bien, Amo Julián. Desayuno: 3 alimentos, 420 kcal.')).toBe(false);
    expect(leaks('¿Con qué cuenta pagó la camisa?')).toBe(false);
  });
  it('strips only the leaking sentences', () => {
    expect(stripLeaks('Listo, Amo Julián. Let\'s call fitness_get_day now.\nDesayuno: 420 kcal.')).toBe('Listo, Amo Julián.\nDesayuno: 420 kcal.');
  });
});

describe('through Telegram', () => {
  let tg: MockTelegram;
  let mason: FakeMason;
  async function boot(script: Turn[], diary: { meal: string; name: string; calories: number }[] = []) {
    tg = await new MockTelegram().start();
    closers.push(() => tg.stop());
    mason = await startFakeMason(diary);
    closers.push(mason.close);
    const sm = scriptedModel(script);
    const logs: string[] = [];
    const hub: Hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME) }), {
      model: sm.model as never,
      registry: MFP_REGISTRY(mason.url),
      telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: (m) => logs.push(m) },
    });
    closers.push(() => hub.stop());
    await hub.start();
    return { sm, logs, hub };
  }
  const allText = () =>
    tg.calls
      .filter((c) => ['sendMessage', 'editMessageText', 'sendRichMessage'].includes(c.method))
      .map((c) => String((c.body.rich_message as { markdown?: string } | undefined)?.markdown ?? c.body.text ?? '').replace(/\\/g, ''))
      .join('\n');

  it('BUG A: text written in a tool step never reaches Telegram; a leaking final reply is retried', async () => {
    // step 1: planning prose + a tool call (Gemini does this); step 2: a final reply that leaks; step 3: clean
    const { logs } = await boot([
      { tool: 'fitness_get_day', args: {} },
      { text: LIVE_LEAK },
      { text: 'Hoy no tiene nada registrado, Amo Julián.' },
    ]);
    tg.push(textUpdate(ME, '¿qué comí hoy?'));
    await tg.waitFor(() => allText().includes('no tiene nada registrado'), 10_000);
    expect(allText()).not.toMatch(/Rule check|fitness_get_day|The user wants/);
    expect(logs.join('\n')).toMatch(/leaks internal planning; retrying once/);
  });

  it('BUG A: planning text in the SAME step as a tool call is dropped', async () => {
    const { MastraLanguageModelV2Mock, simulateReadableStream } = await import('@mastra/core/test-utils/llm-mock');
    let n = 0;
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const model = new MastraLanguageModelV2Mock({
      doStream: async () => {
        const first = n++ === 0;
        const chunks = first
          ? [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: LIVE_LEAK },
              { type: 'text-end', id: 't' },
              { type: 'tool-call', toolCallId: 'c1', toolName: 'fitness_get_day', input: '{}' },
              { type: 'finish', finishReason: 'tool-calls', usage },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'u' },
              { type: 'text-delta', id: 'u', delta: 'Su diario de hoy está vacío.' },
              { type: 'text-end', id: 'u' },
              { type: 'finish', finishReason: 'stop', usage },
            ];
        return { stream: simulateReadableStream({ chunks: chunks as never[] }) as never };
      },
    });
    tg = await new MockTelegram().start();
    closers.push(() => tg.stop());
    mason = await startFakeMason();
    closers.push(mason.close);
    const hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME) }), {
      model: model as never,
      registry: MFP_REGISTRY(mason.url),
      telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: () => {} },
    });
    closers.push(() => hub.stop());
    await hub.start();
    tg.push(textUpdate(ME, '¿qué comí hoy?'));
    await tg.waitFor(() => allText().includes('vacío'), 10_000);
    expect(allText()).not.toMatch(/Rule check|fitness_get_day|The user wants/);
  });

  it('BUG C + B: clear_day shows ONE compact card; status waits for approval; ✅ runs every delete then the re-add, in code', async () => {
    const diary = [
      { meal: 'Breakfast', name: 'Coffee, black', calories: 2 },
      { meal: 'Breakfast', name: 'Egg, whole, large', calories: 144 },
      { meal: 'Lunch', name: 'Rice, white, cooked', calories: 205 },
    ];
    const { sm } = await boot(
      [
        {
          tool: 'clear_day',
          args: { then_log: { items: [{ query: 'egg', quantity: 2, unit: 'unit', kcal_estimate: 150, meal: 'breakfast' }, { query: 'arepa', quantity: 1, unit: 'unit', kcal_estimate: 220, meal: 'breakfast' }, { query: 'sandwich', quantity: 1, unit: 'unit', kcal_estimate: 400, meal: 'breakfast' }] } },
        },
        { text: 'Apruebe la solicitud para proceder.' }, // dropped: the card is the message
      ],
      diary,
    );
    tg.push(textUpdate(ME, 'limpia hoy y vuelve a agregar 2 huevos con arepa al desayuno'));
    await tg.waitFor(() => !!findButton(tg, 'plan:a:'), 10_000);
    await tg.waitFor(() => /Esperando su aprobación/.test(allText()), 10_000);
    const card = allText();
    expect(card).toMatch(/📋 Vaciar \d{4}-\d{2}-\d{2}: 3 entradas/);
    expect(card).toMatch(/• Desayuno \d{4}-\d{2}-\d{2}: 2 entradas, 146 kcal/);
    expect(card).toMatch(/• Almuerzo \d{4}-\d{2}-\d{2}: 1 entrada, 205 kcal/);
    expect(card).toMatch(/Luego agregar .*: egg, arepa, sandwich/);
    expect(card).not.toMatch(/Ejecutando|Apruebe la solicitud/); // nothing runs (or is claimed) before ✅
    expect(mason.diary).toHaveLength(3);
    const modelCalls = sm.calls.length;
    const b = findButton(tg, 'plan:a:')!;
    tg.push(callbackUpdate(ME, { message_id: b.messageId }, b.data));
    await tg.waitFor(() => /✅ Hecho: 4\/4/.test(allText()), 10_000);
    expect(sm.calls.length).toBe(modelCalls); // executed in code, no model calls
    const deletes = mason.calls.filter((c) => c.tool === 'fitness_delete_food');
    expect(deletes).toHaveLength(3);
    const lastDelete = mason.calls.lastIndexOf(deletes.at(-1)!);
    const firstLog = mason.calls.findIndex((c) => c.tool === 'fitness_log_food');
    expect(firstLog).toBeGreaterThan(lastDelete);
    expect(mason.diary.map((e) => e.name).sort()).toEqual(['Arepa, corn', 'Egg, whole, large']);
    expect(allText()).toMatch(/❓ Sin registrar, dígame la porción: sandwich/);
    expect(allText()).not.toMatch(/fitness_|clear_day|log_meal/);
  });

  it('clear_day on an empty day proposes nothing', async () => {
    const { logs } = await boot([{ tool: 'clear_day', args: { meals: ['dinner'] } }, { text: 'La cena ya estaba vacía.' }]);
    tg.push(textUpdate(ME, 'borra toda la cena'));
    await tg.waitFor(() => allText().includes('ya estaba vacía'), 10_000);
    expect(findButton(tg, 'plan:a:')).toBeUndefined();
    expect(logs.join('\n')).not.toMatch(/\[plan\] .* proposed/);
  });

  it('single gated actions get a friendly card: no tool names', async () => {
    await boot([{ tool: 'fitness_delete_food', args: { query: 'Egg', meal: 'breakfast' } }, { text: 'Borrado.' }], [{ meal: 'Breakfast', name: 'Egg, whole, large', calories: 144 }]);
    tg.push(textUpdate(ME, 'borra el huevo del desayuno'));
    await tg.waitFor(() => !!findButton(tg, 'tool_approve:'), 10_000);
    expect(allText()).toMatch(/🗑️ Borrar de MyFitnessPal: Egg \(desayuno\)/);
    const b = findButton(tg, 'tool_approve:')!;
    tg.push(callbackUpdate(ME, { message_id: b.messageId }, b.data));
    await tg.waitFor(() => allText().includes('Borrado.'), 10_000);
    expect(allText()).not.toMatch(/fitness_delete_food/);
  });
});
