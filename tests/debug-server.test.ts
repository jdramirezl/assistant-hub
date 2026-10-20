import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLoopbackHost, budgetedFetch, debugKey, DebugRefused, startDebugServer } from '../src/debug/server.js';
import { withUsageScope } from '../src/telemetry/context.js';
import { scriptedModel, type Turn } from './support/scripted-model.js';
import { MFP_REGISTRY, startFakeMason, type FakeMason } from './support/fake-mason.js';
import { CINES_REGISTRY, startFakeCines } from './support/fake-cines.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

describe('guards', () => {
  it('DEV key only; never the production key', () => {
    expect(() => debugKey({}, '/nonexistent')).toThrow(DebugRefused);
    expect(() => debugKey({ DEV_GOOGLE_API_KEY: 'k', GOOGLE_API_KEY: 'k' }, '/nonexistent')).toThrow(/equals the production key/);
    const repo = mkdtempSync(join(tmpdir(), 'repo-'));
    writeFileSync(join(repo, '.env.server'), 'GOOGLE_API_KEY=prod\n');
    expect(() => debugKey({ REPLAY_GOOGLE_API_KEY: 'prod' }, repo)).toThrow(/production key/);
    expect(debugKey({ DEV_GOOGLE_API_KEY: 'dev', GOOGLE_API_KEY: 'prod' }, repo)).toBe('dev');
  });
  it('loopback only', () => {
    expect(() => assertLoopbackHost('0.0.0.0')).toThrow(/only listens on loopback/);
    expect(() => assertLoopbackHost('127.0.0.1')).not.toThrow();
  });
  it('per-request and daily call budgets', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'b-')), 'calls.json');
    const b = budgetedFetch({ perRequest: 2, perDay: 3, file, base: async () => new Response('{}'), timezone: 'America/Bogota' });
    await withUsageScope({ requestId: 'r1', intent: 'chat', media: 'text', kind: 'chat' }, async () => {
      await b.fetch('x');
      await b.fetch('x');
      await expect(b.fetch('x')).rejects.toThrow(/per-request Gemini budget/);
    });
    await withUsageScope({ requestId: 'r2', intent: 'chat', media: 'text', kind: 'chat' }, async () => {
      await b.fetch('x');
      await expect(b.fetch('x')).rejects.toThrow(/daily Gemini budget/);
    });
  });
});

describe('the debug entry point', () => {
  let mason: FakeMason;
  async function boot(script: Turn[], registry?: unknown) {
    mason = await startFakeMason([{ meal: 'Breakfast', name: 'Egg, whole, large', calories: 144 }]);
    closers.push(mason.close);
    const sm = scriptedModel(script);
    const dataDir = mkdtempSync(join(tmpdir(), 'dbg-'));
    const s = await startDebugServer({ dataDir, port: 0, env: {}, quietMs: 2500, hubDeps: { model: sm.model as never, registry: registry ?? MFP_REGISTRY(mason.url) } });
    closers.push(s.close);
    const call = async (path: string, body: unknown, token = s.token) => {
      const r = await fetch(`${s.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-debug-token': token }, body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> & { messages: { kind: string; text?: string; buttons?: { label: string }[] }[]; requestIds: string[] } };
    };
    return { s, sm, call, dataDir };
  }

  it('token required (0600 file); runs the real pipeline and returns messages, req id and llm rows', async () => {
    const { s, call, sm } = await boot([{ tool: 'fitness_get_day', args: {} }, { text: 'Hoy: un huevo, 144 kcal.' }]);
    expect(statSync(s.tokenFile).mode & 0o777).toBe(0o600);
    expect((await call('/debug/chat', { text: 'hola' }, 'wrong')).status).toBe(401);
    const r = await call('/debug/chat', { text: '¿qué comí hoy?' });
    expect(r.status).toBe(200);
    expect(r.body.messages.some((m) => m.kind === 'message' && m.text === 'Hoy: un huevo, 144 kcal.'), JSON.stringify(r.body.messages)).toBe(true);
    expect(r.body.requestIds).toHaveLength(1);
    // its own conversation (debug user), never the owner's Telegram memory
    expect(JSON.stringify(sm.calls[0]!.prompt)).toContain('7000001');
  });

  it('read-only by default: writes are blocked; allowWrites:true lets them run', async () => {
    const meal = { tool: 'log_meal', args: { items: [{ query: 'rice', quantity: 1, unit: 'cup', kcal_estimate: 200, meal: 'lunch' }] } };
    const { call } = await boot([meal, { text: 'a' }, meal, { text: 'b' }]);
    const r1 = await call('/debug/chat', { text: 'almorcé arroz' });
    expect(mason.diary).toHaveLength(1);
    expect((r1.body.log as string[]).join('\n')).toMatch(/blocked write fitness_log_food/);
    await call('/debug/chat', { text: 'almorcé arroz', allowWrites: true });
    expect(mason.diary.map((e) => e.name)).toContain('Rice, white, cooked');
  });

  it('approval cards: shown in the transcript; a press runs them only with allowWrites', async () => {
    const del = { tool: 'fitness_delete_food', args: { query: 'Egg, whole, large', meal: 'breakfast' } };
    const { call } = await boot([del, { text: 'ok' }, del, { text: 'ok' }]);
    const r = await call('/debug/chat', { text: 'borra el huevo' });
    const card = r.body.messages.find((m) => m.kind === 'card')!;
    expect(card.text).toMatch(/Borrar de MyFitnessPal/);
    await call('/debug/press', { button: 'Aprobar' }); // read-only press: blocked
    expect(mason.diary).toHaveLength(1);
    await call('/debug/chat', { text: 'borra el huevo' });
    await call('/debug/press', { button: 'Aprobar', allowWrites: true });
    expect(mason.diary).toHaveLength(0);
  });

  it('cines_purchase is never allowed, even with allowWrites', async () => {
    const cines = await startFakeCines({ phase3: true });
    closers.push(cines.close);
    const { call } = await boot([{ tool: 'cines_purchase', args: { holdId: 'hold_1', expectedTotal: 99 } }, { text: 'no' }], CINES_REGISTRY(cines.url));
    await call('/debug/chat', { text: 'compra el apartado', allowWrites: true });
    const b = await call('/debug/press', { button: 'tool_approve:', allowWrites: true });
    expect(cines.calls.map((c) => c.tool)).not.toContain('cines_purchase');
    void b;
  });
});
