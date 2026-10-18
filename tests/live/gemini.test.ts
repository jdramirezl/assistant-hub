// Opt-in live test against real Gemini: `GOOGLE_API_KEY=... npm run test:live`
import { describe, expect, it } from 'vitest';
import { createAssistantAgent } from '../../src/agents/assistant.js';

describe.skipIf(!process.env.GOOGLE_API_KEY)('live Gemini', () => {
  it('replies in Spanish to a Spanish message', async () => {
    const agent = createAssistantAgent({ timezone: 'America/Bogota' });
    const res = await agent.generate('Hola, ¿qué día es hoy? Responde en una frase.');
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.text).toMatch(/[áéíóúñ¿]|hoy|domingo|lunes|martes|miércoles|jueves|viernes|sábado/i);
  }, 60_000);
});
