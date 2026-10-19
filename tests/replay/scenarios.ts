import type { Action, DiaryEntry, ReplicaState } from './replica.js';
import { ACCOUNTS, POCKETS } from './replica.js';

export type Msg = string | { photo: string; caption?: string } | { voice: string };

export interface Scenario {
  id: string;
  /** User turns, sent one after the other (each waits for the bot to finish). */
  turns: Msg[];
  diary?: DiaryEntry[];
  pins?: ReplicaState['pins'];
  movements?: Record<string, unknown>[];
  /** Pin the local (Bogotá) hour the hub sees, e.g. for the meal-by-time fallback. */
  localHour?: number;
  /** Sanity check of the end state (the main check is "same actions as the baseline"). */
  ok(r: { actions: Action[]; state: ReplicaState; cards: string[]; reply: string; today: string; yesterday: string }): boolean | string;
}

const logs = (a: Action[], meal?: string) => a.filter((x) => x.app === 'mfp' && x.op === 'log' && (!meal || x.detail.startsWith(`${meal}:`)));
const fin = (a: Action[], op: string) => a.filter((x) => x.app === 'finance' && x.op === op);
const none = (a: Action[]) => a.length === 0 || `unexpected actions: ${a.map((x) => x.detail).join('; ')}`;
const kcalOf = (s: string) => Number(s.match(/= (\d+) kcal/)?.[1] ?? NaN);
const has = (a: Action[], re: RegExp) => a.some((x) => re.test(x.detail));
/** The reply is in Spanish / English (rough, word-based). */
const spanish = (t: string) => /\b(registr|anot|listo|amo|julián|cena|desayuno|almuerzo|merienda|he )\w*/i.test(t) || `not Spanish: ${t.slice(0, 80)}`;
const english = (t: string) => (/\b(logged|dinner|master|julian|recorded|added)\b/i.test(t) && !/\b(registr\w*|amo julián|cena)\b/i.test(t)) || `not English: ${t.slice(0, 80)}`;
const both = (...r: (boolean | string)[]) => r.find((x) => x !== true) ?? true;
const nequi = `${ACCOUNTS[0]!.name}/${POCKETS[0]!.name}`;

const BREAKFAST: DiaryEntry[] = [
  { meal: 'Breakfast', name: 'Coffee with milk', calories: 60 },
  { meal: 'Breakfast', name: 'Egg, whole, large', calories: 144 },
  { meal: 'Breakfast', name: 'Toast, white bread', calories: 75 },
  { meal: 'Breakfast', name: 'Orange juice', calories: 112 },
  { meal: 'Lunch', name: 'Rice, white, cooked', calories: 205 },
];

export const SCENARIOS: Scenario[] = [
  {
    id: 'eggs-toast',
    turns: ['registra 2 huevos y una tostada en el desayuno'],
    ok: ({ actions }) => {
      const l = logs(actions, 'Breakfast');
      return (l.length === 2 && has(l, /Egg, whole, large.*= 144 kcal/) && has(l, /Toast.*= 75 kcal/)) || l.map((x) => x.detail).join('; ') || 'nothing logged';
    },
  },
  {
    id: 'meal-3',
    turns: ['almorcé arroz blanco, una pechuga de pollo a la plancha y ensalada verde'],
    ok: ({ actions }) => {
      const l = logs(actions, 'Lunch');
      return (l.length === 3 && has(l, /Rice/) && has(l, /Chicken/) && has(l, /salad/i)) || l.map((x) => x.detail).join('; ') || 'nothing logged';
    },
  },
  {
    id: 'repeat-food',
    pins: [{ query: 'coffee with milk', name: 'Coffee with milk', serving: '1 cup (240 ml)', kcalPerServing: 60 }],
    turns: ['un café con leche en el desayuno, como siempre'],
    ok: ({ actions }) => (logs(actions, 'Breakfast').length === 1 && has(actions, /Coffee with milk.*= 60 kcal/)) || actions.map((x) => x.detail).join('; '),
  },
  {
    id: 'plan-delete-breakfast',
    diary: BREAKFAST,
    turns: ['borra todo el desayuno de hoy'],
    ok: ({ actions, state, cards }) =>
      (actions.filter((a) => a.op === 'delete').length === 4 && state.diary.length === 1 && cards.filter((c) => c.startsWith('plan')).length === 1 && !cards.some((c) => c.startsWith('tool'))) ||
      `deletes=${actions.filter((a) => a.op === 'delete').length} cards=${cards.join(',')}`,
  },
  {
    id: 'expense-nequi',
    turns: ['gasté 25k en almuerzo con Nequi'],
    ok: ({ actions, today }) => {
      const c = fin(actions, 'create');
      return (c.length === 1 && c[0]!.detail === `EgresoNormal 25000 COP ${nequi} ${today}`) || c.map((x) => x.detail).join('; ') || 'nothing created';
    },
  },
  {
    id: 'transfer',
    turns: ['pasa 200 mil de Bancolombia (Principal) a Nequi'],
    ok: ({ actions, today }) => {
      const t = fin(actions, 'transfer');
      return (t.length === 1 && t[0]!.detail === `200000 Bancolombia/Principal → ${nequi} ${today}`) || t.map((x) => x.detail).join('; ') || 'no transfer';
    },
  },
  {
    id: 'finance-month',
    movements: [{ id: 'm1', type: 'EgresoNormal', accountId: ACCOUNTS[0]!.id, pocketId: POCKETS[0]!.id, amount: 120000, displayedDate: 'TODAY' }],
    turns: ['¿cuánto gasté este mes?'],
    ok: ({ actions, reply }) => (none(actions) === true && /120[.,]?000|120 ?mil|120k/i.test(reply)) || `reply: ${reply.slice(0, 120)}`,
  },
  {
    id: 'what-did-i-eat',
    diary: BREAKFAST,
    turns: ['¿qué comí hoy?'],
    ok: ({ actions, reply }) => (none(actions) === true && /huevo|egg/i.test(reply)) || `reply: ${reply.slice(0, 120)}`,
  },
  {
    id: 'correction',
    turns: ['comí una arepa en el desayuno', 'no, eran 2 arepas'],
    ok: ({ state }) => {
      const arepas = state.diary.filter((e) => /arepa/i.test(e.name));
      const total = arepas.reduce((a, e) => a + e.calories, 0);
      return total === 440 || `arepa entries: ${arepas.map((e) => `${e.name} ${e.calories}`).join(', ')}`;
    },
  },
  {
    id: 'receipt-photo',
    turns: [{ photo: 'receipt.png', caption: 'registra este gasto, lo pagué con Nequi' }],
    ok: ({ actions }) => {
      const c = fin(actions, 'create');
      return (c.length === 1 && /^EgresoNormal (70730|64300) COP Nequi/.test(c[0]!.detail)) || c.map((x) => x.detail).join('; ') || 'nothing created';
    },
  },
  {
    id: 'voice-expense',
    turns: [{ voice: 'voice-expense.wav' }],
    ok: ({ actions, today }) => {
      const c = fin(actions, 'create');
      return (c.length === 1 && c[0]!.detail === `EgresoNormal 35000 COP ${nequi} ${today}`) || c.map((x) => x.detail).join('; ') || 'nothing created';
    },
  },
  {
    id: 'voice-meal',
    turns: [{ voice: 'voice-meal.wav' }],
    ok: ({ actions, reply }) => {
      const l = logs(actions, 'Dinner');
      return both((l.length === 2 && has(l, /Rice/) && has(l, /Chicken/)) || actions.map((x) => x.detail).join('; ') || 'nothing logged', spanish(reply));
    },
  },
  {
    id: 'voice-breakfast',
    turns: [{ voice: 'voice-breakfast.wav' }], // "En el desayuno me comí dos huevos revueltos y una arepa."
    ok: ({ actions, reply }) => {
      const l = logs(actions, 'Breakfast');
      return both((l.length === 2 && has(l, /Egg/) && has(l, /Arepa/)) || actions.map((x) => x.detail).join('; ') || 'nothing logged', spanish(reply));
    },
  },
  {
    id: 'voice-snack',
    localHour: 16, // no meal word: 16:xx in Bogotá → Snacks
    turns: [{ voice: 'voice-snack.wav' }], // "Me comí un banano."
    ok: ({ actions }) => (logs(actions, 'Snacks').length === 1 && has(actions, /Banana/) && logs(actions).length === 1) || actions.map((x) => x.detail).join('; ') || 'nothing logged',
  },
  {
    id: 'voice-dinner-en',
    turns: [{ voice: 'voice-dinner-en.wav' }], // "For dinner I had a plate of rice and a grilled chicken breast."
    ok: ({ actions, reply }) => {
      const l = logs(actions, 'Dinner');
      return both((l.length === 2 && has(l, /Rice/) && has(l, /Chicken/)) || actions.map((x) => x.detail).join('; ') || 'nothing logged', english(reply));
    },
  },
  {
    id: 'ambiguous-food',
    turns: ['comí un sándwich al almuerzo'],
    ok: ({ actions, reply }) => logs(actions).length === 0 ? /\?/.test(reply) || 'no question asked' : (logs(actions).length === 1 || 'logged more than one'),
  },
  {
    id: 'over-800',
    turns: ['cené una lasaña familiar entera, yo solo'],
    ok: ({ actions, cards }) => (cards.some((c) => c.includes('fitness_log_food')) && logs(actions, 'Dinner').length === 1 && kcalOf(logs(actions, 'Dinner')[0]!.detail) === 1700) || `cards=${cards.join(',')} logs=${logs(actions).map((x) => x.detail).join('; ')}`,
  },
  {
    id: 'mixed',
    turns: ['almorcé una arepa con queso y pagué 18 mil con Nequi'],
    ok: ({ actions, today }) => {
      const c = fin(actions, 'create');
      return (logs(actions, 'Lunch').length >= 1 && has(actions, /Arepa/) && c.length === 1 && c[0]!.detail === `EgresoNormal 18000 COP ${nequi} ${today}`) || actions.map((x) => x.detail).join('; ');
    },
  },
  { id: 'chat', turns: ['hola Alfred, ¿cómo estás?'], ok: ({ actions }) => none(actions) },
  { id: 'water', turns: ['tomé 500 ml de agua'], ok: ({ actions }) => (actions.length === 1 && actions[0]!.op === 'water') || actions.map((x) => `${x.op} ${x.detail}`).join('; ') || 'nothing' },
  { id: 'weight', turns: ['hoy pesé 78.5 kg'], ok: ({ actions }) => (actions.length === 1 && actions[0]!.op === 'weight' && /78\.5/.test(actions[0]!.detail)) || actions.map((x) => `${x.op} ${x.detail}`).join('; ') || 'nothing' },
  {
    id: 'delete-one',
    diary: BREAKFAST,
    turns: ['borra el café del desayuno'],
    ok: ({ actions, cards }) => (actions.length === 1 && actions[0]!.detail === 'Breakfast: Coffee with milk' && cards.some((c) => c.includes('fitness_delete_food'))) || `${actions.map((x) => x.detail).join('; ')} cards=${cards.join(',')}`,
  },
  {
    id: 'expense-mxn',
    turns: ['pagué 350 pesos mexicanos de Uber con Nu'],
    ok: ({ actions, today }) => {
      const c = fin(actions, 'create');
      return (c.length === 1 && c[0]!.detail === `EgresoNormal 350 MXN Nu México/Disponible ${today}`) || c.map((x) => x.detail).join('; ') || 'nothing created';
    },
  },
  {
    id: 'income',
    turns: ['me pagaron el sueldo, 4.2 millones en Bancolombia'],
    ok: ({ actions, today }) => {
      const c = fin(actions, 'create');
      return (c.length === 1 && c[0]!.detail === `IngresoNormal 4200000 COP Bancolombia/Principal ${today}`) || c.map((x) => x.detail).join('; ') || 'nothing created';
    },
  },
  { id: 'balance', turns: ['¿cuánto tengo en Nequi?'], ok: ({ actions, reply }) => (none(actions) === true && /850[.,]?000|850 ?mil/i.test(reply)) || `reply: ${reply.slice(0, 120)}` },
  {
    id: 'snacks',
    turns: ['en las onces me comí un banano y un yogur griego'],
    ok: ({ actions }) => {
      const l = logs(actions, 'Snacks');
      return (l.length === 2 && has(l, /Banana.*= 105 kcal/) && has(l, /yogurt/i)) || l.map((x) => x.detail).join('; ') || 'nothing logged';
    },
  },
  {
    id: 'expense-yesterday',
    turns: ['ayer gasté 60 mil en mercado con Bancolombia'],
    ok: ({ actions, yesterday }) => {
      const c = fin(actions, 'create');
      return (c.length === 1 && c[0]!.detail === `EgresoNormal 60000 COP Bancolombia/Principal ${yesterday}`) || c.map((x) => x.detail).join('; ') || 'nothing created';
    },
  },
  {
    id: 'oatmeal',
    turns: ['desayuné una taza de avena'],
    ok: ({ actions }) => (logs(actions, 'Breakfast').length === 1 && has(actions, /Oatmeal.*= 166 kcal/)) || actions.map((x) => x.detail).join('; ') || 'nothing logged',
  },
];
