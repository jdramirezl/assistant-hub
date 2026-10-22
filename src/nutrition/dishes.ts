/**
 * Proactive decomposition: complex or restaurant dishes are logged as their COMPONENTS (each its
 * own MFP entry, with a standard portion), never as one generic entry, so the user can change
 * one quantity and the calories add up on their own. Templates for the recurring ones live here
 * (generic food knowledge, no user data); any other composite dish is sent back to the model to
 * be broken into parts.
 */
import { normFood } from './book.js';

export interface DishComponent {
  query: string;
  quantity: number;
  unit: string;
  kcal: number;
  protein?: number;
  /** What the user sees ("tortilla de harina grande"). */
  label: string;
}

export interface Dish {
  name: string;
  /** All words of one alias must appear in the query. */
  aliases: string[];
  components: DishComponent[];
}

export const DISHES: Dish[] = [
  {
    name: 'burrito de pastor',
    aliases: ['burrito al pastor', 'burrito de pastor', 'pastor burrito', 'al pastor burrito', 'burrito pastor'],
    components: [
      { label: 'tortilla de harina grande', query: 'Flour tortilla, burrito size', quantity: 1, unit: 'unit', kcal: 220, protein: 6 },
      { label: 'carne al pastor', query: 'Al pastor pork', quantity: 90, unit: 'g', kcal: 190, protein: 15 },
      { label: 'papa', query: 'Potato, fried cubes', quantity: 60, unit: 'g', kcal: 90, protein: 1 },
      { label: 'queso', query: 'Oaxaca cheese', quantity: 25, unit: 'g', kcal: 80, protein: 6 },
      { label: 'cebolla', query: 'Onion, raw', quantity: 20, unit: 'g', kcal: 8 },
      { label: 'grasa de plancha', query: 'Vegetable oil', quantity: 1, unit: 'tsp', kcal: 40 },
    ],
  },
  {
    name: 'tacos al pastor',
    aliases: ['tacos al pastor', 'taco al pastor', 'tacos de pastor', 'taco de pastor', 'pastor tacos', 'al pastor tacos'],
    components: [
      { label: 'tortilla de maíz', query: 'Corn tortilla', quantity: 1, unit: 'unit', kcal: 52, protein: 1 },
      { label: 'carne al pastor', query: 'Al pastor pork', quantity: 40, unit: 'g', kcal: 85, protein: 7 },
      { label: 'cebolla', query: 'Onion, raw', quantity: 10, unit: 'g', kcal: 4 },
      { label: 'piña', query: 'Pineapple', quantity: 10, unit: 'g', kcal: 5 },
      { label: 'grasa de plancha', query: 'Vegetable oil', quantity: 0.25, unit: 'tsp', kcal: 10 },
    ],
  },
  {
    name: 'bandeja paisa',
    aliases: ['bandeja paisa', 'paisa platter', 'paisa tray'],
    components: [
      { label: 'arroz blanco', query: 'Rice, white, cooked', quantity: 1, unit: 'cup', kcal: 205, protein: 4 },
      { label: 'fríjoles', query: 'Red beans, cooked', quantity: 1, unit: 'cup', kcal: 225, protein: 15 },
      { label: 'carne molida', query: 'Ground beef, cooked', quantity: 80, unit: 'g', kcal: 200, protein: 20 },
      { label: 'chicharrón', query: 'Chicharron, fried pork belly', quantity: 50, unit: 'g', kcal: 270, protein: 8 },
      { label: 'chorizo', query: 'Chorizo', quantity: 1, unit: 'unit', kcal: 170, protein: 9 },
      { label: 'huevo frito', query: 'Egg, fried', quantity: 1, unit: 'unit', kcal: 90, protein: 6 },
      { label: 'plátano maduro', query: 'Plantain, ripe, fried', quantity: 100, unit: 'g', kcal: 230, protein: 1 },
      { label: 'arepa pequeña', query: 'Arepa, white corn', quantity: 50, unit: 'g', kcal: 110, protein: 2 },
      { label: 'aguacate', query: 'Avocado', quantity: 50, unit: 'g', kcal: 80, protein: 1 },
    ],
  },
];

const words = (s: string) => normFood(s).split(' ').filter(Boolean);

export function matchDish(query: string): Dish | undefined {
  const q = new Set(words(query));
  return DISHES.find((d) => d.aliases.some((a) => words(a).every((w) => q.has(w))));
}

export const dishKcal = (d: Dish) => d.components.reduce((a, c) => a + c.kcal, 0);

/** Restaurant / composite dishes that must be broken into parts. */
const COMPOSITE = /\b(burritos?|tacos?|bandeja|hamburguesas?|burgers?|hamburgers?|quesadillas?|enchiladas?|gringas?|huaraches?|sopes?|chilaquiles|alambre|poke|ramen|paella|sushi rolls?|pad thai|combo|plato tipico|corrientazo|ejecutivo)\b/;
/** …unless the query already names a component ("flour tortilla, burrito size", "taco shell"). */
const COMPONENT = /\b(tortillas?|shells?|buns?|bread|pan|wrap|meat|carne|cheese|queso|sauce|salsa|rice|arroz|beans|frijoles|patty|carne molida|oil|aceite)\b/;

export function isCompositeDish(query: string): boolean {
  const q = normFood(query);
  return COMPOSITE.test(q) && !COMPONENT.test(q);
}
