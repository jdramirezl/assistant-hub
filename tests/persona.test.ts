import { describe, expect, it } from 'vitest';
import { createVoice, personaPrompt, type PersonaConfig } from '../src/persona.js';
import { buildInstructions } from '../src/agents/assistant.js';
import { loadConfig } from '../src/config.js';

const alfredEs: PersonaConfig = { persona: 'alfred', language: 'es', ownerName: 'Julián' };
const alfredEn: PersonaConfig = { ...alfredEs, language: 'en' };
const plain: PersonaConfig = { ...alfredEs, persona: 'plain' };

describe('config', () => {
  it('defaults to Alfred, Spanish, Julián; can be switched off', () => {
    const cfg = loadConfig({ NODE_ENV: 'test' });
    expect(cfg.persona).toEqual({ persona: 'alfred', language: 'es', ownerName: 'Julián' });
    expect(loadConfig({ NODE_ENV: 'test', HUB_PERSONA: 'plain' }).persona.persona).toBe('plain');
    expect(() => loadConfig({ NODE_ENV: 'test', HUB_PERSONA: 'jarvis' })).toThrow(/HUB_PERSONA/);
  });
});

describe('persona prompt', () => {
  it('is a separate section: Alfred, both forms of address, brevity, plain numbers', () => {
    const p = personaPrompt(alfredEs);
    expect(p).toMatch(/^## Persona/);
    expect(p).toContain('Alfred');
    expect(p).toContain('"Master Julian"');
    expect(p).toContain('"Amo Julián"');
    expect(p).toMatch(/one short/i);
    expect(p).toMatch(/plain and scannable/i);
  });
  it('is empty when switched off, and the agent prompt includes it only when on', () => {
    expect(personaPrompt(plain)).toBe('');
    expect(buildInstructions('America/Bogota', new Date(), { persona: alfredEs })).toContain('Amo Julián');
    expect(buildInstructions('America/Bogota', new Date(), { persona: plain })).not.toContain('Alfred');
  });
});

describe('voice (notices)', () => {
  const apps = { mfp: { state: 'up' as const, tools: 20 }, finance: { state: 'down' as const, reason: 'x' }, echo: { state: 'skipped' as const, reason: 'off' } };
  it('Alfred in Spanish addresses "Amo Julián" and keeps the facts', () => {
    const v = createVoice(alfredEs);
    const up = v.startup('mac-mini', apps);
    expect(up).toContain('Amo Julián');
    expect(up).toContain('mac-mini');
    expect(up).toContain('mfp');
    expect(up).toMatch(/finance/);
    expect(up).not.toContain('echo');
    expect(v.back('mfp', 14)).toMatch(/mfp.*14 min/);
    expect(v.rateLimit(12)).toMatch(/^⏳.*12\s?s/);
    expect(v.rateLimitGiveUp(true)).toMatch(/^⏳.*(diario|hoy)/i);
    expect(v.digestEmpty('2026-10-18')).toMatch(/2026-10-18/);
  });
  it('Alfred in English says "Master Julian" (no accent)', () => {
    expect(createVoice(alfredEn).startup('mac', apps)).toContain('Master Julian');
  });
  it('plain voice keeps the original wording', () => {
    const v = createVoice(plain);
    expect(v.startup('mac', apps)).toMatch(/^✅ I'm up on mac\./);
    expect(v.rateLimit(9)).toBe('⏳ rate limit, retrying in 9s');
  });
});
