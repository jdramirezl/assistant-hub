/**
 * Hub-local nutrition tools: save_food (the user agreed to save a food or a recipe in their
 * dictionary) and set_day_type (the user said whether today is a training day).
 */
import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import type { FoodBook } from './book.js';
import type { DayPlanner } from './day.js';

const Item = z.object({ query: z.string().min(1), quantity: z.number().positive(), unit: z.string().min(1), kcal: z.number().nonnegative(), protein: z.number().nonnegative().optional() });

export function createSaveFood(book: FoodBook, log: (m: string) => void = () => {}) {
  return createTool({
    id: 'save_food',
    description:
      "Save a food (or a recipe) in the user's food dictionary so it is logged the same way next time. Only after the user agreed (e.g. to a dictionary_proposal). " +
      'Food: name (the user\'s word), aliases, query (the MFP search that worked), unit, kcal per unit. Recipe: name, aliases, portion, items (one portion, each logged as its own entry).',
    inputSchema: z.object({
      kind: z.enum(['food', 'recipe']).default('food'),
      name: z.string().min(1),
      aliases: z.array(z.string().min(1)).max(8).optional(),
      query: z.string().min(1).optional().describe('food: the MFP search, e.g. "Tamal de rajas"'),
      unit: z.string().min(1).optional().describe('food: unit, g, scoop, pack…'),
      kcal: z.number().nonnegative().optional().describe('food: kcal per unit'),
      protein: z.number().nonnegative().optional(),
      portion: z.string().optional().describe('recipe: what one portion is'),
      items: z.array(Item).max(15).optional().describe('recipe: ingredients of ONE portion'),
    }),
    execute: async (i) => {
      if (i.kind === 'recipe') {
        if (!i.items?.length) return { error: { code: 'VALIDATION_ERROR', message: 'a recipe needs items (one portion)', retryable: false } };
        await book.learnRecipe({ name: i.name, aliases: i.aliases ?? [], portion: i.portion, items: i.items });
        log(`[nutrition] saved a recipe (${i.items.length} items)`);
        return { saved: 'recipe', name: i.name, items: i.items.length };
      }
      if (!i.query || !i.unit || i.kcal === undefined) return { error: { code: 'VALIDATION_ERROR', message: 'a food needs query, unit and kcal', retryable: false } };
      await book.learn({ name: i.name, aliases: i.aliases ?? [], query: i.query, unit: i.unit, kcal: i.kcal, ...(i.protein !== undefined ? { protein: i.protein } : {}) });
      log('[nutrition] saved a food in the dictionary');
      return { saved: 'food', name: i.name };
    },
  });
}

export function createSetDayType(planner: DayPlanner, today: () => string) {
  return createTool({
    id: 'set_day_type',
    description: 'Record whether the user trains today (or on a date): rest, gimnasia (gymnastics) or pesas (weights). Call it when the user tells you; returns that day\'s targets.',
    inputSchema: z.object({ type: z.enum(['rest', 'gimnasia', 'pesas']), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    execute: async ({ type, date }) => {
      const d = date ?? today();
      await planner.set(d, type);
      const t = planner.target(type);
      return { date: d, day_type: type, target_kcal: t.kcal[0] === t.kcal[1] ? t.kcal[0] : `${t.kcal[0]}–${t.kcal[1]}`, target_protein_g: `${t.protein[0]}–${t.protein[1]}` };
    },
  });
}
