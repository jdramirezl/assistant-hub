import { describe, expect, it } from 'vitest';
import { rangeFromText, sanitizeRange } from '../src/cines/args.js';
import { claimsOf, hasEvidence } from '../src/guards/evidence.js';

const TZ = 'America/Bogota';
const WED = Date.parse('2026-10-21T20:00:00Z'); // Wednesday 15:00 in Bogotá

describe('date ranges (cines-mx-mcp 6d7c617)', () => {
  it('"hasta el domingo" → dateTo resolved; today is the start', () => {
    expect(rangeFromText('¿qué películas hay hasta el domingo?', TZ, WED)).toEqual({ date: '2026-10-21', dateTo: '2026-10-25' });
    expect(rangeFromText('qué hay este fin de semana', TZ, WED)).toEqual({ date: '2026-10-24', dateTo: '2026-10-25' });
    expect(rangeFromText('qué hay hoy en Toreo', TZ, WED)).toBeUndefined();
  });
  it('the model forgot the range: the hub adds it and drops a cinema the user did not name (a range = all cinemas)', () => {
    const r = sanitizeRange('cines_listings', { cinema: 'toreo', date: '2026-10-21' }, '¿qué películas hay hasta el domingo?', TZ, WED);
    expect(r.args).toEqual({ date: '2026-10-21', dateTo: '2026-10-25' });
    expect(r.changes.join(' ')).toMatch(/dateTo/);
    const named = sanitizeRange('cines_listings', { cinema: 'miyana' }, 'qué hay en Miyana hasta el domingo', TZ, WED);
    expect(named.args).toMatchObject({ cinema: 'miyana', dateTo: '2026-10-25' });
  });
  it('dateTo words are resolved, wrong years refused', () => {
    expect(sanitizeRange('cines_showtimes', { movie: 'x', date: 'hoy', dateTo: 'domingo' }, 'x hasta el domingo', TZ, WED).args).toMatchObject({ dateTo: '2026-10-25' });
    expect(sanitizeRange('cines_listings', { dateTo: '2025-10-25' }, 'hasta el 25', TZ, WED).error).toMatch(/in the past/);
  });
});

describe('"no está en cartelera" needs a found:false that it cites', () => {
  const prompt = (value: unknown) => [{ role: 'user', content: [{ type: 'text', text: '¿dónde dan Your Name?' }] }, { role: 'tool', content: [{ type: 'tool-result', toolName: 'cines_find_movie', output: { value } }] }];
  const miss = { found: false, searched: { from: '2026-10-22', to: '2026-10-29', cinemas: ['Cinépolis Parque Toreo', 'Cinépolis VIP Miyana Polanco'], publishedThrough: '2026-10-25' } };
  it('is a claim', () => {
    expect(claimsOf('me temo que Your Name no está en cartelera en este momento')).toContain('not_showing');
    expect(claimsOf('No se encuentra disponible en la cartelera actual.')).toContain('not_showing');
    expect(claimsOf('Se proyecta en Toreo mañana.')).not.toContain('not_showing');
  });
  it('needs found:false in this turn, and the reply must cite the range searched', () => {
    const text = 'No aparece en la cartelera de Toreo y Miyana entre el 22 y el 29 de octubre.';
    expect(hasEvidence('not_showing', prompt(miss), text)).toBe(true);
    expect(hasEvidence('not_showing', prompt(miss), 'No está en cartelera.')).toBe(false); // no range cited
    expect(hasEvidence('not_showing', prompt({ found: true, cinemas: [{ cinema: 'Toreo' }] }), text)).toBe(false);
    expect(hasEvidence('not_showing', [{ role: 'user', content: 'x' }], text)).toBe(false);
  });
});

describe('routing the live questions', () => {
  it('"¿dónde están dando Your Name…?" and "¿qué películas hay hasta el domingo?" are cines', async () => {
    const { domainsFor } = await import('../src/telemetry/intent.js');
    expect(domainsFor('¿dónde están dando Your Name - Kimi no Na wa?')).toEqual(['cines']);
    expect(domainsFor('¿qué películas hay hasta el domingo?')).toEqual(['cines']);
  });
});
