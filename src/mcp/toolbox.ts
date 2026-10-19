import { MCPClient } from '@mastra/mcp';
import { createTool, type Tool } from '@mastra/core/tools';
import { noopLogger } from '@mastra/core/logger';
import { resolveHeaders, resolveUrl, type Registry } from './registry.js';
import { requiresApproval } from '../approvals.js';
import { mapToolErrorText, sharedError, unavailableError, type ErrorStyle } from './errors.js';

export type ServerStatus =
  | { state: 'up'; tools: number }
  | { state: 'down'; reason: string }
  | { state: 'skipped'; reason: string };

export interface ToolboxOptions {
  log?: (m: string) => void;
  now?: () => number;
  /** How often to retry discovery (servers that were down come back). */
  refreshMs?: number;
  perServerTimeoutMs?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP tools are schema-less at compile time
type AnyTool = Tool<any, any, any, any, any, any, any>;
export type ToolAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };

export { sharedError };

/**
 * Unwrap an MCP CallToolResult into the plain value the tool produced:
 * structuredContent, else a single JSON text block parsed, else the text.
 * `isError` results are mapped to the shared error shape.
 */
export function normalizeResult(result: unknown, style: ErrorStyle = 'default'): unknown {
  if (!result || typeof result !== 'object' || !('content' in result || 'structuredContent' in result)) return result;
  const r = result as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
  let value: unknown = r.structuredContent;
  if (value === undefined) {
    const texts = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '');
    const joined = texts.join('\n');
    try {
      value = texts.length === 1 ? JSON.parse(joined) : joined;
    } catch {
      value = joined;
    }
  }
  if (r.isError) {
    const already = value && typeof value === 'object' && 'error' in value;
    return already ? value : mapToolErrorText(style, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return value;
}

/**
 * `finance_create_movement` stays as is on server "finance"; `say` on "echo" becomes `echo_say`.
 * `prefix` overrides the server name (Mason is registered as "mfp" but its tools are fitness_*).
 */
export function publicToolName(server: string, toolName: string, prefix: string = server): string {
  return toolName.startsWith(`${prefix}_`) ? toolName : `${prefix}_${toolName}`;
}

/**
 * Builds the agent's MCP tools from the registry. Never throws: unreachable servers are
 * reported in `status()` and retried after `refreshMs`, and the hub keeps running.
 */
export class McpToolbox {
  private client?: MCPClient;
  private tools: Record<string, AnyTool> = {};
  private annotations: Record<string, ToolAnnotations | undefined> = {};
  private statuses: Record<string, ServerStatus> = {};
  private lastRefresh = -Infinity;
  private inflight?: Promise<void>;
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private readonly refreshMs: number;

  constructor(
    private readonly registry: Registry,
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly opts: ToolboxOptions = {},
  ) {
    this.log = opts.log ?? ((m) => console.warn(m));
    this.now = opts.now ?? Date.now;
    this.refreshMs = opts.refreshMs ?? 60_000;
  }

  status(): Record<string, ServerStatus> {
    return { ...this.statuses };
  }

  annotationsFor(publicName: string): ToolAnnotations | undefined {
    return this.annotations[publicName];
  }

  /** One line for the system prompt when some apps are unavailable; '' when all is well. */
  statusNote(): string {
    const down = Object.entries(this.statuses).filter(([, s]) => s.state === 'down').map(([n]) => n);
    if (down.length === 0) return '';
    return `These apps are currently unavailable: ${down.join(', ')}. If the user asks for them, say so briefly instead of guessing.`;
  }

  async getTools(): Promise<Record<string, AnyTool>> {
    const first = this.lastRefresh === -Infinity;
    const anyDown = Object.values(this.statuses).some((s) => s.state === 'down');
    // Only re-discover when something is down, so healthy connections aren't torn down mid-call.
    if (first || (anyDown && this.now() - this.lastRefresh >= this.refreshMs)) {
      this.inflight ??= this.refresh().finally(() => (this.inflight = undefined));
      await this.inflight;
    }
    return this.tools;
  }

  async close(): Promise<void> {
    await this.client?.disconnect().catch(() => {});
    this.client = undefined;
  }

  private async refresh(): Promise<void> {
    this.lastRefresh = this.now();
    const servers: Record<string, ConstructorParameters<typeof MCPClient>[0]['servers'][string]> = {};
    const statuses: Record<string, ServerStatus> = {};

    for (const [name, entry] of Object.entries(this.registry.servers)) {
      if (!entry.enabled) {
        statuses[name] = { state: 'skipped', reason: 'disabled' };
        continue;
      }
      const url = resolveUrl(entry.url, this.env);
      if (!url) {
        statuses[name] = { state: 'skipped', reason: `url not configured (${entry.url})` };
        continue;
      }
      const { headers, missing } = resolveHeaders(entry.headers, this.env);
      if (missing.length) {
        statuses[name] = { state: 'skipped', reason: `missing secret(s): ${missing.join(', ')}` };
        continue;
      }
      servers[name] = {
        url: new URL(url),
        requestInit: { headers },
        timeout: entry.timeoutMs,
        connectTimeout: entry.timeoutMs,
        onToolError: 'return',
        logger: () => {},
      };
    }

    await this.close();
    const tools: Record<string, AnyTool> = {};
    const annotations: Record<string, ToolAnnotations | undefined> = {};

    if (Object.keys(servers).length > 0) {
      this.client = new MCPClient({ id: `assistant-hub-${this.lastRefresh}`, servers, clientInfo: { name: 'assistant-hub', version: '0.1.0' } });
      this.client.__setLogger(noopLogger); // failures are summarized by our own [mcp] log lines
      const { tools: raw, errors } = await this.client
        .listToolsWithErrors({ perServerTimeoutMs: this.opts.perServerTimeoutMs ?? 10_000 })
        .catch((err: Error) => ({ tools: {}, errors: Object.fromEntries(Object.keys(servers).map((n) => [n, err.message])) }));

      const counts: Record<string, number> = {};
      for (const [key, tool] of Object.entries(raw as Record<string, AnyTool>)) {
        const server = Object.keys(servers).find((s) => key.startsWith(`${s}_`));
        if (!server) continue;
        const entry = this.registry.servers[server]!;
        const name = publicToolName(server, key.slice(server.length + 1), entry.toolPrefix);
        tools[name] = this.wrap(name, server, tool, entry.errorStyle);
        annotations[name] = (tool as { mcp?: { annotations?: ToolAnnotations } }).mcp?.annotations;
        counts[server] = (counts[server] ?? 0) + 1;
      }
      for (const name of Object.keys(servers)) {
        const err = (errors as Record<string, string>)[name];
        statuses[name] = err ? { state: 'down', reason: firstLine(err) } : { state: 'up', tools: counts[name] ?? 0 };
      }
    }

    for (const [name, s] of Object.entries(statuses)) {
      const prev = this.statuses[name]?.state;
      if (s.state !== prev) this.log(`[mcp] ${name}: ${s.state}${'reason' in s ? ` (${s.reason})` : ` (${s.tools} tools)`}`);
    }
    this.tools = tools;
    this.annotations = annotations;
    this.statuses = statuses;
  }

  private wrap(name: string, server: string, tool: AnyTool, style: ErrorStyle): AnyTool {
    const t = tool as AnyTool & { mcp?: { annotations?: ToolAnnotations } };
    return createTool({
      id: name,
      description: t.description ?? name,
      inputSchema: t.inputSchema as never,
      mcp: t.mcp as never,
      requireApproval: requiresApproval(name, t.mcp?.annotations),
      execute: async (input: unknown, ctx: unknown) => {
        try {
          return normalizeResult(await (t.execute as (i: unknown, c: unknown) => Promise<unknown>)(input, ctx), style);
        } catch (err) {
          this.statuses[server] = { state: 'down', reason: firstLine((err as Error).message) };
          return unavailableError(style, server, firstLine((err as Error).message));
        }
      },
    }) as unknown as AnyTool;
  }
}

function firstLine(s: string): string {
  return s.split('\n')[0]!.slice(0, 200);
}
