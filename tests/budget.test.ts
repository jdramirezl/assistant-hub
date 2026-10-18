import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { KvStore } from '../src/kv.js';
import { Budget, bogotaDay, estimateCostUsd, BUDGET_MESSAGE } from '../src/budget.js';

const dirs: string[] = [];
function kv(now: () => number) {
  const d = mkdtempSync(join(tmpdir(), 'hub-budget-'));
  dirs.push(d);
  return new KvStore(createClient({ url: `file:${join(d, 'b.db')}` }), now);
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('bogotaDay', () => {
  it('rolls over at midnight America/Bogota (UTC-5), not UTC', () => {
    expect(bogotaDay(Date.parse('2026-10-19T04:59:00Z'), 'America/Bogota')).toBe('2026-10-18');
    expect(bogotaDay(Date.parse('2026-10-19T05:00:00Z'), 'America/Bogota')).toBe('2026-10-19');
  });
});

describe('estimateCostUsd', () => {
  it('prices per model and per token direction', () => {
    const lite = estimateCostUsd('google/gemini-3.5-flash-lite', { inputTokens: 1_000_000, outputTokens: 0 }, Date.parse('2026-10-18T00:00:00Z'));
    const strong = estimateCostUsd('gemini-3.8-flash', { inputTokens: 1_000_000, outputTokens: 0 }, Date.parse('2026-10-18T00:00:00Z'));
    expect(lite).toBeGreaterThan(0);
    expect(strong).toBeGreaterThan(lite);
  });
  it('applies the 2027 price change for gemini-3.8-flash', () => {
    const before = estimateCostUsd('gemini-3.8-flash', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, Date.parse('2026-12-31T12:00:00Z'));
    const after = estimateCostUsd('gemini-3.8-flash', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, Date.parse('2027-01-02T12:00:00Z'));
    expect(after).toBeCloseTo(before * 2, 6);
  });
  it('falls back to the most expensive known price for unknown models (never under-counts)', () => {
    const unknown = estimateCostUsd('some/other-model', { inputTokens: 1_000_000, outputTokens: 0 }, 0);
    const strong = estimateCostUsd('gemini-3.8-flash', { inputTokens: 1_000_000, outputTokens: 0 }, 0);
    expect(unknown).toBeGreaterThanOrEqual(strong);
  });
});

describe('Budget', () => {
  it('allows usage under the caps and blocks once the token cap is reached', async () => {
    const now = Date.parse('2026-10-18T15:00:00Z');
    const b = new Budget(kv(() => now), { dailyTokenCap: 1000, dailyCostCapUsd: 10 }, 'America/Bogota', () => now);
    expect((await b.check()).ok).toBe(true);
    await b.record('google/gemini-3.5-flash-lite', { inputTokens: 600, outputTokens: 300 });
    expect((await b.check()).ok).toBe(true);
    await b.record('google/gemini-3.5-flash-lite', { inputTokens: 100, outputTokens: 50 });
    const s = await b.check();
    expect(s).toMatchObject({ ok: false, tokens: 1050, reason: 'tokens' });
  });

  it('blocks on the cost cap', async () => {
    const now = Date.parse('2026-10-18T15:00:00Z');
    const b = new Budget(kv(() => now), { dailyTokenCap: 1e12, dailyCostCapUsd: 0.01 }, 'America/Bogota', () => now);
    await b.record('gemini-3.8-flash', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(await b.check()).toMatchObject({ ok: false, reason: 'cost' });
  });

  it('resets at Bogota midnight', async () => {
    let now = Date.parse('2026-10-19T04:00:00Z'); // 23:00 Bogota on the 18th
    const b = new Budget(kv(() => now), { dailyTokenCap: 100, dailyCostCapUsd: 10 }, 'America/Bogota', () => now);
    await b.record('google/gemini-3.5-flash-lite', { inputTokens: 200, outputTokens: 0 });
    expect((await b.check()).ok).toBe(false);
    now = Date.parse('2026-10-19T05:01:00Z'); // 00:01 Bogota on the 19th
    expect((await b.check()).ok).toBe(true);
  });

  it('notifies once per day when the cap is first hit', async () => {
    const now = Date.parse('2026-10-18T15:00:00Z');
    const b = new Budget(kv(() => now), { dailyTokenCap: 10, dailyCostCapUsd: 10 }, 'America/Bogota', () => now);
    await b.record('x', { inputTokens: 50, outputTokens: 0 });
    expect(await b.claimNotice()).toBe(true);
    expect(await b.claimNotice()).toBe(false);
  });

  it('has a user-facing message', () => {
    expect(BUDGET_MESSAGE).toMatch(/paused, budget hit/i);
  });
});
