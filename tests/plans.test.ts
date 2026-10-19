import { afterEach, describe, expect, it } from 'vitest';
import { createHub } from '../src/hub.js';
import { renderPlan, PLAN_TEXT_LIMIT } from '../src/plans/render.js';
import { planHash } from '../src/plans/store.js';
import { testConfig } from './helpers.js';
import { scriptedModel, type Turn } from './support/scripted-model.js';
import { callbackUpdate, findButton, liveButtons, MockTelegram, textUpdate } from './support/mock-telegram.js';
import { MFP_REGISTRY, startFakeMason, type DiaryEntry, type FakeMason } from './support/fake-mason.js';
import { startFakeFinance } from './support/fake-finance.js';

const ME = 42;
const FAST = { timeout: 0, retryDelayMs: 50 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A full MFP day: 17 entries over 4 meals. */
const DAY: DiaryEntry[] = [
  ...['Coffee, black', 'Egg, whole, large', 'Bread, whole wheat', 'Butter', 'Orange juice'].map((name, i) => ({ meal: 'Breakfast', name, calories: 50 + i })),
  ...['Arepa, corn', 'Chicken breast', 'Rice, white', 'Beans', 'Avocado', 'Soda'].map((name, i) => ({ meal: 'Lunch', name, calories: 100 + i })),
  ...['Apple', 'Almonds'].map((name, i) => ({ meal: 'Snacks', name, calories: 80 + i })),
  ...['Pasta', 'Tomato sauce', 'Parmesan', 'Red wine'].map((name, i) => ({ meal: 'Dinner', name, calories: 200 + i })),
];
const deleteDayPlan = (entries: DiaryEntry[] = DAY, title = 'Delete Sunday') => ({
  title,
  groups: [...new Set(entries.map((e) => e.meal))].map((meal) => ({
    label: meal,
    actions: entries.filter((e) => e.meal === meal).map((e) => ({ tool: 'fitness_delete_food', args: { query: e.name, meal: e.meal }, summary: `${e.name} — ${e.calories} kcal` })),
  })),
});

async function setup(script: Turn[], opts: { diary?: DiaryEntry[]; dataDir?: string; now?: () => number; registry?: unknown } = {}) {
  const tg = await new MockTelegram().start();
  cleanups.push(() => tg.stop());
  const mason = await startFakeMason(opts.diary ?? DAY);
  cleanups.push(mason.close);
  const sm = scriptedModel(script);
  const cfg = testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME), ...(opts.dataDir ? { HUB_DATA_DIR: opts.dataDir } : {}) });
  const hub = createHub(cfg, {
    model: sm.model as never,
    registry: opts.registry ?? MFP_REGISTRY(mason.url),
    now: opts.now,
    telegram: { apiBaseUrl: tg.url, longPolling: FAST, log: () => {} },
  });
  cleanups.push(() => hub.stop());
  await hub.start();
  return { tg, mason, hub, sm, cfg };
}

const sent = (tg: MockTelegram, needle: string | RegExp) =>
  tg.calls.filter((c) => c.method === 'sendMessage' && (typeof needle === 'string' ? String(c.body.text).includes(needle) : needle.test(String(c.body.text))));
const deletes = (m: FakeMason) => m.calls.filter((c) => c.tool === 'fitness_delete_food');
const press = (tg: MockTelegram, kind: 'a' | 'e' | 'c', planNth = -1) => {
  const ids = [...new Set(tg.calls.flatMap((c) => JSON.stringify(c.body.reply_markup ?? '').match(/plan:a:[\w-]+/g) ?? []))];
  const id = ids.at(planNth)!.split(':')[2]!;
  const btn = findButton(tg, `plan:${kind}:${id}`)!;
  tg.push(callbackUpdate(ME, { message_id: btn.messageId }, btn.data));
  return id;
};

describe('renderPlan', () => {
  it('groups by section, numbers every action, buttons only on the last chunk, callback data ≤ 64 bytes', () => {
    const r = renderPlan({ id: 'abcdefgh', ...deleteDayPlan() }, 'en');
    const text = r.chunks.join('\n');
    expect(text).toContain('📋 Delete Sunday');
    expect(text).toContain('17 actions');
    for (const meal of ['Breakfast', 'Lunch', 'Snacks', 'Dinner']) expect(text).toContain(meal);
    expect(text).toMatch(/17\. Red wine — 203 kcal/);
    expect(r.keyboard.flat().map((b) => b.text)).toEqual(['✅ Approve all', '✏️ Edit', '❌ Cancel']);
    expect(r.keyboard.flat().every((b) => Buffer.byteLength(b.callback_data) <= 64)).toBe(true);
  });
  it('splits plans longer than Telegram allows', () => {
    const many = { id: 'abcdefgh', title: 'Big', groups: [{ label: 'All', actions: Array.from({ length: 120 }, (_, i) => ({ tool: 'x_delete', args: {}, summary: `item ${i} ${'·'.repeat(60)}` })) }] };
    const r = renderPlan(many, 'es');
    expect(r.chunks.length).toBeGreaterThan(1);
    expect(r.chunks.every((c) => c.length <= PLAN_TEXT_LIMIT)).toBe(true);
    expect(r.keyboard.flat().map((b) => b.text)).toEqual(['✅ Aprobar todo', '✏️ Editar', '❌ Cancelar']);
  });
  it('hash changes when any arg changes', () => {
    const a = deleteDayPlan();
    const b = structuredClone(a);
    b.groups[0]!.actions[0]!.args.query = 'Everything';
    expect(planHash(a)).not.toBe(planHash(b));
    expect(planHash(a)).toBe(planHash(structuredClone(a)));
  });
});

describe('propose_plan through Telegram', () => {
  it('17-item MFP delete: 1 card, 1 approval, 17 calls, 1 summary, no per-item cards', async () => {
    const { tg, mason } = await setup([
      { tool: 'propose_plan', args: deleteDayPlan() },
      { text: 'Plan listo, Amo Julián.' },
      { text: 'Hecho: 17 entradas eliminadas.' },
    ]);
    tg.push(textUpdate(ME, 'borra todo lo de hoy'));
    await tg.waitFor(() => !!findButton(tg, 'plan:a:'));
    expect(sent(tg, '📋 Delete Sunday')).toHaveLength(1);
    expect(deletes(mason)).toHaveLength(0);
    press(tg, 'a');
    await tg.waitFor(() => sent(tg, '17/17').length === 1);
    expect(deletes(mason)).toHaveLength(17);
    expect(mason.diary).toHaveLength(0);
    expect(findButton(tg, 'tool_approve:')).toBeUndefined();
    expect(liveButtons(tg).filter((b) => b.startsWith('plan:'))).toEqual([]); // buttons gone
    expect(tg.outgoingText(ME)).toMatch(/17\/17/);
    expect(tg.outgoingText(ME)).not.toMatch(/fitness_delete_food/); // no tool chatter
  });

  it('runs exactly the stored args, in order', async () => {
    const { tg, mason } = await setup([{ tool: 'propose_plan', args: deleteDayPlan(DAY.slice(0, 3)) }, { text: 'ok' }, { text: 'listo' }]);
    tg.push(textUpdate(ME, 'borra el desayuno'));
    await tg.waitFor(() => !!findButton(tg, 'plan:a:'));
    press(tg, 'a');
    await tg.waitFor(() => deletes(mason).length === 3);
    expect(deletes(mason).map((c) => c.input)).toEqual(DAY.slice(0, 3).map((e) => ({ query: e.name, meal: e.meal })));
  });

  it('Edit: the agent re-proposes, the old plan is invalidated, only the new one runs', async () => {
    const withoutCoffee = DAY.slice(1, 5);
    const { tg, mason, hub } = await setup([
      { tool: 'propose_plan', args: deleteDayPlan(DAY.slice(0, 5), 'Delete breakfast') },
      { text: 'Plan listo.' },
      { tool: 'propose_plan', args: deleteDayPlan(withoutCoffee, 'Delete breakfast (no coffee)') },
      { text: 'Plan corregido.' },
      { text: 'Hecho.' },
    ]);
    tg.push(textUpdate(ME, 'borra el desayuno'));
    await tg.waitFor(() => !!findButton(tg, 'plan:a:'));
    const first = press(tg, 'e');
    await tg.waitFor(() => sent(tg, /Qué cambio|What should I change/).length === 1);
    expect(liveButtons(tg).some((b) => b.includes(first))).toBe(false);
    tg.push(textUpdate(ME, 'sin el café'));
    await tg.waitFor(() => sent(tg, 'no coffee').length === 1);
    expect((await hub.plans.store.get(first))!.status).toBe('superseded');
    // an old button press is refused
    tg.push(callbackUpdate(ME, { message_id: 1 }, `plan:a:${first}`));
    await new Promise((r) => setTimeout(r, 300));
    expect(deletes(mason)).toHaveLength(0);
    press(tg, 'a');
    await tg.waitFor(() => deletes(mason).length === 4);
    await new Promise((r) => setTimeout(r, 200));
    expect(mason.diary.map((e) => e.name)).toContain('Coffee, black');
  });

  it('Cancel runs nothing', async () => {
    const { tg, mason } = await setup([{ tool: 'propose_plan', args: deleteDayPlan() }, { text: 'ok' }]);
    tg.push(textUpdate(ME, 'borra todo'));
    await tg.waitFor(() => !!findButton(tg, 'plan:a:'));
    press(tg, 'c');
    await tg.waitFor(() => /Cancel/i.test(tg.outgoingText(ME).split('\n').slice(-3).join(' ')) || tg.calls.some((c) => c.method === 'editMessageText' && /❌/.test(String(c.body.text))));
    await new Promise((r) => setTimeout(r, 300));
    expect(deletes(mason)).toHaveLength(0);
    expect(liveButtons(tg).filter((b) => b.startsWith('plan:'))).toEqual([]);
  });

  it('a tampered plan is refused', async () => {
    const { tg, mason, hub } = await setup([{ tool: 'propose_plan', args: deleteDayPlan(DAY.slice(0, 2)) }, { text: 'ok' }]);
    tg.push(textUpdate(ME, 'borra'));
    await tg.waitFor(() => !!findButton(tg, 'plan:a:'));
    const id = [...JSON.stringify(tg.calls).matchAll(/plan:a:([\w-]+)/g)][0]![1]!;
    const stored = (await hub.plans.store.get(id))!;
    stored.groups[0]!.actions[0]!.args.query = 'Everything';
    await hub.kv.set(`plan:${id}`, stored);
    press(tg, 'a');
    await tg.waitFor(() => tg.calls.some((c) => /⛔/.test(String(c.body.text))));
    expect(deletes(mason)).toHaveLength(0);
  });

  it('an unknown plan id is refused', async () => {
    const { tg, mason } = await setup([]);
    tg.push(callbackUpdate(ME, { message_id: 5 }, 'plan:a:doesnotexist'));
    await tg.waitFor(() => tg.calls.some((c) => /⛔/.test(String(c.body.text))));
    expect(deletes(mason)).toHaveLength(0);
  });

  it('an expired plan (> 30 min) is refused', async () => {
    let now = Date.now();
    const { tg, mason } = await setup([{ tool: 'propose_plan', args: deleteDayPlan(DAY.slice(0, 2)) }, { text: 'ok' }], { now: () => now });
    tg.push(textUpdate(ME, 'borra'));
    await tg.waitFor(() => !!findButton(tg, 'plan:a:'));
    now += 31 * 60_000;
    press(tg, 'a');
    await tg.waitFor(() => tg.calls.some((c) => /⌛/.test(String(c.body.text))));
    expect(deletes(mason)).toHaveLength(0);
  });

  it('a stranger cannot press the buttons', async () => {
    const { tg, mason } = await setup([{ tool: 'propose_plan', args: deleteDayPlan(DAY.slice(0, 2)) }, { text: 'ok' }]);
    tg.push(textUpdate(ME, 'borra'));
    await tg.waitFor(() => !!findButton(tg, 'plan:a:'));
    const btn = findButton(tg, 'plan:a:')!;
    tg.push(callbackUpdate(666, { message_id: btn.messageId }, btn.data));
    await new Promise((r) => setTimeout(r, 500));
    expect(deletes(mason)).toHaveLength(0);
  });

  it('partial failure: continues, then reports each failure in the shared shape', async () => {
    const plan = deleteDayPlan([DAY[0]!, { meal: 'Breakfast', name: 'Unicorn steak', calories: 999 }, DAY[1]!]);
    let summaryPrompt = '';
    const { tg, mason } = await setup([
      { tool: 'propose_plan', args: plan },
      { text: 'ok' },
      (p) => ((summaryPrompt = JSON.stringify(p)), { text: 'Eliminé 2; 1 falló.' }),
    ]);
    tg.push(textUpdate(ME, 'borra'));
    await tg.waitFor(() => !!findButton(tg, 'plan:a:'));
    press(tg, 'a');
    await tg.waitFor(() => sent(tg, '2/3').length === 1);
    expect(deletes(mason)).toHaveLength(3);
    void summaryPrompt;
    expect(tg.outgoingText(ME)).toMatch(/❌ 1 fallaron[\s\S]*MFP_BAD_REQUEST/);
    expect(tg.outgoingText(ME)).toMatch(/2\/3/);
  });

  it('stops on an expired MFP session and skips the rest', async () => {
    let summaryPrompt = '';
    const { tg, mason } = await setup([
      { tool: 'propose_plan', args: deleteDayPlan(DAY.slice(0, 6)) },
      { text: 'ok' },
      (p) => ((summaryPrompt = JSON.stringify(p)), { text: 'Sesión expirada.' }),
    ]);
    mason.expireSessionAfterDeletes = 2;
    tg.push(textUpdate(ME, 'borra'));
    await tg.waitFor(() => !!findButton(tg, 'plan:a:'));
    press(tg, 'a');
    await tg.waitFor(() => sent(tg, 'omitidas').length === 1);
    expect(mason.calls.filter((c) => c.tool === 'fitness_delete_food')).toHaveLength(3); // 2 ok + 1 failing, then stop
    void summaryPrompt;
    expect(tg.outgoingText(ME)).toMatch(/✅ 2\/6 ejecutadas · ❌ 1 fallaron · ⏭️ 3 omitidas[\s\S]*MFP_SESSION_EXPIRED/);
  });

  it('a pending plan survives a restart', async () => {
    const first = await setup([{ tool: 'propose_plan', args: deleteDayPlan(DAY.slice(0, 2)) }, { text: 'ok' }]);
    first.tg.push(textUpdate(ME, 'borra'));
    await first.tg.waitFor(() => !!findButton(first.tg, 'plan:a:'));
    const btn = findButton(first.tg, 'plan:a:')!;
    await first.hub.stop();
    const sm = scriptedModel([{ text: 'Hecho tras reinicio.' }]);
    const hub2 = createHub(first.cfg, { model: sm.model as never, registry: MFP_REGISTRY(first.mason.url), telegram: { apiBaseUrl: first.tg.url, longPolling: FAST, log: () => {} } });
    cleanups.push(() => hub2.stop());
    await hub2.start();
    first.tg.push(callbackUpdate(ME, { message_id: btn.messageId }, btn.data));
    await first.tg.waitFor(() => deletes(first.mason).length === 2);
  });

  it('finance batch delete works the same way (destructiveHint)', async () => {
    const fin = await startFakeFinance('t0k');
    cleanups.push(fin.close);
    const finPlan = {
      title: 'Borrar movimientos duplicados',
      groups: [{ label: 'Nequi', actions: ['mov-1', 'mov-2', 'mov-3'].map((id) => ({ tool: 'finance_delete_movement', args: { id }, summary: `${id} — 25.000 COP — Nequi` })) }],
    };
    const tg = await new MockTelegram().start();
    cleanups.push(() => tg.stop());
    const sm = scriptedModel([{ tool: 'propose_plan', args: finPlan }, { text: 'ok' }, { text: 'Borrados 3.' }]);
    const hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME) }), {
      model: sm.model as never,
      registry: { servers: { finance: { url: '${FINANCE_MCP_URL}', headers: { Authorization: { env: 'FINANCE_MCP_TOKEN', prefix: 'Bearer ' } } } } },
      env: { FINANCE_MCP_URL: fin.url, FINANCE_MCP_TOKEN: 't0k' },
      telegram: { apiBaseUrl: tg.url, longPolling: FAST, log: () => {} },
    });
    cleanups.push(() => hub.stop());
    await hub.start();
    tg.push(textUpdate(ME, 'borra los duplicados'));
    await tg.waitFor(() => !!findButton(tg, 'plan:a:'));
    press(tg, 'a');
    await tg.waitFor(() => sent(tg, '3/3').length === 1);
    expect(fin.calls.filter((c) => c.tool === 'finance_delete_movement').map((c) => c.input.id)).toEqual(['mov-1', 'mov-2', 'mov-3']);
  });
});

describe('delete-all completeness check', () => {
  it('"borra todo el desayuno" with 4 of 5 entries is bounced back; the re-proposed full plan is shown', async () => {
    const breakfast = DAY.filter((e) => e.meal === 'Breakfast');
    let feedback = '';
    const { tg, mason } = await setup([
      { tool: 'propose_plan', args: deleteDayPlan(breakfast.slice(0, 4), 'Delete breakfast') },
      (p) => ((feedback = JSON.stringify(p)), { tool: 'propose_plan', args: deleteDayPlan(breakfast, 'Delete breakfast (all 5)') }),
      { text: 'Plan listo.' },
    ]);
    tg.push(textUpdate(ME, 'borra todo el desayuno de hoy'));
    await tg.waitFor(() => !!findButton(tg, 'plan:a:'));
    expect(feedback).toContain('PLAN_INCOMPLETE');
    expect(feedback).toContain('Orange juice');
    expect(sent(tg, '📋 Delete breakfast (all 5)')).toHaveLength(1);
    expect(sent(tg, /📋 Delete breakfast\n/)).toHaveLength(0);
    expect(deletes(mason)).toHaveLength(0);
  });
  it('a selective delete ("borra el café y el huevo") is not checked', async () => {
    const { tg } = await setup([{ tool: 'propose_plan', args: deleteDayPlan(DAY.slice(0, 2), 'Delete two') }, { text: 'ok' }]);
    tg.push(textUpdate(ME, 'borra el café y el huevo del desayuno'));
    await tg.waitFor(() => !!findButton(tg, 'plan:a:'));
    expect(sent(tg, '📋 Delete two')).toHaveLength(1);
  });
});

describe('result message comes from execution, not the model', () => {
  it('3-item plan where only 2 deletes succeed reports 2/3 even if the model would say 3', async () => {
    const plan = deleteDayPlan([DAY[0]!, { meal: 'Breakfast', name: 'Ghost toast', calories: 70 }, DAY[1]!]);
    const { tg, mason } = await setup([{ tool: 'propose_plan', args: plan }, { text: 'ok' }, { text: 'Las 3 acciones eliminadas con éxito.' }]);
    tg.push(textUpdate(ME, 'borra esos tres'));
    await tg.waitFor(() => !!findButton(tg, 'plan:a:'));
    press(tg, 'a');
    await tg.waitFor(() => sent(tg, '2/3').length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(mason.diary.length).toBe(DAY.length - 2);
    expect(tg.outgoingText(ME)).not.toContain('Las 3 acciones eliminadas');
    expect(tg.outgoingText(ME)).toMatch(/✅ 2\/3 ejecutadas · ❌ 1 fallaron/);
  });
});

describe('propose_plan validation and the backstop', () => {
  it('rejects unknown tools and bad args before showing anything', async () => {
    let seen = '';
    const { tg } = await setup([
      { tool: 'propose_plan', args: { title: 'x', groups: [{ label: 'a', actions: [{ tool: 'fitness_nuke_everything', args: {}, summary: 'boom' }] }] } },
      (p) => ((seen = JSON.stringify(p)), { text: 'no' }),
    ]);
    tg.push(textUpdate(ME, 'haz algo'));
    await tg.waitFor(() => seen !== '');
    expect(seen).toContain('PLAN_INVALID');
    expect(findButton(tg, 'plan:a:')).toBeUndefined();
  });

  it('2+ gated calls in one step are bounced back to propose_plan (no per-item cards, nothing runs)', async () => {
    const { tg, mason, sm } = await setup([
      { calls: DAY.slice(0, 3).map((e) => ({ tool: 'fitness_delete_food', args: { query: e.name } })) },
      { tool: 'propose_plan', args: deleteDayPlan(DAY.slice(0, 3)) },
      { text: 'Plan listo.' },
    ]);
    tg.push(textUpdate(ME, 'borra el desayuno'));
    await tg.waitFor(() => !!findButton(tg, 'plan:a:'));
    expect(findButton(tg, 'tool_approve:')).toBeUndefined();
    expect(deletes(mason)).toHaveLength(0);
    expect(JSON.stringify(sm.calls[1]!.prompt)).toMatch(/propose_plan/);
  });

  it('a single gated action still uses the normal approval card', async () => {
    const { tg } = await setup([{ tool: 'fitness_delete_food', args: { query: 'Coffee' } }]);
    tg.push(textUpdate(ME, 'borra el café'));
    await tg.waitFor(() => !!findButton(tg, 'tool_approve:'));
    expect(findButton(tg, 'plan:a:')).toBeUndefined();
  });
});
