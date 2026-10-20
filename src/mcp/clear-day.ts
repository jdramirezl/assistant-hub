/**
 * Hub-side composite: empty whole days or meals of the MyFitnessPal diary with ONE approval.
 * Mason has no clear-day tool, so the hub reads each day (fitness_get_day), builds a plan of
 * fitness_delete_food calls itself (one per entry, from the diary, so nothing is forgotten) and
 * shows it as ONE compact card (count + per-meal breakdown). After ✅ the plan service runs the
 * deletes in code, then the optional re-add (log_meal) — never 45 model-driven tool calls.
 */
import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import { LogMealInput } from './log-meal.js';
import type { PlanInput } from '../plans/types.js';
import type { Language } from '../persona.js';

type Rec = Record<string, unknown>;
export interface ClearDayDeps {
  toolbox: { execute(name: string, args: Rec, opts?: { raw?: boolean }): Promise<unknown> };
  propose(input: PlanInput, meta: { owner: string; threadId?: string; trusted?: boolean }): Promise<unknown>;
  today: () => string;
  language: Language;
  log?: (m: string) => void;
}

const MEALS = ['breakfast', 'lunch', 'dinner', 'snacks'] as const;
const MEAL_NAME: Record<string, { es: string; en: string }> = {
  breakfast: { es: 'Desayuno', en: 'Breakfast' },
  lunch: { es: 'Almuerzo', en: 'Lunch' },
  dinner: { es: 'Cena', en: 'Dinner' },
  snacks: { es: 'Merienda', en: 'Snacks' },
};
const mealKey = (m: unknown) => String(m ?? '').toLowerCase();

export const ClearDayInput = z.object({
  dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(7).optional().describe('Days to empty, YYYY-MM-DD; default today'),
  meals: z.array(z.enum(MEALS)).min(1).optional().describe('Only these meals; default the whole day'),
  then_log: LogMealInput.optional().describe('Foods to log AFTER the clear (same items as log_meal). Use this, not a separate log_meal call, or the clear would delete them'),
});

const errOf = (v: unknown) => (v && typeof v === 'object' && 'error' in (v as Rec) ? (v as Rec).error : undefined);

export function createClearDay(d: ClearDayDeps) {
  return createTool({
    id: 'clear_day',
    description:
      'Empty whole MyFitnessPal days or whole meals ("borra todo el desayuno", "limpia hoy y mañana") in ONE step: the hub reads the diary, ' +
      'shows the user ONE approval card with the count per meal, and after approval deletes every entry itself. Optionally re-adds foods afterwards (then_log). ' +
      'Use this instead of many fitness_delete_food calls or propose_plan for a whole day/meal. Reply one short line after it; the card is the message.',
    inputSchema: ClearDayInput,
    execute: async (input, ctx) => {
      const es = d.language === 'es';
      const dates = input.dates?.length ? [...new Set(input.dates)] : [d.today()];
      const meals = input.meals?.length ? new Set(input.meals) : undefined;
      const groups: PlanInput['groups'] = [];
      let total = 0;
      for (const date of dates) {
        const day = (await d.toolbox.execute('fitness_get_day', { date }, { raw: true })) as Rec;
        if (errOf(day)) return day;
        const diary = ((day.diary as Rec[] | undefined) ?? []).filter((e) => !meals || meals.has(mealKey(e.meal) as never));
        for (const meal of MEALS) {
          const entries = diary.filter((e) => mealKey(e.meal) === meal);
          if (!entries.length) continue;
          const kcal = Math.round(entries.reduce((a, e) => a + Number(e.calories ?? 0), 0));
          total += entries.length;
          groups.push({
            label: `${MEAL_NAME[meal]![d.language]} ${date}`,
            summary: `${entries.length} ${es ? (entries.length === 1 ? 'entrada' : 'entradas') : entries.length === 1 ? 'entry' : 'entries'}, ${kcal} kcal`,
            actions: entries.map((e) => ({ tool: 'fitness_delete_food', args: { query: String(e.name), meal, date }, summary: `${e.name} — ${Math.round(Number(e.calories ?? 0))} kcal` })),
          });
        }
        for (const x of ((day.exercise as Rec[] | undefined) ?? (day.exercises as Rec[] | undefined) ?? [])) {
          if (meals) break;
          total++;
          groups.push({ label: `${es ? 'Ejercicio' : 'Exercise'} ${date}`, summary: String(x.name ?? ''), actions: [{ tool: 'fitness_delete_exercise', args: { query: String(x.name), date }, summary: String(x.name) }] });
        }
      }
      if (input.then_log) {
        const items = input.then_log.items;
        const date = input.then_log.date ?? d.today();
        groups.push({
          label: es ? `Luego agregar (${date})` : `Then add (${date})`,
          summary: items.map((i) => i.query).join(', '),
          actions: [{ tool: 'log_meal', args: { ...input.then_log, date }, summary: items.map((i) => i.query).join(', ') }],
        });
      }
      if (!total && !input.then_log) return { status: 'nothing_to_delete', note: 'Those days/meals are already empty. Tell the user in one line.' };
      const title = es
        ? `Vaciar ${dates.join(' y ')}${meals ? ` (${[...meals].map((m) => MEAL_NAME[m]!.es.toLowerCase()).join(', ')})` : ''}: ${total} ${total === 1 ? 'entrada' : 'entradas'}`
        : `Clear ${dates.join(' and ')}${meals ? ` (${[...meals].join(', ')})` : ''}: ${total} ${total === 1 ? 'entry' : 'entries'}`;
      d.log?.(`[clear_day] ${dates.join(',')}${meals ? ` ${[...meals].join(',')}` : ''}: ${total} entries${input.then_log ? ` + re-add ${input.then_log.items.length}` : ''}`);
      const agent = (ctx as { agent?: { threadId?: string; resourceId?: string } } | undefined)?.agent;
      return d.propose({ title, groups, compact: true }, { owner: agent?.resourceId ?? 'dev:local', threadId: agent?.threadId, trusted: true });
    },
  });
}
