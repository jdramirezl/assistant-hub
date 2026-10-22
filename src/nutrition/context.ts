/**
 * Long nutrition context (preferences, dislikes, schedule, meal-prep rules, backups, cinema
 * snacks, weight history, events…): NOT in every prompt. Sections are added to the request's
 * "## Now" tail only for planning / advice / "¿qué ceno?"-type questions, and for the digest.
 */
import type { Profile } from './profile.js';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

/** Any planning or advice question: loads the general sections. */
const ADVICE = /(\bque (ceno|como|almuerzo|desayuno|meriendo|hago de (cena|almuerzo|comer)|puedo (comer|cenar|almorzar)|me recomiendas|sugieres)\b|\bplan(ea|ear|eo|ifica|ificar)?\b|\bmeal ?prep|\bprepar(o|ar|amos)\b.{0,30}\b(semana|comida|almuerzos|cenas)|\bideas? de (comida|cena|almuerzo|desayuno|snack)|\brecomi[ee]nd|\bsugier|\bmenu\b|\bdieta\b|\bajust(e|ar)\b.{0,20}\bcalori|\bprogreso\b|\btendencia|\banalisis\b|\bwhat should i (eat|have)|\bmeal plan|\bcompras? del super|\blista de (compras|mercado|super))/;

/** Section → extra triggers (a section without one loads with ADVICE). */
const TRIGGERS: Record<string, RegExp> = {
  preferences: ADVICE,
  dislikes: ADVICE,
  meal_prep: /\bmeal ?prep|\bprepar|\bcongel|\bfreezer|\bporciones|\breceta|\binstant pot|\bair ?fryer/,
  backups: /\bbackup|\bno tengo (nada|comida)|\bque hay (para|de) comer|\bemergencia|\brapido de cenar|\bsin cocinar/,
  schedule: /\bhorario|\bentreno|\bgimnasia|\bpre ?entreno|\bpost ?entreno|\bantes de (entrenar|gimnasia)/,
  weight: /\bpeso\b|\bpese\b|\bbascula|\bkilos?\b|\bkg\b|\bgrasa corporal|\bprogreso|\btendencia|\bbajando|\bsubiendo|\bestancad/,
  events: /\bcompetencia|\bcompetir|\btorneo|\bevento|\bviaje|\bvacacion|\bfiesta|\bcumple/,
  cinema_snacks: /\bcine\b|\bcrispetas|\bpalomitas|\bpopcorn|\bdulces de cine|\bpelicula/,
  restaurants: /\brestaurante|\bpedir (comida|a domicilio)|\bdomicilio|\brappi|\buber eats|\bcomer fuera/,
  sick: /\benferm|\bgripa|\bresfriad|\bmal del estomago|\bme siento mal/,
};

/** The sections this message needs, as one block ('' for none). */
export function contextFor(profile: Profile | undefined, text: string | undefined): string {
  if (!profile) return '';
  const t = norm(text ?? '');
  if (!t.trim()) return '';
  const advice = ADVICE.test(t);
  const picked = Object.entries(profile.context).filter(([k]) => {
    const trig = TRIGGERS[k];
    return trig ? trig.test(t) || (advice && (k === 'preferences' || k === 'dislikes')) : advice;
  });
  if (!picked.length) return '';
  return ['## Nutrition context (private; use only to answer this message)', ...picked.map(([k, v]) => `### ${k}\n${v.trim()}`)].join('\n');
}

/** Everything, for the weekly digest and the future meal-plan feature. */
export function fullContext(profile: Profile | undefined): string {
  if (!profile) return '';
  return Object.entries(profile.context)
    .map(([k, v]) => `### ${k}\n${v.trim()}`)
    .join('\n');
}
