// Opt-in: real Gemini driving a fake finance MCP (no real money/data). `npm run test:live`
import { devGeminiKey } from '../support/dev-key.js';

const DEV_KEY = devGeminiKey().key; // never the production key
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../../src/hub.js';
import { bogotaDay } from '../../src/budget.js';
import { testConfig } from '../helpers.js';
import { startFakeFinance, type FakeFinance } from '../support/fake-finance.js';

describe.skipIf(!DEV_KEY)('live Gemini + fake finance', () => {
  let fin: FakeFinance;
  let hub: Hub;
  beforeAll(async () => {
    fin = await startFakeFinance('live-token');
    hub = createHub(testConfig({ GOOGLE_API_KEY: DEV_KEY! }), {
      registry: { servers: { finance: { url: '${FINANCE_MCP_URL}', headers: { Authorization: { env: 'FINANCE_MCP_TOKEN', prefix: 'Bearer ' } } } } },
      env: { FINANCE_MCP_URL: fin.url, FINANCE_MCP_TOKEN: 'live-token' },
    });
  });
  afterAll(async () => {
    await hub.stop();
    await fin.close();
  });

  it('records "gasté 25k en almuerzo con Nequi" as EgresoNormal 25000 today on Nequi', async () => {
    const res = await hub.mastra.getAgentById('assistant').generate('gasté 25k en almuerzo con Nequi', { memory: { thread: 'live-1', resource: 'dev:local' } });
    const create = fin.calls.find((c) => c.tool === 'finance_create_movement');
    expect(create, `tools called: ${fin.calls.map((c) => c.tool).join(', ')} / reply: ${res.text}`).toBeDefined();
    expect(create!.input).toMatchObject({ accountId: 'acc-nequi', type: 'EgresoNormal', amount: 25000, date: bogotaDay(Date.now(), 'America/Bogota') });
  }, 120_000);

  it('surfaces a VALIDATION_ERROR instead of claiming a save', async () => {
    fin.rejectCreate = 'category is required for EgresoNormal';
    const res = await hub.mastra.getAgentById('assistant').generate('gasté 12000 en taxi con Nequi', { memory: { thread: 'live-2', resource: 'dev:local' } });
    fin.rejectCreate = undefined;
    expect(fin.calls.filter((c) => c.tool === 'finance_create_movement').length).toBeGreaterThanOrEqual(1);
    expect(res.text.toLowerCase()).toMatch(/categor/);
    expect(res.text.toLowerCase()).not.toMatch(/registr[ée] (el|tu|un) gasto|guardado con éxito|listo ✅/);
  }, 120_000);
});
