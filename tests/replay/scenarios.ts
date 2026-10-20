import type { Action, DiaryEntry, ReplicaState } from './replica.js';
import { ACCOUNTS, POCKETS } from './replica.js';

import type { CinesAction, FakeCinesOptions } from '../support/fake-cines.js';

export type Msg = string | { photo: string; caption?: string } | { voice: string } | { secret: string };

export interface Scenario {
  id: string;
  /** User turns, sent one after the other (each waits for the bot to finish). */
  turns: Msg[];
  diary?: DiaryEntry[];
  pins?: ReplicaState['pins'];
  movements?: Record<string, unknown>[];
  /** Pin the local (Bogotá) hour the hub sees, e.g. for the meal-by-time fallback. */
  localHour?: number;
  /** finance-app replica rejects creates whose notes match (a real failure in the batch). */
  financeReject?: RegExp;
  /** Fake cines-mx-mcp behavior (Phase 3 tools are always served). */
  cines?: FakeCinesOptions;
  /** Sanity check of the end state (the main check is "same actions as the baseline"). */
  ok(r: {
    actions: Action[];
    state: ReplicaState;
    cards: string[];
    reply: string;
    today: string;
    yesterday: string;
    cines: { calls: string[]; args: { tool: string; args: Record<string, unknown> }[]; actions: CinesAction[]; secrets: string[] };
    /** Photos the hub sent (sendPhoto). */
    photos: number;
    logs: string[];
    /** Every text the bot showed. */
    outgoing: string;
    /** Final text of the request's status message ('' if none). */
    status: string;
  }): boolean | string;
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

const called = (calls: string[], tool: string) => calls.includes(tool) || `${tool} not called (calls: ${calls.join(', ') || 'none'})`;
const noFinanceOrMfp = (a: Action[]) => a.length === 0 || `unexpected writes: ${a.map((x) => x.detail).join('; ')}`;

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
    id: 'clear-readd',
    // the live request: clear today + tomorrow, then re-add breakfast. ONE approval card, deletes
    // run by the hub, then the re-add; no planning text in any message (checked for every scenario)
    diary: [
      { meal: 'Breakfast', name: 'Coffee with milk', calories: 60 },
      { meal: 'Breakfast', name: 'Egg, whole, large', calories: 144 },
      { meal: 'Lunch', name: 'Rice, white, cooked', calories: 205 },
      { meal: 'Dinner', name: 'Chicken breast, grilled', calories: 284 },
      { meal: 'Breakfast', name: 'Oatmeal, cooked', calories: 166, date: 'TOMORROW' },
      { meal: 'Snacks', name: 'Banana, medium', calories: 105, date: 'TOMORROW' },
    ],
    turns: ['limpia hoy y mañana en MyFitnessPal, déjalos reiniciados, y vuelve a agregar al desayuno de hoy 2 huevos con una arepa y un melón'],
    ok: ({ actions, state, cards, today }) => {
      const deletes = actions.filter((a) => a.op === 'delete');
      const firstLog = actions.findIndex((a) => a.op === 'log');
      const lastDelete = actions.map((a) => a.op).lastIndexOf('delete');
      const todayDiary = state.diary.filter((e) => !e.date || e.date === today);
      return both(
        cards.filter((c) => c.startsWith('plan')).length === 1 || `plan cards: ${cards.join(',') || 'none'}`,
        !cards.some((c) => c.startsWith('tool')) || `tool cards: ${cards.join(',')}`,
        deletes.length === 6 || `deletes: ${deletes.length}`,
        firstLog < 0 || firstLog > lastDelete || 're-add ran before the clear',
        state.diary.every((e) => !e.date || e.date === today) || 'tomorrow not empty',
        (todayDiary.length >= 2 && todayDiary.every((e) => e.meal === 'Breakfast') && has(actions, /Egg/) && has(actions, /Arepa/)) || `today: ${todayDiary.map((e) => `${e.meal} ${e.name}`).join('; ')}`,
      );
    },
  },
  {
    id: 'clear-duplicates',
    // Mason 0.4.1: identical duplicates cannot be deleted by name; the summary must say so, honestly
    diary: [
      { meal: 'Breakfast', name: 'Egg, whole, large', calories: 72 },
      { meal: 'Breakfast', name: 'Egg, whole, large', calories: 72 },
      { meal: 'Breakfast', name: 'Coffee with milk', calories: 60 },
      { meal: 'Lunch', name: 'Rice, white, cooked', calories: 205 },
    ],
    turns: ['borra todo el desayuno de hoy'],
    ok: ({ actions, state, cards, outgoing }) =>
      both(
        cards.filter((c) => c.startsWith('plan')).length === 1 || `cards: ${cards.join(',') || 'none'}`,
        actions.filter((a) => a.op === 'delete').length === 1 || `deletes: ${actions.filter((a) => a.op === 'delete').length}`,
        state.diary.length === 3 || `diary: ${state.diary.length}`,
        /2 entradas no se pudieron borrar \(duplicados idénticos; MFP no deja elegir cuál\)/.test(outgoing) || 'duplicates not reported',
      ),
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
    ok: ({ actions, reply }) => logs(actions).length === 0 ? /\?|cu[aá]l prefiere|elija|dígame/i.test(reply) || 'no question asked' : (logs(actions).length === 1 || 'logged more than one'),
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
  {
    id: 'voice-mixed',
    // food + 3 expenses from one pocket in one voice note (the first real voice note on the server)
    turns: [{ voice: 'voice-mixed.wav' }],
    ok: ({ actions, today, reply }) => {
      const c = fin(actions, 'create').map((x) => x.detail).sort();
      const want = [18000, 5000, 12000].map((n) => `EgresoNormal ${n} COP ${nequi} ${today}`).sort();
      // "arroz con pollo" is one dish: logging it or asking which one are both fine
      return both(logs(actions, 'Lunch').length >= 1 || /\?/.test(reply) || 'lunch neither logged nor asked', JSON.stringify(c) === JSON.stringify(want) || `movements: ${c.join('; ') || 'none'}`);
    },
  },
  {
    id: 'expense-partial',
    // one of 3 expenses fails server-side: the status must say 2 of 3 with the cause, and the reply must not claim all
    financeReject: /camisa|ropa|"amount":262000/i,
    turns: ['gasté 18 mil en el almuerzo, 5 mil en un café y 262 mil en una camisa, todo con Nequi'],
    ok: ({ actions, status, reply }) =>
      both(
        fin(actions, 'create').length === 2 || `creates: ${fin(actions, 'create').length}`,
        /^⚠️ Guardé 2 de 3 gastos\. Falló: (camisa|ropa)[^—]*\$262\.000 — no hay saldo suficiente/i.test(status) || `status: ${status || 'none'}`,
        /<code>VALIDATION_ERROR · req [0-9a-f]{6}<\/code>/.test(status) || 'no technical line',
        /camisa/i.test(reply) || `reply does not mention the failure: ${reply.slice(0, 120)}`,
      ),
  },
  {
    id: 'voice-snack-items',
    // 5 items incl. a 0-kcal one (gum): log_meal must accept kcal_estimate 0
    turns: [{ voice: 'voice-snack-items.wav' }],
    ok: ({ actions }) => {
      const l = logs(actions, 'Snacks');
      // coffee may be asked (black vs with milk); the rest must be logged, gum included at 0 kcal
      return (l.length >= 3 && has(l, /Apple/) && has(l, /gum.*= 0 kcal/i)) || actions.map((x) => x.detail).join('; ') || 'nothing logged';
    },
  },
  {
    id: 'cines-listings',
    turns: ['¿qué hay en el Toreo hoy?'],
    ok: ({ cines, reply, actions }) => both(called(cines.calls, 'cines_listings'), /dune/i.test(reply) || `reply: ${reply.slice(0, 80)}`, noFinanceOrMfp(actions)),
  },
  {
    id: 'cines-where',
    turns: ['¿dónde pasan Dune?'],
    ok: ({ cines, reply }) => both(cines.calls.some((t) => t === 'cines_find_movie' || t === 'cines_showtimes') || `calls: ${cines.calls.join(',')}`, /toreo|carso|miyana/i.test(reply) || `reply: ${reply.slice(0, 80)}`),
  },
  {
    id: 'cines-tonight',
    turns: ['quiero ver Dune hoy en la noche'],
    ok: ({ cines, reply }) => {
      const best = cines.args.find((c) => c.tool === 'cines_best_showtime');
      return both(
        !!best || `calls: ${cines.calls.join(',')}`,
        !best || ['night', 'evening'].includes(String(best.args.window)) || /^(19|2\d)/.test(String(best.args.after ?? '')) || `window: ${JSON.stringify(best?.args)}`,
        (/20:30/.test(reply) && /(21:00|20:00)/.test(reply)) || `best + 2 alternatives not in reply: ${reply.slice(0, 120)}`,
      );
    },
  },
  {
    id: 'cines-seats',
    turns: ['quiero ver Dune hoy en la noche', 'la de las 20:30 en el Toreo, somos 2, muéstrame los asientos'],
    ok: ({ cines, photos, reply, actions }) =>
      both(
        called(cines.calls, 'cines_seat_map'),
        photos >= 1 || 'no photo sent',
        /F7/i.test(reply) || `proposal not in reply: ${reply.slice(0, 100)}`,
        !/\/images\//.test(reply) || 'image URL leaked into the reply',
        !cines.calls.includes('cines_hold_seats') || 'held without being asked',
        noFinanceOrMfp(actions),
      ),
  },
  {
    id: 'cines-pick-seat',
    // the first live run: "la primera" → seat map photo → "elige el asiento c7" → hold on THAT showtime
    turns: ['quiero ver Dune hoy en la noche', 'muéstrame los asientos de la primera', 'elige el asiento c7'],
    ok: ({ cines, photos, status, outgoing, logs }) => {
      const map = cines.args.filter((c) => c.tool === 'cines_seat_map').at(-1)?.args.showtimeId;
      const hold = cines.actions.find((a) => a.op === 'hold');
      return both(
        photos >= 1 || 'no seat photo sent',
        logs.some((l) => /\[photo\] sent \d+ bytes/.test(l)) || 'no [photo] log line',
        !!map || 'no seat map',
        (!!hold && hold.detail.includes(` ${map} `) && /C7/.test(hold.detail)) || `hold: ${hold?.detail ?? 'none'} (map ${map})`,
        !/CINES_NOT_FOUND|TOOL_ERROR/.test(outgoing) || `error shown: ${status}`,
      );
    },
  },
  {
    id: 'cines-c7',
    // live (req 6735af): "elige c7" after a seat map → validate on THAT showtime → hold card; no re-search, no wrong year
    turns: ['Clayface viernes en la noche, 1 boleto, subtitulada', 'muéstrame los asientos de la primera', 'elige c7'],
    ok: ({ cines, cards, reply }) => {
      const mapAt = cines.args.map((c) => c.tool).lastIndexOf('cines_seat_map');
      const map = cines.args[mapAt]?.args.showtimeId;
      const after = cines.args.slice(mapAt + 1);
      const thisYear = new Date().getFullYear();
      return both(
        mapAt >= 0 || 'no seat map',
        (after[0]?.tool === 'cines_validate_seats' && after[0]?.args.showtimeId === map && /C7/i.test(String(after[0]?.args.seats))) || `after the map: ${after.map((c) => c.tool).join(',') || 'nothing'}`,
        !after.some((c) => /showtimes|best_showtime|listings|find_movie/.test(c.tool)) || 're-searched after the seat pick',
        !cines.args.some((c) => typeof c.args.date === 'string' && /^\d{4}/.test(c.args.date) && Number(c.args.date.slice(0, 4)) < thisYear) || 'a past year reached the server',
        cards.some((c) => c === 'tool:cines_hold_seats') || `cards: ${cards.join(',') || 'none'}`,
        (cines.actions.find((x) => x.op === 'hold')?.detail ?? '').includes(` ${map} C7`) || `hold: ${cines.actions.map((x) => x.detail).join('; ') || 'none'}`,
        !/no (se encuentra|est[aá]) disponible/i.test(reply) || 'false availability claim',
      );
    },
  },
  {
    id: 'cines-named',
    // live: "¿hay en Miyana o Toreo?" must say Toreo 18:30 SUB and Miyana 20:30 SUB, never "solo doblada"
    turns: ['Clayface el viernes en la noche, subtitulada', '¿hay en Miyana o Toreo?'],
    ok: ({ reply, outgoing }) =>
      both(
        /18[:.]30/.test(reply) || `Toreo 18:30 missing: ${reply.slice(0, 200)}`,
        /20[:.]30/.test(reply) || `Miyana 20:30 missing: ${reply.slice(0, 200)}`,
        !/s[oó]lo (la )?hay doblad|solo doblad|únicamente doblad/i.test(outgoing) || 'false "only dubbed"',
      ),
  },
  {
    id: 'cines-paypal',
    // PayPal approved at the Mac: purchase returns in_progress, the hub polls hold_status, then paid with a screenshot
    cines: { inProgress: { polls: 3, outcome: 'paid' } },
    turns: ['aparta y compra el F7 para la función 570-1002 de Dune en el Toreo'],
    ok: ({ cines, photos, status, outgoing }) =>
      both(
        cines.calls.filter((t) => t === 'cines_purchase').length === 1 || `purchase calls: ${cines.calls.filter((t) => t === 'cines_purchase').length}`,
        cines.calls.filter((t) => t === 'cines_hold_status').length >= 3 || 'did not poll hold_status',
        photos >= 1 || 'no confirmation photo',
        /Esperando que apruebe el pago en PayPal en el Mac/.test(outgoing) || 'no PayPal waiting status',
        /^✅ 🎟️ Compra confirmada: reserva DRYRUN-001 · \$99 MXN/.test(status) || `status: ${status || 'none'}`,
      ),
  },
  {
    id: 'cines-buy',
    cines: { purchaseInputs: ['otp_3ds'] },
    turns: ['aparta y compra F7 y F8 para la función 570-1002 de Dune en el Toreo', { secret: 'Q8Z4K2' }],
    ok: ({ cines, cards, outgoing, logs }) =>
      both(
        cines.actions.map((a) => a.op).join(',') === 'hold,purchase' || `cines actions: ${cines.actions.map((a) => a.op).join(',') || 'none'}`,
        cards.length >= 2 || `approval cards pressed: ${cards.length}`,
        /Confirmar compra[\s\S]*\$198 MXN/.test(outgoing) || 'no purchase summary card',
        cines.secrets.join() === 'Q8Z4K2' || `secrets: ${cines.secrets.length}`,
        !logs.join('\n').includes('Q8Z4K2') || 'secret in logs',
        !logs.some((l) => l.startsWith('LEAK')) || 'secret sent to Gemini',
        !logs.some((l) => l.startsWith('SKIPPED')) || 'no secure prompt before the secret',
        (cines.args.find((c) => c.tool === 'cines_purchase')?.args.expectedTotal === 198) || 'purchase total not from the hold',
        cines.args.find((c) => c.tool === 'cines_purchase')?.args.dryRun === true || 'purchase not sent as dryRun',
      ),
  },
];
