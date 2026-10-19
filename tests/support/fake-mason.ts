import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';

/**
 * Fake Mason (MyFitnessPal MCP) with the real tool contract (mfp-mcp 0.4.1):
 * draft → numbered options, each with every serving and its calories for the WHOLE entry
 * (serving × draft quantity); log returns the refreshed day record; failures are thrown
 * (MCP isError text), as Mason does.
 */
export interface DiaryEntry {
  meal: string;
  name: string;
  calories: number;
}

const CATALOG: Record<string, { name: string; servings: { label: string; kcal: number }[] }[]> = {
  egg: [
    { name: 'Egg omelette, restaurant', servings: [{ label: '1 omelette', kcal: 850 }] },
    { name: 'Egg, whole, large', servings: [{ label: '100 g', kcal: 143 }, { label: '1 large egg', kcal: 72 }] },
  ],
  bread: [{ name: 'Bread, whole wheat', servings: [{ label: '1 slice', kcal: 80 }, { label: '100 g', kcal: 250 }] }],
  coffee: [{ name: 'Coffee, black', servings: [{ label: '1 cup', kcal: 2 }] }],
  lasagna: [{ name: 'Lasagna, family tray', servings: [{ label: '1 tray', kcal: 1700 }, { label: '1 cup', kcal: 300 }] }],
  arepa: [{ name: 'Arepa, corn', servings: [{ label: '1 arepa', kcal: 220 }] }],
  rice: [{ name: 'Rice, white, cooked', servings: [{ label: '1 cup', kcal: 205 }, { label: '100 g', kcal: 130 }] }],
  sandwich: [
    { name: 'Club sandwich', servings: [{ label: '1 sandwich', kcal: 590 }] },
    { name: 'Ham and cheese sandwich', servings: [{ label: '1 sandwich', kcal: 350 }] },
    { name: 'Chicken sandwich', servings: [{ label: '1 sandwich', kcal: 450 }] },
  ],
};

export interface FakeMason {
  url: string;
  diary: DiaryEntry[];
  calls: { tool: string; input: Record<string, unknown> }[];
  /** After this many successful deletes, every call fails with an expired session. */
  expireSessionAfterDeletes?: number;
  close(): Promise<void>;
}

export async function startFakeMason(initial: DiaryEntry[] = []): Promise<FakeMason> {
  const state: FakeMason = { url: '', diary: [...initial], calls: [], close: async () => {} };
  const drafts = new Map<string, { query: string; quantity: number; meal: string; options: (typeof CATALOG)[string] }>();
  let deletes = 0;
  const today = '2026-10-19';
  const dayRecord = () => ({
    day: today,
    nutrition: { calories: state.diary.reduce((a, e) => a + e.calories, 0) },
    diary: state.diary.map((e) => ({ ...e })),
  });
  const record = (tool: string, input: unknown) => {
    state.calls.push({ tool, input: (input ?? {}) as Record<string, unknown> });
    if (state.expireSessionAfterDeletes !== undefined && deletes >= state.expireSessionAfterDeletes) {
      throw new Error('Session expired: auto-refresh failed. Run `mfp-mcp auth` to log in again.');
    }
  };
  const lookup = (query: string) => {
    const key = Object.keys(CATALOG).find((k) => query.toLowerCase().includes(k));
    if (!key) throw new Error(`no MyFitnessPal food found for '${query}'`);
    return CATALOG[key]!;
  };
  const any = z.object({}).passthrough();

  const tools = {
    fitness_get_day: createTool({
      id: 'fitness_get_day',
      description: 'Nutrition totals and diary entries for a day',
      inputSchema: z.object({ date: z.string().optional() }),
      mcp: { annotations: { readOnlyHint: true } },
      execute: async (i) => (record('fitness_get_day', i), dayRecord()),
    }),
    fitness_search_food: createTool({
      id: 'fitness_search_food',
      description: 'Search foods',
      inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
      mcp: { annotations: { readOnlyHint: true } },
      execute: async (i) => {
        record('fitness_search_food', i);
        return {
          query: i.query,
          results: lookup(i.query).map((f, n) => ({ name: f.name, calories: f.servings[0]!.kcal, food_id: `f${n}`, weight_id: `w${n}`, serving: f.servings[0]!.label })),
        };
      },
    }),
    fitness_draft_food: createTool({
      id: 'fitness_draft_food',
      description: 'Draft a food entry: numbered options, every serving with calories for the whole entry',
      inputSchema: z.object({ query: z.string(), quantity: z.number().optional(), meal: z.string().optional(), date: z.string().optional() }),
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false } },
      execute: async (i) => {
        record('fitness_draft_food', i);
        const quantity = i.quantity ?? 1;
        const options = lookup(i.query);
        const draft_id = `d${drafts.size + 1}`;
        drafts.set(draft_id, { query: i.query, quantity, meal: i.meal ?? 'breakfast', options });
        return {
          draft_id,
          query: i.query,
          day: today,
          meal: i.meal ?? 'breakfast',
          quantity,
          targets: {},
          options: options.map((o, n) => ({
            option: n + 1,
            name: o.name,
            brand: null,
            verified: true,
            pinned: false,
            fits_targets: true,
            suggested_serving: 0,
            servings: o.servings.map((s, idx) => ({ serving: idx, label: s.label, calories: s.kcal * quantity, protein: 1, carbs: 1, fat: 1, fits_targets: true })),
          })),
        };
      },
    }),
    fitness_log_food: createTool({
      id: 'fitness_log_food',
      description: 'Log a food to the real diary (draft_id+option+serving, or query)',
      inputSchema: z.object({
        query: z.string().optional(),
        meal: z.string().optional(),
        quantity: z.number().optional(),
        draft_id: z.string().optional(),
        option: z.number().optional(),
        serving: z.number().optional(),
        food_id: z.string().optional(),
        weight_id: z.string().optional(),
        pin: z.boolean().optional(),
        date: z.string().optional(),
      }),
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false } },
      execute: async (i) => {
        record('fitness_log_food', i);
        let name: string;
        let kcal: number;
        let meal: string;
        let quantity: number;
        let label: string;
        if (i.draft_id) {
          const d = drafts.get(i.draft_id);
          if (!d) throw new Error(`draft '${i.draft_id}' not found or expired; call fitness_draft_food again`);
          const opt = d.options[(i.option ?? 1) - 1];
          if (!opt) throw new Error(`option must be between 1 and ${d.options.length}`);
          const s = opt.servings[i.serving ?? 0]!;
          quantity = i.quantity ?? d.quantity;
          meal = i.meal ?? d.meal;
          name = opt.name;
          kcal = s.kcal * quantity;
          label = s.label;
        } else if (i.query) {
          const f = lookup(i.query)[0]!;
          quantity = i.quantity ?? 1;
          meal = i.meal ?? 'breakfast';
          name = f.name;
          kcal = f.servings[0]!.kcal * quantity;
          label = f.servings[0]!.label;
        } else throw new Error('pass draft_id + option, food_id + weight_id, or query');
        state.diary.push({ meal: cap(meal), name, calories: kcal });
        return { ok: true, logged: name, serving: label, quantity, meal, date: today, source: i.draft_id ? 'draft' : 'pin', day: dayRecord() };
      },
    }),
    fitness_delete_food: createTool({
      id: 'fitness_delete_food',
      description: 'Remove a diary entry by name match',
      inputSchema: z.object({ query: z.string(), meal: z.string().optional(), date: z.string().optional() }),
      mcp: { annotations: { readOnlyHint: false, destructiveHint: true } },
      execute: async (i) => {
        record('fitness_delete_food', i);
        const idx = state.diary.findIndex((e) => e.name.toLowerCase().includes(i.query.toLowerCase()) && (!i.meal || e.meal.toLowerCase() === i.meal.toLowerCase()));
        if (idx < 0) throw new Error(`No entry matching '${i.query}'. Logged: ${state.diary.map((e) => e.name).join(', ')}`);
        const [removed] = state.diary.splice(idx, 1);
        deletes++;
        return { removed: removed!.name, meal: removed!.meal };
      },
    }),
    fitness_modify_food: createTool({
      id: 'fitness_modify_food',
      description: 'Replace an entry or change its quantity',
      inputSchema: any,
      mcp: { annotations: { readOnlyHint: false, destructiveHint: true } },
      execute: async (i) => (record('fitness_modify_food', i), { ok: true }),
    }),
  };

  const mcp = new MCPServer({ id: 'mason', name: 'mason', version: '0.4.1-fake', tools });
  const server: Server = createServer((req, res) => {
    void mcp.startHTTP({ url: new URL(req.url ?? '/', 'http://127.0.0.1'), httpPath: '/mcp', req, res });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  state.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return state;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const MFP_REGISTRY = (url: string) => ({ servers: { mfp: { url, toolPrefix: 'fitness', errorStyle: 'mason' } } });
