import { execFileSync } from 'node:child_process';
import { findUp } from './config.js';
import { dirname } from 'node:path';

let cached: string | undefined;

/** Deployed version: HUB_VERSION, else the git short sha of the checkout, else "dev". */
export function hubVersion(env: Record<string, string | undefined> = process.env): string {
  if (env.HUB_VERSION) return env.HUB_VERSION;
  if (cached) return cached;
  try {
    const git = findUp('.git', process.cwd());
    cached = git ? execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dirname(git), encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() : 'dev';
  } catch {
    cached = 'dev';
  }
  return cached || 'dev';
}
