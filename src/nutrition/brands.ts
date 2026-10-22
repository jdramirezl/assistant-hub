/**
 * Branded / standardized products: never decomposed. A chain menu item (Big Mac, Wingstop,
 * Subway…) or a packaged product (Hershey's, Cornetto, M&M's…) has fixed, published nutrition in
 * MFP: it is logged as ONE entry matching brand + item + size. Only a chain item MFP does not
 * have falls back to components (and the user is told).
 */
import { normFood } from './book.js';

export interface Brand {
  brand: string;
  /** Normalized words that identify it in a query or an MFP option (name or brand). */
  keys: string[];
  /** A restaurant chain (not in MFP → decompose); otherwise a packaged product. */
  chain: boolean;
}

const B = (brand: string, chain: boolean, ...keys: string[]): Brand => ({ brand, chain, keys: keys.map(normFood) });

export const BRANDS: Brand[] = [
  B("McDonald's", true, 'mcdonald', 'mcdonalds', 'mc donalds', 'big mac', 'mcflurry', 'mcnuggets', 'mcpollo', 'mcmuffin', 'cuarto de libra', 'quarter pounder'),
  B('Burger King', true, 'burger king', 'whopper'),
  B('KFC', true, 'kfc', 'kentucky fried'),
  B("Wendy's", true, 'wendy', 'wendys'),
  B('Subway', true, 'subway'),
  B('Starbucks', true, 'starbucks', 'frappuccino'),
  B('Wingstop', true, 'wingstop'),
  B("Domino's", true, 'domino', 'dominos'),
  B('Pizza Hut', true, 'pizza hut'),
  B("Papa John's", true, 'papa john', 'papa johns'),
  B('Little Caesars', true, 'little caesars', 'little caesar'),
  B('Taco Bell', true, 'taco bell'),
  B('Chipotle', true, 'chipotle mexican grill', 'chipotle bowl', 'chipotle burrito'),
  B("Carl's Jr.", true, 'carls jr', 'carl s jr'),
  B("Popeyes", true, 'popeyes'),
  B('Dairy Queen', true, 'dairy queen', 'blizzard'),
  B('Krispy Kreme', true, 'krispy kreme'),
  B("Dunkin'", true, 'dunkin'),
  B('Juan Valdez', true, 'juan valdez'),
  B('Frisby', true, 'frisby'),
  B('El Corral', true, 'el corral'),
  B('Crepes & Waffles', true, 'crepes waffles', 'crepes y waffles'),
  B('Kokoriko', true, 'kokoriko'),
  B("Sam's Club", true, 'sams club', 'members mark'),
  B('Costco', true, 'costco', 'kirkland'),
  B('Vips', true, 'vips'),
  B('Toks', true, 'toks'),
  B('Sanborns', true, 'sanborns'),
  B("Hershey's", false, 'hershey', 'hersheys'),
  B("M&M's", false, 'm m s', 'm ms', 'mms', 'm and m'),
  B('Snickers', false, 'snickers'),
  B('Kit Kat', false, 'kit kat', 'kitkat'),
  B('Twix', false, 'twix'),
  B('Milky Way', false, 'milky way'),
  B('Skittles', false, 'skittles'),
  B('Cornetto', false, 'cornetto'),
  B('Magnum', false, 'magnum'),
  B('Oreo', false, 'oreo'),
  B('Doritos', false, 'doritos'),
  B('Cheetos', false, 'cheetos'),
  B('Takis', false, 'takis'),
  B('Sabritas', false, 'sabritas'),
  B('Ruffles', false, 'ruffles'),
  B("Lay's", false, 'lays'),
  B('Pringles', false, 'pringles'),
  B('Gansito', false, 'gansito'),
  B('Marinela', false, 'marinela'),
  B('Bimbo', false, 'bimbo'),
  B('Gamesa', false, 'gamesa', 'saladitas'),
  B('Maruchan', false, 'maruchan'),
  B('Red Bull', false, 'red bull'),
  B('Monster', false, 'monster energy'),
  B('Gatorade', false, 'gatorade'),
  B('Nutella', false, 'nutella'),
  B('Quest', false, 'quest bar'),
];

const has = (text: string, key: string) => ` ${text} `.includes(` ${key} `);

/** The brand a query names, or undefined. */
export function brandOf(query: string): Brand | undefined {
  const q = normFood(query.replace(/['’]/g, ''));
  return BRANDS.find((b) => b.keys.some((k) => has(q, k)));
}

/** Does an MFP option belong to this brand? Its brand field, or the brand name in its name (not just "Big Mac": a copycat recipe is not McDonald's). */
export function optionIsBrand(b: Brand, option: { name?: string; brand?: string | null }): boolean {
  const brand = normFood(b.brand.replace(/['’]/g, '')).replace(/ /g, '');
  const squash = (v: string | null | undefined) => normFood(String(v ?? '').replace(/['’]/g, '')).replace(/ /g, '');
  return squash(option.brand).includes(brand) || squash(option.name).includes(brand);
}
