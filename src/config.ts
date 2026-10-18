import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';

/** Values that mean "not configured yet" (used while the bot/apps don't exist). */
const PLACEHOLDERS = new Set(['', 'changeme', 'todo', 'placeholder', 'xxx']);

export function isPlaceholder(value: string | undefined): boolean {
  return value === undefined || PLACEHOLDERS.has(value.trim().toLowerCase());
}

export class ConfigError extends Error {
  constructor(issues: string[]) {
    super(`Invalid assistant-hub configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** Optional string; placeholders collapse to undefined. */
const optionalValue = z
  .string()
  .optional()
  .transform((v) => (isPlaceholder(v) ? undefined : v!.trim()));

const positiveNumber = (name: string) =>
  optionalValue.pipe(
    z
      .string()
      .optional()
      .transform((v) => (v === undefined ? undefined : Number(v)))
      .refine((v) => v === undefined || (Number.isFinite(v) && v > 0), `${name} must be a positive number`),
  );

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  GOOGLE_API_KEY: optionalValue,
  HUB_DATA_DIR: optionalValue.refine((v) => v === undefined || isAbsolute(v), 'HUB_DATA_DIR must be an absolute path'),
  HUB_HOST: optionalValue.refine(
    (v) => v === undefined || LOOPBACK.has(v),
    'HUB_HOST must be a loopback address (the Mastra server has no auth)',
  ),
  HUB_PORT: optionalValue.refine((v) => v === undefined || /^\d+$/.test(v), 'HUB_PORT must be an integer'),
  HUB_TIMEZONE: optionalValue,
  TELEGRAM_BOT_TOKEN: optionalValue,
  TELEGRAM_ALLOWED_USER_IDS: optionalValue.refine(
    (v) => v === undefined || v.split(',').every((id) => /^\d+$/.test(id.trim())),
    'TELEGRAM_ALLOWED_USER_IDS must be comma-separated numeric Telegram user ids',
  ),
  HEALTHCHECK_URL: optionalValue.refine(
    (v) => v === undefined || v.startsWith('https://'),
    'HEALTHCHECK_URL must be an https URL',
  ),
  DAILY_TOKEN_CAP: positiveNumber('DAILY_TOKEN_CAP'),
  DAILY_COST_CAP_USD: positiveNumber('DAILY_COST_CAP_USD'),
  MCP_REGISTRY_PATH: optionalValue.refine((v) => v === undefined || isAbsolute(v), 'MCP_REGISTRY_PATH must be an absolute path'),
});

export interface HubConfig {
  isTest: boolean;
  googleApiKey?: string;
  dataDir: string;
  dbPath: string;
  server: { host: string; port: number };
  timezone: string;
  /** Memory owner: `telegram:<first allowed id>` once known, `dev:local` before that. */
  resourceId: string;
  telegram:
    | { enabled: true; botToken: string; allowedUserIds: string[] }
    | { enabled: false; disabledReason: string; allowedUserIds: string[] };
  healthcheckUrl?: string;
  budget: { dailyTokenCap: number; dailyCostCapUsd: number };
  mcpRegistryPath: string;
}

/**
 * Find `name` in `start` or its ancestors. `mastra dev` runs from `.mastra/output`, so the
 * repo-root `mcp-servers.json` is a few levels up.
 */
export function findUp(name: string, start: string = process.cwd()): string | undefined {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export const DEFAULT_DATA_DIR = join(homedir(), 'Library/Application Support/assistant-hub');

export function loadConfig(env: Record<string, string | undefined> = process.env): HubConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  const isTest = e.NODE_ENV === 'test';
  if (!e.GOOGLE_API_KEY && !isTest) {
    throw new ConfigError(['GOOGLE_API_KEY: required (get one at https://aistudio.google.com/apikey)']);
  }

  const dataDir = e.HUB_DATA_DIR ?? DEFAULT_DATA_DIR;
  const allowedUserIds = (e.TELEGRAM_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let telegram: HubConfig['telegram'];
  if (!e.TELEGRAM_BOT_TOKEN) {
    telegram = { enabled: false, disabledReason: 'TELEGRAM_BOT_TOKEN not set', allowedUserIds };
  } else if (allowedUserIds.length === 0) {
    // The adapter allows EVERYONE when the allowlist is empty, so refuse to start it.
    telegram = { enabled: false, disabledReason: 'TELEGRAM_ALLOWED_USER_IDS is empty', allowedUserIds };
  } else {
    telegram = { enabled: true, botToken: e.TELEGRAM_BOT_TOKEN, allowedUserIds };
  }

  return {
    isTest,
    googleApiKey: e.GOOGLE_API_KEY,
    dataDir,
    dbPath: join(dataDir, 'mastra.db'),
    server: { host: e.HUB_HOST ?? '127.0.0.1', port: e.HUB_PORT ? Number(e.HUB_PORT) : 4111 },
    timezone: e.HUB_TIMEZONE ?? 'America/Bogota',
    resourceId: allowedUserIds[0] ? `telegram:${allowedUserIds[0]}` : 'dev:local',
    telegram,
    healthcheckUrl: e.HEALTHCHECK_URL,
    budget: {
      dailyTokenCap: e.DAILY_TOKEN_CAP ?? 2_000_000,
      dailyCostCapUsd: e.DAILY_COST_CAP_USD ?? 0.5,
    },
    mcpRegistryPath: e.MCP_REGISTRY_PATH ?? findUp('mcp-servers.json') ?? join(process.cwd(), 'mcp-servers.json'),
  };
}
