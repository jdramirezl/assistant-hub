/**
 * Replicas of the two production MCP servers for the replay harness. They serve the EXACT tool
 * definitions captured from production (tests/support/fixtures/*-tools.json: mfp-mcp 0.4.1 and
 * finance-app /mcp), so the model sees the same tools and token cost, and simulate their
 * behavior with in-memory state. Writes are recorded as canonical "actions" for comparison.
 *
 * Plain stateless Streamable HTTP (JSON responses), like finance-app in production.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Rec = Record<string, unknown>;
type Handler = (args: Rec) => unknown;

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, '..', 'support', 'fixtures', name), 'utf8')) as { name: string }[];

async function serveMcp(name: string, tools: { name: string }[], handlers: Record<string, Handler>, auth?: string) {
  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    if (req.method !== 'POST') return void reply(res, 405, { error: 'method not allowed' });
    if (auth && req.headers.authorization !== `Bearer ${auth}`) return void reply(res, 401, { error: { code: 'UNAUTHORIZED', message: 'bad token', retryable: false } });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let msg: { id?: number | string; method?: string; params?: Rec };
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return void reply(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } });
    }
    if (msg.id === undefined) return void (res.writeHead(202), res.end());
    const ok = (result: unknown) => reply(res, 200, { jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize': {
        const requested = String((msg.params as { protocolVersion?: string })?.protocolVersion ?? '2025-06-18');
        const supported = ['2025-06-18', '2025-03-26', '2024-11-05'];
        return void ok({ protocolVersion: supported.includes(requested) ? requested : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name, version: 'replica' } });
      }
      case 'ping':
        return void ok({});
      case 'tools/list':
        return void ok({ tools });
      case 'tools/call': {
        const p = msg.params as { name: string; arguments?: Rec };
        const h = handlers[p.name];
        if (!h) return void ok({ isError: true, content: [{ type: 'text', text: `Unknown tool ${p.name}` }] });
        try {
          const out = h(p.arguments ?? {});
          const isErr = !!out && typeof out === 'object' && 'error' in (out as Rec);
          return void ok({ isError: isErr, content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: Array.isArray(out) ? { result: out } : out });
        } catch (err) {
          return void ok({ isError: true, content: [{ type: 'text', text: `Error executing tool ${p.name}: ${(err as Error).message}` }] });
        }
      }
      default:
        return void reply(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

/* ------------------------------------------------------------------ Mason (MyFitnessPal) */

export interface Food {
  name: string;
  servings: { label: string; kcal: number }[];
}
/** Keyword → candidates in MFP's (often unhelpful) search order. */
export const FOODS: Record<string, Food[]> = {
  egg: [
    { name: 'Egg Omelette (Restaurant)', servings: [{ label: '1 omelette', kcal: 850 }] },
    { name: 'Egg, whole, large', servings: [{ label: '100 g', kcal: 143 }, { label: '1 large egg', kcal: 72 }] },
    { name: 'Egg white', servings: [{ label: '1 large', kcal: 17 }] },
  ],
  toast: [
    { name: 'Toast, white bread', servings: [{ label: '1 slice', kcal: 75 }, { label: '100 g', kcal: 293 }] },
    { name: 'Avocado toast (cafe)', servings: [{ label: '1 serving', kcal: 420 }] },
  ],
  bread: [{ name: 'Bread, whole wheat', servings: [{ label: '1 slice', kcal: 80 }, { label: '100 g', kcal: 250 }] }],
  coffee: [
    { name: 'Coffee with milk', servings: [{ label: '1 cup (240 ml)', kcal: 60 }] },
    { name: 'Coffee, black', servings: [{ label: '1 cup (240 ml)', kcal: 2 }] },
  ],
  arepa: [{ name: 'Arepa, white corn', servings: [{ label: '1 arepa (100 g)', kcal: 220 }, { label: '100 g', kcal: 220 }] }],
  rice: [{ name: 'Rice, white, cooked', servings: [{ label: '1 cup', kcal: 205 }, { label: '100 g', kcal: 130 }] }],
  chicken: [{ name: 'Chicken breast, grilled', servings: [{ label: '100 g', kcal: 165 }, { label: '1 breast (172 g)', kcal: 284 }] }],
  salad: [{ name: 'Green salad', servings: [{ label: '1 cup', kcal: 15 }, { label: '1 bowl', kcal: 35 }] }],
  banana: [{ name: 'Banana, medium', servings: [{ label: '1 medium', kcal: 105 }, { label: '100 g', kcal: 89 }] }],
  oat: [{ name: 'Oatmeal, cooked', servings: [{ label: '1 cup', kcal: 166 }, { label: '100 g', kcal: 71 }] }],
  yogurt: [{ name: 'Greek yogurt, plain', servings: [{ label: '1 container (170 g)', kcal: 100 }, { label: '100 g', kcal: 59 }] }],
  cheese: [{ name: 'Cheese, mozzarella', servings: [{ label: '1 slice (28 g)', kcal: 85 }, { label: '100 g', kcal: 300 }] }],
  lasagna: [{ name: 'Lasagna, family tray', servings: [{ label: '1 tray', kcal: 1700 }, { label: '1 cup', kcal: 300 }] }],
  pizza: [{ name: 'Pizza, pepperoni, large', servings: [{ label: '1 pizza', kcal: 2300 }, { label: '1 slice', kcal: 290 }] }],
  juice: [{ name: 'Orange juice', servings: [{ label: '1 cup', kcal: 112 }] }],
  sandwich: [
    { name: 'Club sandwich', servings: [{ label: '1 sandwich', kcal: 590 }] },
    { name: 'Ham and cheese sandwich', servings: [{ label: '1 sandwich', kcal: 350 }] },
    { name: 'Chicken sandwich', servings: [{ label: '1 sandwich', kcal: 450 }] },
  ],
};
const SYNONYMS: Record<string, string> = { eggs: 'egg', huevo: 'egg', huevos: 'egg', tostada: 'toast', tostadas: 'toast', pan: 'bread', cafe: 'coffee', 'café': 'coffee', arroz: 'rice', pollo: 'chicken', ensalada: 'salad', banano: 'banana', avena: 'oat', oatmeal: 'oat', yogur: 'yogurt', queso: 'cheese', lasana: 'lasagna', 'lasaña': 'lasagna', jugo: 'juice', arepas: 'arepa' };

export interface DiaryEntry {
  meal: string;
  name: string;
  calories: number;
}

export interface Action {
  app: 'mfp' | 'finance';
  op: string;
  detail: string;
}

export interface ReplicaState {
  diary: DiaryEntry[];
  pins: { query: string; name: string; serving: string; kcalPerServing: number }[];
  actions: Action[];
  /** Every tool call (reads too), for counting. */
  calls: string[];
  movements: Rec[];
}

const MEALS: Record<string, string> = { breakfast: 'Breakfast', desayuno: 'Breakfast', lunch: 'Lunch', almuerzo: 'Lunch', dinner: 'Dinner', cena: 'Dinner', snacks: 'Snacks', snack: 'Snacks', onces: 'Snacks', merienda: 'Snacks' };
const mealOf = (m: unknown) => {
  const k = String(m ?? 'breakfast').toLowerCase();
  if (!MEALS[k]) throw new Error(`Unknown meal '${m}'. Valid meals: Breakfast, Lunch, Dinner, Snacks`);
  return MEALS[k]!;
};

export async function startMasonReplica(state: ReplicaState, today: string) {
  const drafts = new Map<string, { query: string; quantity: number; meal: string; day: string; options: Food[] }>();
  const record = (op: string, detail: string) => state.actions.push({ app: 'mfp', op, detail });
  const lookup = (query: string): Food[] => {
    const words = query.toLowerCase().normalize('NFC').split(/[^a-záéíóúñ]+/).filter(Boolean);
    for (const w of words) {
      const key = FOODS[w] ? w : SYNONYMS[w];
      if (key && FOODS[key]) return FOODS[key]!;
    }
    for (const key of Object.keys(FOODS)) if (query.toLowerCase().includes(key)) return FOODS[key]!;
    throw new Error(`no MyFitnessPal food found for '${query}'`);
  };
  const dayRecord = (day = today) => ({
    day,
    nutrition: { day, calories: Math.round(state.diary.reduce((a, e) => a + e.calories, 0)), protein: null, carbs: null, fat: null, water_ml: null, weight: null, goal_calories: 2200 },
    diary: state.diary.map((e) => ({ meal: e.meal, name: e.name, calories: e.calories, protein: null, carbs: null, fat: null })),
    note: null,
    feel: null,
  });
  const draftView = (draft_id: string, d: { query: string; quantity: number; meal: string; day: string; options: Food[] }) => ({
    draft_id,
    query: d.query,
    day: d.day,
    meal: d.meal.toLowerCase(),
    quantity: d.quantity,
    targets: {},
    options: d.options.map((o, n) => ({
      option: n + 1,
      name: o.name,
      brand: null,
      verified: true,
      pinned: state.pins.some((p) => p.query === d.query && p.name === o.name),
      fits_targets: true,
      suggested_serving: 0,
      servings: o.servings.map((s, i) => ({ serving: i, label: s.label, calories: Math.round(s.kcal * d.quantity), protein: null, carbs: null, fat: null, fits_targets: true })),
    })),
  });
  const logEntry = (name: string, serving: string, kcal: number, quantity: number, meal: string, source: string) => {
    state.diary.push({ meal, name, calories: Math.round(kcal) });
    record('log', `${meal}: ${name} × ${quantity} [${serving}] = ${Math.round(kcal)} kcal`);
    return { ok: true, logged: name, food_id: 'f', weight_id: 'w', serving, quantity, meal: meal.toLowerCase(), date: today, source, day: dayRecord() };
  };

  const handlers: Record<string, Handler> = {
    fitness_get_day: (a) => dayRecord(String(a.date ?? today)),
    fitness_search_food: (a) => ({
      query: a.query,
      results: lookup(String(a.query)).map((f) => ({ name: f.name, brand: null, calories: f.servings[0]!.kcal, protein: null, carbs: null, fat: null, serving: f.servings[0]!.label, verified: true, food_id: `${f.name}`, weight_id: '0' })),
    }),
    fitness_draft_food: (a) => {
      const id = `d${drafts.size + 1}`;
      const d = { query: String(a.query), quantity: Number(a.quantity ?? 1), meal: mealOf(a.meal), day: String(a.date ?? today), options: lookup(String(a.query)) };
      drafts.set(id, d);
      return draftView(id, d);
    },
    fitness_log_food: (a) => {
      if (a.draft_id) {
        const d = drafts.get(String(a.draft_id));
        if (!d) throw new Error(`draft '${a.draft_id}' not found or expired (drafts last 24 hours); call fitness_draft_food again`);
        const opt = d.options[Number(a.option ?? 0) - 1];
        if (!opt) throw new Error(`option must be between 1 and ${d.options.length}`);
        const idx = a.serving === undefined || a.serving === null ? 0 : Number(a.serving);
        const s = opt.servings[idx];
        if (!s) throw new Error(`serving must be between 0 and ${opt.servings.length - 1} for option ${a.option}`);
        const q = a.quantity === undefined || a.quantity === null ? d.quantity : Number(a.quantity);
        if (a.pin !== false) {
          state.pins = state.pins.filter((p) => p.query !== d.query);
          state.pins.push({ query: d.query, name: opt.name, serving: s.label, kcalPerServing: s.kcal });
        }
        return logEntry(opt.name, s.label, s.kcal * q, q, a.meal ? mealOf(a.meal) : d.meal, 'draft');
      }
      if (a.food_id) {
        const f = Object.values(FOODS).flat().find((x) => x.name === a.food_id);
        if (!f) throw new Error(`unknown food_id ${a.food_id}`);
        const q = Number(a.quantity ?? 1);
        return logEntry(f.name, f.servings[0]!.label, f.servings[0]!.kcal * q, q, mealOf(a.meal), 'ids');
      }
      if (a.query) {
        const q = Number(a.quantity ?? 1);
        const pin = state.pins.find((p) => p.query.toLowerCase() === String(a.query).toLowerCase());
        if (pin) return logEntry(pin.name, pin.serving, pin.kcalPerServing * q, q, mealOf(a.meal), 'pin');
        const id = `d${drafts.size + 1}`;
        const d = { query: String(a.query), quantity: q, meal: mealOf(a.meal), day: today, options: lookup(String(a.query)) };
        drafts.set(id, d);
        return { ok: true, logged: null, needs_choice: true, ...draftView(id, d) };
      }
      throw new Error('pass draft_id + option, food_id + weight_id, or query');
    },
    fitness_list_food_pins: () => ({ pins: state.pins.map((p) => ({ query: p.query, name: p.name, serving: p.serving })) }),
    fitness_clear_food_pin: (a) => {
      const before = state.pins.length;
      state.pins = a.clear_all ? [] : state.pins.filter((p) => p.query !== a.query);
      record('clear_pin', String(a.query ?? 'all'));
      return { cleared: before - state.pins.length };
    },
    fitness_delete_food: (a) => {
      const meal = a.meal ? mealOf(a.meal) : undefined;
      const q = String(a.query).toLowerCase();
      const matches = state.diary.filter((e) => e.name.toLowerCase().includes(q) && (!meal || e.meal === meal));
      if (!matches.length) throw new Error(`No entry matching '${a.query}'. Logged: ${state.diary.filter((e) => !meal || e.meal === meal).map((e) => `${e.name} (${e.meal})`).join(', ') || 'nothing'}`);
      const exact = matches.filter((e) => e.name.toLowerCase() === q);
      if (matches.length > 1 && exact.length !== 1) throw new Error(`'${a.query}' matches more than one entry: ${matches.map((e) => `${e.name} (${e.meal})`).join(', ')}; narrow the query`);
      const entry = exact[0] ?? matches[0]!;
      state.diary.splice(state.diary.indexOf(entry), 1);
      record('delete', `${entry.meal}: ${entry.name}`);
      return { removed: entry.name, meal: entry.meal.toLowerCase() };
    },
    fitness_modify_food: (a) => {
      const meal = mealOf(a.meal);
      const entry = state.diary.find((e) => e.meal === meal && e.name.toLowerCase().includes(String(a.query).toLowerCase()));
      if (!entry) throw new Error(`No entry matching '${a.query}' in ${meal}`);
      if (a.quantity !== undefined && a.quantity !== null && !a.new_query && !a.draft_id) {
        const per = Object.values(FOODS).flat().find((f) => f.name === entry.name)?.servings[0]?.kcal ?? entry.calories;
        const pin = state.pins.find((p) => p.name === entry.name);
        entry.calories = Math.round((pin?.kcalPerServing ?? per) * Number(a.quantity));
        record('modify', `${meal}: ${entry.name} → × ${a.quantity} = ${entry.calories} kcal`);
        return { ok: true, modified: entry.name, quantity: a.quantity, meal: meal.toLowerCase(), date: today, day: dayRecord() };
      }
      state.diary.splice(state.diary.indexOf(entry), 1);
      const replaced = a.draft_id ? (handlers.fitness_log_food!({ draft_id: a.draft_id, option: a.option, serving: a.serving, quantity: a.quantity, meal: a.meal }) as Rec) : null;
      record('modify', `${meal}: ${entry.name} → ${replaced ? replaced.logged : String(a.new_query)}`);
      return { removed: entry.name, ...(replaced ?? { logged: a.new_query }) };
    },
    fitness_log_weight: (a) => (record('weight', `${a.weight} ${a.unit ?? 'kg'}`), { day: a.date ?? today, weight: a.weight, unit: a.unit ?? 'kg' }),
    fitness_log_water: (a) => (record('water', `${a.amount ?? a.ml} ${a.unit ?? 'ml'}${a.replace ? ' (replace)' : ''}`), { day: a.date ?? today, ok: true }),
    fitness_get_exercise: () => ({ day: today, exercise: [] }),
    fitness_get_exercise_entries: () => ({ day: today, entries: [] }),
    fitness_delete_exercise: (a) => {
      throw new Error(`No exercise matching '${a.query}'`);
    },
    fitness_get_note: () => ({ day: today, note: null }),
    fitness_log_note: (a) => (record('note', String(a.note ?? a.text)), { ok: true }),
    fitness_log_feel: (a) => (record('feel', String(a.note ?? a.feel ?? '')), { ok: true }),
    fitness_get_trends: (a) => ({ metric: a.metric, points: [] }),
    fitness_bulk_export: () => ({ days: [dayRecord()] }),
  };
  const traced = Object.fromEntries(Object.entries(handlers).map(([k, h]) => [k, (a: Rec) => (state.calls.push(k), h(a))]));
  return serveMcp('mfp-mcp', fixture('mason-tools.json'), traced);
}

/* ------------------------------------------------------------------ finance-app */

export const ACCOUNTS = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Nequi', currency: 'COP', type: 'bank', balance: 850000 },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Bancolombia', currency: 'COP', type: 'bank', balance: 3200000 },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Nu México', currency: 'MXN', type: 'bank', balance: 12400 },
];
export const POCKETS = [
  { id: 'aaaaaaaa-1111-4111-8111-111111111111', accountId: ACCOUNTS[0]!.id, name: 'Disponible', balance: 850000 },
  { id: 'aaaaaaaa-2222-4222-8222-222222222222', accountId: ACCOUNTS[1]!.id, name: 'Principal', balance: 2900000 },
  { id: 'aaaaaaaa-2222-4222-8222-333333333333', accountId: ACCOUNTS[1]!.id, name: 'Ahorro', balance: 300000 },
  { id: 'aaaaaaaa-3333-4333-8333-111111111111', accountId: ACCOUNTS[2]!.id, name: 'Disponible', balance: 12400 },
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ferr = (code: string, message: string, retryable = false) => ({ error: { code, message, retryable } });

export async function startFinanceReplica(state: ReplicaState, today: string, token: string) {
  const acc = (id: unknown) => ACCOUNTS.find((a) => a.id === id);
  const pocket = (id: unknown) => POCKETS.find((p) => p.id === id);
  const record = (op: string, detail: string) => state.actions.push({ app: 'finance', op, detail });
  let seq = state.movements.length;
  const handlers: Record<string, Handler> = {
    finance_list_accounts: () => ({ result: ACCOUNTS }),
    finance_list_pockets: (a) => ({ result: POCKETS.filter((p) => !a.accountId || p.accountId === a.accountId) }),
    finance_list_movements: (a) => {
      let list = [...state.movements].reverse();
      if (a.year && a.month) list = list.filter((m) => String(m.displayedDate).startsWith(`${a.year}-${String(a.month).padStart(2, '0')}`));
      if (a.accountId) list = list.filter((m) => m.accountId === a.accountId);
      const limit = Math.min(Number(a.limit ?? 50), 200);
      const page = Number(a.page ?? 1);
      return { result: list.slice((page - 1) * limit, page * limit), page, total: list.length };
    },
    finance_spending_summary: () => {
      const month = today.slice(0, 7);
      const sum = (pred: (m: Rec) => boolean) => state.movements.filter(pred).reduce((s, m) => s + Number(m.amount), 0);
      const exp = (m: Rec) => String(m.type).startsWith('Egreso');
      return {
        currency: 'COP',
        today: { expenses: sum((m) => exp(m) && m.displayedDate === today), income: 0 },
        thisMonth: { expenses: sum((m) => exp(m) && String(m.displayedDate).startsWith(month)), income: sum((m) => !exp(m) && String(m.displayedDate).startsWith(month)) },
        lastMonth: { expenses: 1850000, income: 4200000 },
      };
    },
    finance_list_fixed_expenses: () => ({ result: [] }),
    finance_list_reminders: () => ({ result: [] }),
    finance_convert_currency: (a) => ({ amount: a.amount, from: a.fromCurrency, to: a.toCurrency, result: Number(a.amount) * (a.fromCurrency === 'MXN' && a.toCurrency === 'COP' ? 215 : 1) }),
    finance_create_movement: (a) => {
      const account = acc(a.accountId);
      const p = pocket(a.pocketId);
      if (!UUID.test(String(a.accountId)) || !account) return ferr('NOT_FOUND', `account ${a.accountId} not found`);
      if (!p || p.accountId !== account.id) return ferr('VALIDATION_ERROR', 'pocketId must be a pocket of accountId (see finance_list_pockets)');
      if (!(Number(a.amount) > 0)) return ferr('VALIDATION_ERROR', 'amount must be positive');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.displayedDate))) return ferr('VALIDATION_ERROR', 'displayedDate must be YYYY-MM-DD');
      const m = { id: `${String(++seq).padStart(8, '0')}-0000-4000-8000-000000000000`, ...a };
      state.movements.push(m);
      record('create', `${a.type} ${a.amount} ${account.currency} ${account.name}/${p.name} ${a.displayedDate}`);
      return m;
    },
    finance_create_transfer: (a) => {
      const s = acc(a.sourceAccountId);
      const t = acc(a.targetAccountId);
      const sp = pocket(a.sourcePocketId);
      const tp = pocket(a.targetPocketId);
      if (!s || !t) return ferr('NOT_FOUND', 'account not found');
      if (!sp || sp.accountId !== s.id || !tp || tp.accountId !== t.id) return ferr('VALIDATION_ERROR', 'pockets must belong to their accounts');
      if (!(Number(a.amount) > 0)) return ferr('VALIDATION_ERROR', 'amount must be positive');
      record('transfer', `${a.amount} ${s.name}/${sp.name} → ${t.name}/${tp.name} ${a.displayedDate}`);
      return { ok: true, sourceMovementId: 'x', targetMovementId: 'y' };
    },
    finance_update_movement: (a) => {
      const m = state.movements.find((x) => x.id === a.id);
      if (!m) return ferr('NOT_FOUND', `movement ${a.id} not found`);
      Object.assign(m, Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'id')));
      record('update', `${a.id}: ${JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'id')))}`);
      return m;
    },
    finance_delete_movement: (a) => {
      const i = state.movements.findIndex((x) => x.id === a.id);
      if (i < 0) return ferr('NOT_FOUND', `movement ${a.id} not found`);
      const [m] = state.movements.splice(i, 1);
      record('delete', `${m!.type} ${m!.amount} ${acc(m!.accountId)?.name}`);
      return { deleted: a.id };
    },
    finance_apply_pending_movement: (a) => (record('apply_pending', String(a.id)), { ok: true }),
    finance_mark_reminder_paid: (a) => (record('reminder_paid', String(a.reminderId)), { ok: true }),
  };
  const traced = Object.fromEntries(Object.entries(handlers).map(([k, h]) => [k, (a: Rec) => (state.calls.push(k), h(a))]));
  return serveMcp('finance-app', fixture('finance-tools.json'), traced, token);
}
