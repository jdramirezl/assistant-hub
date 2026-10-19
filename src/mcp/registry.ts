import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { isPlaceholder } from '../config.js';

/**
 * `mcp-servers.json`: one entry per app. Adding an app = adding an entry.
 * Secrets never live in this file; headers reference env var names.
 *
 * {
 *   "servers": {
 *     "finance": {
 *       "url": "${FINANCE_MCP_URL}",
 *       "headers": { "Authorization": { "env": "FINANCE_MCP_TOKEN", "prefix": "Bearer " } }
 *     }
 *   }
 * }
 */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ENV_REF = /^\$\{([A-Z0-9_]+)\}$/;

const HeaderSpec = z
  .object({
    env: z.string().regex(/^[A-Z0-9_]+$/),
    prefix: z.string().optional(),
    /** Optional headers are sent when their env var is set and omitted otherwise (e.g. a preview bypass). */
    optional: z.boolean().optional(),
  })
  .strict();

const UrlSpec = z.string().refine((v) => {
  if (ENV_REF.test(v)) return true;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}, 'url must be an http(s) URL or ${ENV_VAR}');

const ServerSpec = z
  .object({
    url: UrlSpec,
    headers: z
      .record(z.string(), z.union([HeaderSpec, z.string()]))
      .default({})
      .refine((h) => Object.values(h).every((v) => typeof v !== 'string'), {
        message: 'header values must be { "env": "VAR_NAME" } (never literal secrets)',
      })
      .transform((h) => h as Record<string, z.infer<typeof HeaderSpec>>),
    enabled: z.boolean().default(true),
    description: z.string().optional(),
    timeoutMs: z.number().int().positive().default(15_000),
    /** Prefix for this server's tools when it differs from the server name (Mason: "fitness"). */
    toolPrefix: z.string().regex(/^[a-z][a-z0-9_]*$/, 'toolPrefix must be lowercase snake_case').optional(),
    /** How the server reports failures; "mason" maps its isError text to MFP_* codes. */
    errorStyle: z.enum(['default', 'mason']).default('default'),
  })
  .strict();

const RegistrySchema = z
  .object({
    servers: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/, 'server names must be lowercase snake_case'), ServerSpec),
  })
  .strict();

export type Registry = z.infer<typeof RegistrySchema>;
export type ServerEntry = Registry['servers'][string];

/** Plain http is only allowed to the local machine (Mason on 127.0.0.1). */
export function assertTransportSecurity(name: string, url: string): void {
  const u = new URL(url);
  if (u.protocol === 'http:' && !LOOPBACK_HOSTS.has(u.hostname)) {
    throw new RegistryError(`server "${name}": remote servers must use https (got ${u.origin})`);
  }
}

export function parseRegistry(raw: unknown): Registry {
  const parsed = RegistrySchema.safeParse(raw);
  if (!parsed.success) {
    throw new RegistryError(
      `invalid mcp-servers.json:\n  - ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  - ')}`,
    );
  }
  for (const [name, s] of Object.entries(parsed.data.servers)) {
    if (!ENV_REF.test(s.url)) assertTransportSecurity(name, s.url);
  }
  return parsed.data;
}

export function loadRegistry(path: string): Registry {
  if (!existsSync(path)) return { servers: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new RegistryError(`cannot parse ${path}: ${(err as Error).message}`);
  }
  try {
    return parseRegistry(raw);
  } catch (err) {
    throw new RegistryError(`${path}: ${(err as Error).message}`);
  }
}

export function resolveHeaders(
  spec: Record<string, { env: string; prefix?: string; optional?: boolean }>,
  env: Record<string, string | undefined>,
): { headers: Record<string, string>; missing: string[] } {
  const headers: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, { env: key, prefix = '', optional = false }] of Object.entries(spec)) {
    const value = env[key];
    if (isPlaceholder(value)) {
      if (!optional) missing.push(key);
      continue;
    }
    headers[name] = `${prefix}${value!.trim()}`;
  }
  return { headers, missing };
}

/** Expand `${VAR}` urls; undefined when the variable is unset/placeholder. */
export function resolveUrl(url: string, env: Record<string, string | undefined>): string | undefined {
  const m = url.match(ENV_REF);
  if (!m) return url;
  const value = env[m[1]!];
  return isPlaceholder(value) ? undefined : value!.trim();
}
