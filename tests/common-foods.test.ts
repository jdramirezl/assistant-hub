import { describe, expect, it } from 'vitest';
import { normalizeUnit, standardPortion } from '../src/mcp/common-foods.js';

describe('standard portions', () => {
  it('maps Spanish units', () => {
    expect(['taza', 'Rebanada', 'cucharada', 'unidades', 'plato'].map(normalizeUnit)).toEqual(['cup', 'slice', 'tbsp', 'unit', 'plate']);
  });
  it.each([
    ['rice', 1, 'plate', { quantity: 1.5, unit: 'cup' }],
    ['white rice', 2, 'serving', { quantity: 2, unit: 'cup' }],
    ['rice', 1, '', { quantity: 1, unit: 'cup' }],
    ['chicken breast', 1, 'portion', { quantity: 1, unit: 'breast' }],
    ['egg', 2, 'serving', { quantity: 2, unit: 'unit' }],
    ['rice', 150, 'g', undefined], // a real measure is never reinterpreted
    ['rice', 1, 'cup', undefined],
    ['sandwich', 1, 'serving', undefined],
  ])('%s %s %s → %j', (q, n, u, out) => {
    const r = standardPortion(q, n, u);
    expect(r && { quantity: r.quantity, unit: r.unit }).toEqual(out);
  });
});
