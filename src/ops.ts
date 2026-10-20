import type { KvStore } from './kv.js';
import type { ServerStatus } from './mcp/toolbox.js';

/** Suppress repeated "I'm up" messages when launchd restarts a crashing process. */
const STARTUP_PING_WINDOW_MS = 5 * 60_000;
export const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

export function startupMessage({ host, apps }: { host: string; apps: Record<string, ServerStatus> }): string {
  const up = Object.entries(apps).filter(([, s]) => s.state === 'up').map(([n]) => n);
  const down = Object.entries(apps).filter(([, s]) => s.state === 'down').map(([n]) => n);
  const lines = [`✅ I'm up on ${host}.`];
  lines.push(up.length ? `Apps: ${up.join(', ')}` : 'No apps connected yet.');
  if (down.length) lines.push(`⚠️ Unavailable: ${down.join(', ')} (down)`);
  return lines.join('\n');
}

/**
 * Send the startup message once per deploy (a new version) and once per reboot, but not on
 * every crash-loop restart (at most once per few minutes for the same version).
 */
export async function sendStartupPing(opts: { kv: KvStore; notify: (t: string) => Promise<void>; text: string; version?: string }): Promise<boolean> {
  const last = await opts.kv.get<string>('ops:startup-version');
  const newVersion = opts.version !== undefined && last !== opts.version;
  const fresh = await opts.kv.setIfNotExists('ops:startup-ping', true, STARTUP_PING_WINDOW_MS);
  if (!fresh && !newVersion) return false;
  if (opts.version !== undefined) await opts.kv.set('ops:startup-version', opts.version);
  await opts.notify(opts.text);
  return true;
}

export interface HeartbeatOptions {
  /** healthchecks.io ping URL; undefined disables the heartbeat. */
  url: string | undefined;
  /** Self-check run before each ping; a failure pings `<url>/fail`. */
  check: () => Promise<boolean>;
  fetch?: typeof fetch;
  intervalMs?: number;
  log?: (m: string) => void;
}

/**
 * healthchecks.io dead-man's switch: ping every 5 minutes while the hub is healthy. If the
 * process dies or the Mac sleeps, pings stop and healthchecks.io alerts you. Never throws.
 */
export function startHeartbeat(opts: HeartbeatOptions): { stop(): void } {
  if (!opts.url) return { stop() {} };
  const url = opts.url.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? ((m: string) => console.warn(m));

  const beat = async () => {
    let healthy = false;
    try {
      healthy = await opts.check();
    } catch (err) {
      log(`[health] self-check threw: ${(err as Error).message}`);
    }
    try {
      await doFetch(healthy ? url : `${url}/fail`, { method: 'GET', signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      log(`[health] ping failed: ${(err as Error).message}`);
    }
  };

  void beat();
  const timer = setInterval(() => void beat(), opts.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
