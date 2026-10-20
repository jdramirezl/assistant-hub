import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { KvStore } from '../src/kv.js';
import { sendStartupPing, startHeartbeat, startupMessage } from '../src/ops.js';

function kv(now: () => number = Date.now) {
  const d = mkdtempSync(join(tmpdir(), 'hub-ops-'));
  return new KvStore(createClient({ url: `file:${join(d, 'o.db')}` }), now);
}

describe('startup ping', () => {
  it('describes the host and app status', () => {
    const text = startupMessage({ host: 'living-room-mac', apps: { echo: { state: 'up', tools: 3 }, finance: { state: 'skipped', reason: 'disabled' }, fitness: { state: 'down', reason: 'x' } } });
    expect(text).toMatch(/I'm up/);
    expect(text).toContain('living-room-mac');
    expect(text).toContain('echo');
    expect(text).toMatch(/fitness.*(down|unavailable)/i);
    expect(text).not.toContain('finance'); // skipped/disabled apps are noise
  });

  it('sends once, then stays quiet during a crash-restart loop', async () => {
    let now = 1_000_000;
    const store = kv(() => now);
    const notify = vi.fn(async () => {});
    expect(await sendStartupPing({ kv: store, notify, text: 'up' })).toBe(true);
    now += 60_000;
    expect(await sendStartupPing({ kv: store, notify, text: 'up' })).toBe(false);
    now += 10 * 60_000;
    expect(await sendStartupPing({ kv: store, notify, text: 'up' })).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe('healthchecks.io heartbeat', () => {
  afterEach(() => vi.useRealTimers());

  it('pings immediately and then every 5 minutes while healthy', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (_url: string) => new Response('OK'));
    const hb = startHeartbeat({ url: 'https://hc-ping.com/abc', fetch: fetch as never, check: async () => true, log: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('https://hc-ping.com/abc');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    hb.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports /fail when the self-check fails, and never throws on network errors', async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Response('OK'));
    let healthy = true;
    const hb = startHeartbeat({ url: 'https://hc-ping.com/abc', fetch: fetch as never, check: async () => healthy, log: (m) => logs.push(m) });
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.join()).toMatch(/offline/);
    healthy = false;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetch.mock.calls[1]![0]).toBe('https://hc-ping.com/abc/fail');
    hb.stop();
  });

  it('is a no-op without a URL', () => {
    const fetch = vi.fn();
    const hb = startHeartbeat({ url: undefined, fetch: fetch as never, check: async () => true, log: () => {} });
    hb.stop();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('hub.start({ ops: true })', () => {
  it('sends "I\'m up" via Telegram and pings healthchecks.io', async () => {
    const { MockTelegram } = await import('./support/mock-telegram.js');
    const { createHub } = await import('../src/hub.js');
    const { testConfig } = await import('./helpers.js');
    const tg = await new MockTelegram().start();
    const hc = vi.fn(async () => new Response('OK'));
    const hub = createHub(
      testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: '42', HEALTHCHECK_URL: 'https://hc-ping.com/uuid' }),
      { registry: { servers: {} }, fetch: hc as never, telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: () => {} } },
    );
    await hub.start({ ops: true });
    await tg.waitFor(() => tg.sent('sendMessage').some((c) => /🔄 De vuelta, Master Julian \(versión \w+\)/.test(String(c.body.text))));
    await vi.waitFor(() => expect(hc).toHaveBeenCalledWith('https://hc-ping.com/uuid', expect.anything()));
    await hub.stop();
    await tg.stop();
  });
});
