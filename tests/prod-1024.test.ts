/** Prod 2026-10-24: overwriting a meal on two days, ambiguous grams, unapproved big transfers. */
import { describe, expect, it } from 'vitest';
import { createClearDay, ClearDayInput } from '../src/mcp/clear-day.js';
import { candidates, choose, fixLoggedServings } from '../src/mcp/log-meal.js';
import { PlanService } from '../src/plans/service.js';
import { PlanStore } from '../src/plans/store.js';
import { LogPlanPresenter } from '../src/plans/presenter.js';
import { createVoice } from '../src/persona.js';
import { moneyNeedsApproval } from '../src/mcp/finance-cache.js';
import type { PlanInput } from '../src/plans/types.js';
import { MemoryKv } from './support/memory-kv.js';

type Rec = Record<string, unknown>;
const TODAY = '2026-10-24';
const YESTERDAY = '2026-10-23';
const ITEMS = [
  { query: 'pasta, cooked', quantity: 113, unit: 'g', kcal_estimate: 177, meal: 'lunch' },
  { query: 'potato, air fried', quantity: 43, unit: 'g', kcal_estimate: 40, meal: 'lunch' },
  { query: 'chili beans', quantity: 166, unit: 'g', kcal_estimate: 180, meal: 'lunch' },
];

/** A tiny MFP diary with dates, and the log_meal re-add as a local tool. */
function diaryToolbox() {
  const diary: { date: string; meal: string; name: string; calories: number }[] = [
    { date: TODAY, meal: 'Lunch', name: 'Rice, white, cooked', calories: 205 },
    { date: YESTERDAY, meal: 'Lunch', name: 'Chicken breast', calories: 284 },
    { date: YESTERDAY, meal: 'Breakfast', name: 'Egg', calories: 72 },
  ];
  const toolbox = {
    async getTools() {
      return { fitness_get_day: {}, fitness_delete_food: {} };
    },
    async execute(name: string, a: Rec) {
      const date = String(a.date ?? TODAY);
      if (name === 'fitness_get_day') return { day: date, diary: diary.filter((e) => e.date === date) };
      if (name === 'fitness_delete_food') {
        const i = diary.findIndex((e) => e.date === date && e.name === a.query && e.meal.toLowerCase() === a.meal);
        if (i < 0) return { error: { code: 'MFP_NOT_FOUND', message: 'x', retryable: false } };
        diary.splice(i, 1);
        return { removed: a.query };
      }
      throw new Error(name);
    },
  };
  const logMeal = async (args: Rec) => {
    const date = String(args.date);
    for (const i of args.items as Rec[]) diary.push({ date, meal: 'Lunch', name: String(i.query), calories: Number(i.kcal_estimate) });
    return { logged: (args.items as Rec[]).map((i) => ({ name: i.query })) };
  };
  return { diary, toolbox, logMeal };
}

function setup() {
  const t = diaryToolbox();
  const said: string[] = [];
  const presenter = new LogPlanPresenter('es', () => {});
  presenter.say = async (text: string) => void said.push(text);
  const plans = new PlanService({ store: new PlanStore(new MemoryKv() as never), toolbox: t.toolbox, presenter, voice: createVoice({ persona: 'alfred', language: 'es', ownerName: 'Julián' }), language: 'es', allowedUserIds: ['42'], localTools: { log_meal: t.logMeal } });
  const proposed: PlanInput[] = [];
  const clearDay = createClearDay({ toolbox: t.toolbox, propose: async (input, meta) => (proposed.push(input), plans.propose(input, meta)), today: () => TODAY, language: 'es' }) as unknown as { execute(i: unknown, c: unknown): Promise<Rec> };
  const approve = async () => {
    const plan = (await (plans as unknown as { d: { store: PlanStore } }).d.store.open('dev:local'))[0]!;
    await plans.handleAction(`plan:a:${plan.id}`, '42');
  };
  return { ...t, said, proposed, clearDay, approve };
}

describe('overwrite a meal on several days (clear_day + then_log)', () => {
  it('then_log as an ARRAY of items is accepted (the model sent it 4 times live)', () => {
    const r = ClearDayInput.safeParse({ dates: [TODAY, YESTERDAY], meals: ['lunch'], then_log: ITEMS });
    expect(r.success).toBe(true);
    expect(r.data!.then_log).toEqual({ items: ITEMS });
  });

  it('ONE card with deletes + adds per date; ✅ deletes and re-adds on EVERY date; summary reads each meal back', async () => {
    const s = setup();
    const out = await s.clearDay.execute({ dates: [TODAY, YESTERDAY], meals: ['lunch'], then_log: ITEMS }, {});
    expect(out).toMatchObject({ status: 'shown_to_user' });
    const p = s.proposed[0]!;
    expect(p.groups.map((g) => g.label)).toEqual([`Almuerzo ${TODAY}`, `Almuerzo ${YESTERDAY}`, `Luego agregar (${TODAY})`, `Luego agregar (${YESTERDAY})`]);
    expect(p.title).toMatch(/Reemplazar almuerzo/);
    await s.approve();
    const lunch = (d: string) => s.diary.filter((e) => e.date === d && e.meal === 'Lunch').map((e) => e.name);
    expect(lunch(TODAY)).toEqual(['pasta, cooked', 'potato, air fried', 'chili beans']);
    expect(lunch(YESTERDAY)).toEqual(['pasta, cooked', 'potato, air fried', 'chili beans']);
    expect(s.diary.some((e) => e.date === YESTERDAY && e.meal === 'Breakfast')).toBe(true); // other meals untouched
    const summary = s.said.join('\n');
    expect(summary).toMatch(new RegExp(`Almuerzo ${TODAY}: pasta, cooked \\(177\\), potato, air fried \\(40\\), chili beans \\(180\\) = 397 kcal`));
    expect(summary).toMatch(new RegExp(`Almuerzo ${YESTERDAY}: .* = 397 kcal`));
  });

  it('then_log with its own date re-adds only there; the re-add is exact (no implied extras)', async () => {
    const s = setup();
    await s.clearDay.execute({ dates: [TODAY], meals: ['lunch'], then_log: { date: TODAY, items: ITEMS } }, {});
    const adds = s.proposed[0]!.groups.flatMap((g) => g.actions).filter((a) => a.tool === 'log_meal');
    expect(adds).toHaveLength(1);
    expect(adds[0]!.args).toMatchObject({ date: TODAY, exact: true });
  });
});

describe('whole-day clear + re-add', () => {
  it('without meals the re-add is today only (clear "hoy y mañana", add today\'s breakfast)', async () => {
    const s = setup();
    await s.clearDay.execute({ dates: [TODAY, YESTERDAY], then_log: { items: [ITEMS[0]] } }, {});
    expect(s.proposed[0]!.groups.flatMap((g) => g.actions).filter((a) => a.tool === 'log_meal').map((a) => a.args.date)).toEqual([TODAY]);
  });
});

describe('ambiguous grams: pick the per-gram serving when it is close to the estimate', () => {
  const item = { query: 'chili beans', quantity: 166, unit: 'g', kcal_estimate: 180, meal: 'lunch' as const };
  it('several foods with a gram serving within ~15% → the closest one, no question', () => {
    const opts = [
      { option: 1, name: 'Chili beans, Bush', servings: [{ serving: 0, label: '1/2 cup (130 g)', calories: 120 }] },
      { option: 2, name: 'Chili beans, canned', servings: [{ serving: 0, label: '100 g', calories: 105 }] },
      { option: 3, name: 'Chili con carne', servings: [{ serving: 0, label: '100 g', calories: 160 }] },
    ];
    const c = candidates(item, opts, 1);
    expect(choose(item, c)).toMatchObject({ name: 'Chili beans, canned', kcal: 174 });
  });
  it('an oz serving counts as grams', () => {
    const o = [{ option: 1, name: 'Potato, air fried', servings: [{ serving: 0, label: '1 oz', calories: 26 }] }];
    const it2 = { ...item, query: 'potato', quantity: 43, kcal_estimate: 40 };
    expect(choose(it2, candidates(it2, o, 1))).toMatchObject({ kcal: 39 });
  });
  it('a pick logged with the grams as quantity is corrected to servings (it raised bogus > 800 kcal cards)', () => {
    const asked = [{ draft_id: 'd7', option: 2, serving_index: 0, servings: 1.66, quantity: 166, unit: 'g' }];
    expect(fixLoggedServings({ draft_id: 'd7', option: 2, serving: 0, quantity: 166, meal: 'lunch' }, asked)).toEqual({ draft_id: 'd7', option: 2, serving: 0, quantity: 1.66, meal: 'lunch' });
    expect(fixLoggedServings({ draft_id: 'd7', option: 2, serving: 0, quantity: 1.66 }, asked)).toBeUndefined();
    expect(fixLoggedServings({ draft_id: 'd9', option: 1, serving: 0, quantity: 166 }, asked)).toBeUndefined();
  });
});

describe('money movements need a card', () => {
  const ACCOUNTS = [
    { id: 'mx', name: 'Banamex', currency: 'MXN' },
    { id: 'co', name: 'Nequi', currency: 'COP' },
  ];
  const cur = (id: unknown) => ACCOUNTS.find((a) => a.id === id)?.currency;
  it('the card names the pockets', async () => {
    const { describeAction } = await import('../src/status/approval-card.js');
    const names: Record<string, string> = { a: 'Bancolombia / Ahorro', p: 'Bancolombia / Principal' };
    expect(describeAction('finance_create_transfer', { amount: 300000, sourcePocketId: 'a', targetPocketId: 'p' }, 'es', undefined, (id) => names[String(id)])).toMatch(/🔁 Transferir \$300\.000: Bancolombia \/ Ahorro → Bancolombia \/ Principal/);
  });
  it('every transfer; a movement from 5,000 MXN (or the same in COP/USD); "retirar/eliminar" always', () => {
    expect(moneyNeedsApproval('finance_create_transfer', { amount: 1, sourceAccountId: 'mx' }, cur, '')).toBe(true);
    expect(moneyNeedsApproval('finance_create_movement', { amount: 4999, accountId: 'mx' }, cur, 'gasté 4999')).toBe(false);
    expect(moneyNeedsApproval('finance_create_movement', { amount: 55262.91, accountId: 'mx' }, cur, 'compensa')).toBe(true);
    expect(moneyNeedsApproval('finance_create_movement', { amount: 25000, accountId: 'co' }, cur, 'gasté 25k en almuerzo')).toBe(false);
    expect(moneyNeedsApproval('finance_create_movement', { amount: 1_200_000, accountId: 'co' }, cur, 'pagué el arriendo')).toBe(true);
    expect(moneyNeedsApproval('finance_create_movement', { amount: 200, accountId: 'mx' }, cur, 'retira 200 del bolsillo de ahorros')).toBe(true);
    expect(moneyNeedsApproval('finance_create_movement', { amount: 200, accountId: 'mx' }, cur, 'elimina 200 de viajes')).toBe(true);
  });
});
