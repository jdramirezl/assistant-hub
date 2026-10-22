/**
 * Nutrition prompt pieces. STYLE_RULES and DECOMPOSITION go with the fitness rules (stable
 * prefix); the dictionary/recipe list follows them (changes only when Alfred learns a food).
 */
import type { FoodBook } from './book.js';
import { DISHES } from './dishes.js';

export const STYLE_RULES = [
  '## Nutrition style',
  '- Simple questions ("¿cuánto sirvo?", "¿cuántas calorías?", "¿me cabe esto?", "¿qué pongo en MFP?"): a short, direct answer with numbers. Plans, progress and meal prep may be longer.',
  '- Never moralize or dramatize food (pizza, alcohol, sweets, popcorn, fast food are not "bad"); judge in the weekly context.',
  '- No aggressive compensation after a big day; look at 2–3 week trends, never one day or one weigh-in. Do not add exercise calories back as permission to eat more.',
  '- Always distinguish raw vs cooked, bone vs edible meat, dry flour vs masa, dry vs cooked rice and pasta.',
  '- An uncertain range: use the midpoint and say so in a few words ("asumí ~140 g comestibles").',
  '- Before adding, check the day for duplicates (log_meal reports possible_duplicates).',
  '- After logging, confirm briefly with the new day total vs target (day_total: kcal and protein).',
];

export const DECOMPOSITION = [
  '## Logging meals: decompose, assume, ask little',
  '- Complex or restaurant dishes are ALWAYS logged as their components with standard portions (each its own item), never as one generic entry: e.g. a burrito → large flour tortilla + meat + potato + cheese + onion + cooking fat. Dishes the hub knows by name (it expands them itself): ' + DISHES.map((d) => d.name).join(', ') + '. Saved recipes too (below): pass the recipe name with unit "serving" and the number of portions.',
  '- NEVER decompose branded or standardized products with published nutrition: chain menu items (McDonald\'s Big Mac or fries, Wingstop, Subway, KFC, Starbucks drinks…) and packaged products (Hershey\'s, Cornetto, M&M\'s, packaged snacks). Log ONE item named brand + item + size ("McDonald\'s Big Mac", "McDonald\'s French Fries, medium", "Hershey\'s Milk Chocolate bar"). Decompose only homemade, street or unbranded dishes (burrito de pastor callejero, bandeja paisa, tacos from a stand, home cooking). A decompose entry with not_in_mfp: that chain item is not in MFP; log its components and say so in one line.',
  '- The hub adds the usual extras itself and reports them in "assumed": cooking spray for foods cooked at home, and a 0-kcal drink when the meal names none. Put in ONE short line what was assumed; do not log them yourself.',
  '- For sofrito-style dishes the user cooked, include the usual onion/pimentón in the items.',
  '- At most ONE short question per meal, only when the answer changes the kcal materially; otherwise assume a midpoint, log, and say what you assumed.',
  '- "decompose": the hub refused a whole dish; call log_meal again with its components in this same turn (do not ask).',
  '- "dictionary_proposal": offer in one line to save that food for next time; call save_food only if the user agrees. Recurring recipes can be offered the same way (save_food kind "recipe"). Never offer one-off foods.',
];

/** The user's dictionary and recipes, compact (names and kcal; no targets, no context). */
export async function dictionaryPrompt(book: FoodBook): Promise<string> {
  if (!book.enabled) return '';
  const foods = await book.foods();
  const recipes = await book.recipes();
  const lines = ['## The user\'s foods (use these names as query; the hub knows their MFP entry and kcal)'];
  if (foods.length) lines.push(foods.map((f) => `${f.name}${f.aliases.length ? ` (${f.aliases.slice(0, 2).join(', ')})` : ''}: ${Math.round(f.kcal * 10) / 10} kcal/${f.per_unit ? `${f.unit}` : f.unit}${f.default_quantity ? `, default ${f.default_quantity}` : ''}`).join('; '));
  if (recipes.length) lines.push(`Saved recipes (per portion): ${recipes.map((r) => `${r.name}${r.portion ? ` [${r.portion}]` : ''} ~${Math.round(r.items.reduce((a, i) => a + i.kcal, 0))} kcal`).join('; ')}`);
  return lines.join('\n');
}
