// Opt-in live test against real Gemini: `GOOGLE_API_KEY=... npm run test:live`
import { devGeminiKey } from '../support/dev-key.js';

const DEV_KEY = devGeminiKey().key; // never the production key
import { describe, expect, it } from 'vitest';
import { createAssistantAgent } from '../../src/agents/assistant.js';
import { createGeminiModels, modelChain } from '../../src/models.js';

describe.skipIf(!DEV_KEY)('live Gemini', () => {
  it('replies in Spanish to a Spanish message', async () => {
    const agent = createAssistantAgent({ timezone: 'America/Bogota', model: modelChain('default', createGeminiModels(DEV_KEY)) });
    const res = await agent.generate('Hola, ¿qué día es hoy? Responde en una frase.');
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.text).toMatch(/[áéíóúñ¿]|hoy|domingo|lunes|martes|miércoles|jueves|viernes|sábado/i);
  }, 60_000);
});
