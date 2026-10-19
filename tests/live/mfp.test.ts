// Opt-in: real Gemini driving a fake Mason (no real diary). `npm run test:live`
import { devGeminiKey } from '../support/dev-key.js';

const DEV_KEY = devGeminiKey().key; // never the production key
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../../src/hub.js';
import { testConfig } from '../helpers.js';
import { MFP_REGISTRY, startFakeMason, type FakeMason } from '../support/fake-mason.js';

describe.skipIf(!DEV_KEY)('live Gemini + fake Mason', () => {
  let mason: FakeMason;
  let hub: Hub;
  beforeAll(async () => {
    mason = await startFakeMason();
    hub = createHub(testConfig({ GOOGLE_API_KEY: DEV_KEY! }), { registry: MFP_REGISTRY(mason.url) });
  });
  afterAll(async () => {
    await hub.stop();
    await mason.close();
  });

  it('Spanish meal → English draft, per-egg serving, readback with the meal total', async () => {
    const res = await hub.mastra.getAgentById('assistant').generate('comí 2 huevos al desayuno', { memory: { thread: 'live-mfp', resource: 'dev:local' } });
    const drafts = mason.calls.filter((c) => c.tool === 'fitness_draft_food');
    expect(drafts.length, `calls: ${mason.calls.map((c) => c.tool).join(',')} / ${res.text}`).toBeGreaterThan(0);
    expect(String(drafts[0]!.input.query).toLowerCase()).toMatch(/egg/);
    expect(mason.diary.reduce((a, e) => a + e.calories, 0), res.text).toBe(144);
    expect(res.text).toMatch(/144/);
  }, 180_000);
});
