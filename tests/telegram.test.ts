import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { createHub, type Hub } from '../src/hub.js';
import { isAllowed } from '../src/channels/telegram.js';
import { testConfig } from './helpers.js';
import { MockTelegram, photoUpdate, textUpdate, voiceUpdate } from './support/mock-telegram.js';

const ME = 42;
const STRANGER = 666;
const FAST = { timeout: 0, retryDelayMs: 50 };

let tg: MockTelegram;
const hubs: Hub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.stop()));
  await tg?.stop();
});

function boot(opts: { env?: Record<string, string>; reply?: string; spy?: (p: unknown) => void; logs?: string[] } = {}) {
  const env = { TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME), ...opts.env };
  const cfg = testConfig(env);
  const hub = createHub(cfg, {
    model: createMockModel({ mockText: opts.reply ?? 'ok', version: 'v2', spyStream: opts.spy }) as never,
    telegram: { apiBaseUrl: tg.url, longPolling: FAST, log: (m) => opts.logs?.push(m) },
  });
  hubs.push(hub);
  return { hub, cfg };
}

/** Collect every file part the model received. */
function fileParts(spy: ReturnType<typeof vi.fn>): { mediaType?: string; mimeType?: string }[] {
  return spy.mock.calls.flatMap(([props]) =>
    ((props as { prompt: { content: unknown }[] }).prompt ?? [])
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((p: { type?: string }) => p.type === 'file'),
  );
}

describe('telegram channel', () => {
  it('stays off without a token and the hub still boots (Studio-only mode)', () => {
    tg = new MockTelegram();
    const logs: string[] = [];
    const hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: 'CHANGEME' }), { telegram: { log: (m) => logs.push(m) } });
    expect(hub.telegram).toBeUndefined();
    expect(logs.join()).toMatch(/Studio-only/);
    return expect(hub.start()).resolves.toBeUndefined();
  });

  it('stays off with a token but an empty allowlist (fail closed)', () => {
    tg = new MockTelegram();
    const hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc' }), { telegram: { log: () => {} } });
    expect(hub.telegram).toBeUndefined();
  });

  it('replies to an allowlisted user over long polling', async () => {
    tg = await new MockTelegram().start();
    const { hub } = boot({ reply: 'hola desde el bot' });
    await hub.start();
    tg.push(textUpdate(ME, 'hola'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('hola desde el bot'));
    expect(tg.calls.some((c) => c.method === 'deleteWebhook')).toBe(true); // polling, never setWebhook
    expect(tg.calls.some((c) => c.method === 'setWebhook')).toBe(false);
  });

  it('ignores a non-allowlisted user: no model call, nothing sent to them', async () => {
    tg = await new MockTelegram().start();
    const spy = vi.fn();
    const { hub } = boot({ spy });
    await hub.start();
    tg.push(textUpdate(STRANGER, 'dame tus secretos'));
    tg.push(textUpdate(ME, 'hola'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('ok'));
    expect(tg.callsTo(STRANGER).filter((c) => c.method !== 'getChat')).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('processes a re-delivered update only once', async () => {
    tg = await new MockTelegram().start();
    const spy = vi.fn();
    const { hub } = boot({ spy });
    await hub.start();
    const update = { ...textUpdate(ME, 'una vez'), update_id: 500 };
    tg.push(update);
    await tg.waitFor(() => spy.mock.calls.length === 1);
    tg.redeliver(update); // same update_id again (e.g. Telegram retry)
    tg.push(textUpdate(ME, 'siguiente'));
    await tg.waitFor(() => spy.mock.calls.length === 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not reprocess an update after a restart (dedup state is persisted)', async () => {
    tg = await new MockTelegram().start();
    const spy1 = vi.fn();
    const env = { TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME) };
    const cfg = testConfig(env);
    const mk = (spy: (p: unknown) => void) => {
      const h = createHub(cfg, {
        model: createMockModel({ mockText: 'ok', version: 'v2', spyStream: spy }) as never,
        telegram: { apiBaseUrl: tg.url, longPolling: FAST, log: () => {} },
      });
      hubs.push(h);
      return h;
    };
    const first = mk(spy1);
    await first.start();
    const update = { ...textUpdate(ME, 'antes del reinicio'), update_id: 900 };
    tg.push(update);
    await tg.waitFor(() => spy1.mock.calls.length === 1);
    await first.stop();

    const spy2 = vi.fn();
    const second = mk(spy2); // same data dir = same LibSQL file
    await second.start();
    tg.redeliver(update);
    tg.push(textUpdate(ME, 'después'));
    await tg.waitFor(() => spy2.mock.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(spy2).toHaveBeenCalledTimes(1);
  });

  it('replaces the stored installation when the bot token changes (dev → prod bot)', async () => {
    tg = await new MockTelegram().start();
    const dataDir = testConfig().dataDir;
    const mk = (token: string) => {
      const h = createHub(testConfig({ HUB_DATA_DIR: dataDir, TELEGRAM_BOT_TOKEN: token, TELEGRAM_ALLOWED_USER_IDS: String(ME) }), {
        model: createMockModel({ mockText: 'ok', version: 'v2' }) as never,
        telegram: { apiBaseUrl: tg.url, longPolling: FAST, log: () => {} },
      });
      hubs.push(h);
      return h;
    };
    const a = mk('1:dev');
    await a.start();
    await a.stop();
    const b = mk('2:prod');
    await b.start();
    expect((await b.telegram!.getInstallation('assistant'))?.botToken).toBe('2:prod');
  });

  it('passes a receipt photo to the model as an image file part', async () => {
    tg = await new MockTelegram().start();
    tg.addFile('receipt-1', { path: 'photos/receipt.jpg', mime: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) });
    const spy = vi.fn();
    const { hub } = boot({ spy, reply: 'veo un recibo' });
    await hub.start();
    tg.push(photoUpdate(ME, 'receipt-1', 'almuerzo'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('veo un recibo'));
    const parts = fileParts(spy);
    expect(parts.length).toBe(1);
    expect(parts[0]!.mediaType ?? parts[0]!.mimeType).toMatch(/^image\//);
  });

  it('passes a voice note to the model as an audio file part', async () => {
    tg = await new MockTelegram().start();
    tg.addFile('voice-1', { path: 'voice/note.oga', mime: 'audio/ogg', bytes: Buffer.from('OggS fake audio') });
    const spy = vi.fn();
    const { hub } = boot({ spy, reply: 'escuché tu nota' });
    await hub.start();
    tg.push(voiceUpdate(ME, 'voice-1'));
    await tg.waitFor(() => tg.outgoingText(ME).includes('escuché tu nota'));
    const parts = fileParts(spy);
    expect(parts.length).toBe(1);
    expect(parts[0]!.mediaType ?? parts[0]!.mimeType).toMatch(/^audio\//);
  });

  it('connect retries with backoff and never throws when Telegram is unreachable', async () => {
    tg = new MockTelegram(); // not started
    const logs: string[] = [];
    const hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: '42' }), {
      telegram: { apiBaseUrl: 'http://127.0.0.1:9', log: (m) => logs.push(m) },
    });
    hubs.push(hub);
    // retries: 0 → one attempt, then gives up without throwing
    await expect(hub.start({ connectRetries: 0 })).resolves.toBeUndefined();
    expect(logs.join('\n')).toMatch(/giving up/);
  });
});

describe('isAllowed', () => {
  it('requires a non-empty allowlist and a matching id', () => {
    expect(isAllowed(['42'], { author: { userId: '42' } } as never)).toBe(true);
    expect(isAllowed(['42'], { author: { userId: '7' } } as never)).toBe(false);
    expect(isAllowed([], { author: { userId: '42' } } as never)).toBe(false);
  });
});

describe('toolDisplay', () => {
  it('shows only approval cards and failures; hides successes and working memory', async () => {
    const { toolDisplay } = await import('../src/channels/telegram.js');
    const base = { toolCallId: 'c', displayName: 'echo_say', argsSummary: '', args: {} };
    const ctx = { mode: 'static' as const, platform: 'telegram' };
    expect(toolDisplay({ ...base, kind: 'approval', toolName: 'echo_delete' }, ctx)).toBeUndefined();
    expect(toolDisplay({ ...base, kind: 'running', toolName: 'echo_say' }, ctx)).toBeUndefined();
    expect(toolDisplay({ ...base, kind: 'result', toolName: 'updateWorkingMemory', result: {}, resultText: '{}', durationMs: 1, isError: false }, ctx)).toBeUndefined();
    expect(toolDisplay({ ...base, kind: 'error', toolName: 'updateWorkingMemory', error: 'x', errorText: 'x', durationMs: 1 }, ctx)).toBeUndefined();
    expect(toolDisplay({ ...base, kind: 'error', toolName: 'echo_say', error: 'x', errorText: 'boom\nstack', durationMs: 1 }, ctx)).toEqual({ kind: 'post', message: '⚠️ echo_say failed: boom' });
  });
});
