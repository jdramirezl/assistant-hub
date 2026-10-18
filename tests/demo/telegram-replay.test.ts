// Demo for Task 4: replays a recorded text, photo and voice note through the real Telegram
// channel against a local mock Bot API and prints the bot's replies.
// Run: npx vitest run tests/demo/telegram-replay.test.ts   (uses a mock model; no keys needed)
import { describe, expect, it } from 'vitest';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { createHub } from '../../src/hub.js';
import { testConfig } from '../helpers.js';
import { MockTelegram, photoUpdate, textUpdate, voiceUpdate } from '../support/mock-telegram.js';

describe('demo: telegram replay', () => {
  it('replays text, photo and voice', async () => {
    const tg = await new MockTelegram().start();
    tg.addFile('p1', { path: 'photos/r.jpg', mime: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff]) });
    tg.addFile('v1', { path: 'voice/v.oga', mime: 'audio/ogg', bytes: Buffer.from('OggS') });
    const seen: string[] = [];
    const hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:demo', TELEGRAM_ALLOWED_USER_IDS: '42' }), {
      model: createMockModel({
        version: 'v2',
        mockText: 'Recibido ✅',
        spyStream: (p: { prompt: { content: unknown }[] }) => {
          const parts = p.prompt.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as { type: string; mediaType?: string; text?: string }[];
          seen.push(parts.map((x) => (x.type === 'file' ? `[file ${x.mediaType}]` : x.type === 'text' ? x.text : '')).filter(Boolean).join(' '));
        },
      }) as never,
      telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: () => {} },
    });
    await hub.start();
    for (const u of [textUpdate(42, 'gasté 25k en almuerzo'), photoUpdate(42, 'p1', 'recibo'), voiceUpdate(42, 'v1')]) {
      const before = seen.length;
      tg.push(u);
      await tg.waitFor(() => seen.length > before);
    }
    await tg.waitFor(() => tg.outgoingText(42).split('Recibido').length > 3);
    console.log('\n--- model saw ---\n' + seen.map((s) => `  • ${s.slice(-120)}`).join('\n'));
    console.log('--- bot replied ---\n' + tg.sent('editMessageText').map((c) => `  • ${(c.body.rich_message as { markdown: string }).markdown}`).join('\n'));
    await hub.stop();
    await tg.stop();
    expect(seen).toHaveLength(3);
  });
});
