import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Key for live tests and the replay harness. It must be a SEPARATE Google project from the
 * production bot (free-tier quotas are per project): REPLAY_GOOGLE_API_KEY, or
 * GOOGLE_API_KEY_DEV. Refuses the production key (GOOGLE_API_KEY in .env.server, or the
 * process GOOGLE_API_KEY when it equals it) so tests never consume production quota again.
 */
export function devGeminiKey(env: Record<string, string | undefined> = process.env, repo = process.cwd()): { key?: string; reason?: string } {
  const key = env.REPLAY_GOOGLE_API_KEY || env.GOOGLE_API_KEY_DEV;
  if (!key) return { reason: 'set REPLAY_GOOGLE_API_KEY (or GOOGLE_API_KEY_DEV) to a key from a separate Google project' };
  const prodFile = join(repo, '.env.server');
  const prod = existsSync(prodFile) ? readFileSync(prodFile, 'utf8').match(/^GOOGLE_API_KEY=(.*)$/m)?.[1]?.trim() : undefined;
  const prodKeys = [prod, env.PROD_GOOGLE_API_KEY].filter(Boolean);
  if (prodKeys.includes(key)) return { reason: 'REPLAY_GOOGLE_API_KEY is the production key; use a key from a separate Google project' };
  return { key };
}
