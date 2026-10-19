import { MCPClient } from '@mastra/mcp';
import { createTool, type Tool } from '@mastra/core/tools';
import { noopLogger } from '@mastra/core/logger';
import { assertTransportSecurity, resolveHeaders, resolveUrl, type Registry } from './registry.js';
import { requiresApproval } from '../approvals.js';
import { mapToolErrorText, sharedError, unavailableError, type ErrorStyle } from './errors.js';

export type ServerStatus =
  | { state: 'up'; tools: number }
  | { state: 'down'; reason: string }
  | { state: 'skipped'; reason: string };

export interface ToolboxOptions {
  log?: (m: string) => void;
  now?: () => number;
  perServerTimeoutMs?: number;
  /** Called when a server that was down is reachable again. */
  onRecovered?: (name: string, downForMs: number) => void;
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

/** Retry schedule for a server that is down: 60 s, then ×2 up to 10 min. */
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 10 * 60_000;
/** On an incoming message, retry a down server if the last attempt is at least this old. */
export const ON_DEMAND_GAP_MS = 15_000;

interface ServerSlot {
  client?: MCPClient;
  tools: Record<string, AnyTool>;
  annotations: Record<string, ToolAnnotations | undefined>;
  status: ServerStatus;
  attempts: number;
  lastAttemptAt: number;
  nextAt: number;
  downSince?: number;
  inflight?: Promise<void>;
}

let clientSeq = 0;

/**
 * Builds the agent's MCP tools from the registry, one MCP client per server. Never throws:
 * an unreachable server is reported in `status()` and retried on its own (in the background
 * with backoff via `tick()`, and on the next message), while healthy servers keep their
 * connections. Recovered servers' tools appear without a restart.
 */
export class McpToolbox {
  private slots: Record<string, ServerSlot> = {};
  private started = false;
  private initial?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private readonly log: (m: string) => void;
  private readonly now: () => number;

  constructor(
    private readonly registry: Registry,
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly opts: ToolboxOptions = {},
  ) {
    this.log = opts.log ?? ((m) => console.warn(m));
    this.now = opts.now ?? Date.now;
  }

  status(): Record<string, ServerStatus> {
    return Object.fromEntries(Object.entries(this.slots).map(([n, s]) => [n, s.status]));
  }

  retryInfo(): Record<string, { attempts: number; nextAt: number }> {
    return Object.fromEntries(
      Object.entries(this.slots)
        .filter(([, s]) => s.status.state === 'down')
        .map(([n, s]) => [n, { attempts: s.attempts, nextAt: s.nextAt }]),
    );
  }

  annotationsFor(publicName: string): ToolAnnotations | undefined {
    for (const s of Object.values(this.slots)) if (publicName in s.annotations) return s.annotations[publicName];
    return undefined;
  }

  /** One line for the system prompt when some apps are unavailable; '' when all is well. */
  statusNote(): string {
    const down = Object.entries(this.slots).filter(([, s]) => s.status.state === 'down').map(([n]) => n);
    if (down.length === 0) return '';
    return `These apps are currently unavailable: ${down.join(', ')}. If the user asks for them, say so briefly instead of guessing.`;
  }

  /**
   * Tools for the next model call. Called on every message: down servers whose last attempt
   * is older than ON_DEMAND_GAP_MS are retried first, so an app that came back is usable
   * right away.
   */
  async getTools(): Promise<Record<string, AnyTool>> {
    await this.ensureStarted();
    const now = this.now();
    const due = Object.entries(this.slots).filter(([, s]) => s.status.state === 'down' && now - s.lastAttemptAt >= ON_DEMAND_GAP_MS);
    await Promise.all(due.map(([n]) => this.connect(n)));
    return this.allTools();
  }

  /** Background retry step: reconnect down servers whose backoff has elapsed. */
  async tick(): Promise<void> {
    await this.ensureStarted();
    const now = this.now();
    const due = Object.entries(this.slots).filter(([, s]) => s.status.state === 'down' && now >= s.nextAt);
    await Promise.all(due.map(([n]) => this.connect(n)));
  }

  /** Start background retries (every `intervalMs` checks which servers are due). */
  startBackgroundRetry(intervalMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), intervalMs);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all(Object.values(this.slots).map((s) => s.client?.disconnect().catch(() => {})));
    for (const s of Object.values(this.slots)) s.client = undefined;
  }

  private allTools(): Record<string, AnyTool> {
    return Object.assign({}, ...Object.values(this.slots).map((s) => s.tools));
  }

  private ensureStarted(): Promise<void> {
    if (this.started) return this.initial ?? Promise.resolve();
    this.started = true;
    const toConnect: string[] = [];
    for (const [name, entry] of Object.entries(this.registry.servers)) {
      const skip = this.skipReason(name, entry);
      this.slots[name] = {
        tools: {},
        annotations: {},
        status: { state: 'skipped', reason: skip ?? 'connecting' },
        attempts: 0,
        lastAttemptAt: -Infinity,
        nextAt: 0,
      };
      if (skip) this.log(`[mcp] ${name}: skipped (${skip})`);
      else toConnect.push(name);
    }
    this.initial = Promise.all(toConnect.map((n) => this.connect(n))).then(() => undefined);
    return this.initial;
  }

  private skipReason(name: string, entry: Registry['servers'][string]): string | undefined {
    if (!entry.enabled) return 'disabled';
    const url = resolveUrl(entry.url, this.env);
    if (!url) return `not configured on this machine (${entry.url})`;
    try {
      assertTransportSecurity(name, url);
    } catch (err) {
      return (err as Error).message;
    }
    const { missing } = resolveHeaders(entry.headers, this.env);
    if (missing.length) return `missing secret(s): ${missing.join(', ')}`;
    return undefined;
  }

  private connect(name: string): Promise<void> {
    const slot = this.slots[name]!;
    slot.inflight ??= this.doConnect(name).finally(() => (slot.inflight = undefined));
    return slot.inflight;
  }

  private async doConnect(name: string): Promise<void> {
    const slot = this.slots[name]!;
    const entry = this.registry.servers[name]!;
    slot.lastAttemptAt = this.now();
    slot.attempts++;
    await slot.client?.disconnect().catch(() => {});
    const url = resolveUrl(entry.url, this.env)!;
    const { headers } = resolveHeaders(entry.headers, this.env);
    const client = new MCPClient({
      id: `assistant-hub-${name}-${++clientSeq}`,
      servers: {
        [name]: {
          url: new URL(url),
          requestInit: { headers },
          timeout: entry.timeoutMs,
          connectTimeout: entry.timeoutMs,
          onToolError: 'return',
          logger: () => {},
        },
      },
      clientInfo: { name: 'assistant-hub', version: '0.1.0' },
    });
    client.__setLogger(noopLogger); // failures are summarized by our own [mcp] log lines
    slot.client = client;
    const { tools: raw, errors } = await client
      .listToolsWithErrors({ perServerTimeoutMs: this.opts.perServerTimeoutMs ?? 10_000 })
      .catch((err: Error) => ({ tools: {}, errors: { [name]: err.message } as Record<string, string> }));
    const err = (errors as Record<string, string>)[name];
    if (err) {
      slot.tools = slot.status.state === 'up' ? slot.tools : {};
      this.markDown(name, firstLine(err));
      return;
    }
    const tools: Record<string, AnyTool> = {};
    const annotations: Record<string, ToolAnnotations | undefined> = {};
    for (const [key, tool] of Object.entries(raw as Record<string, AnyTool>)) {
      if (!key.startsWith(`${name}_`)) continue;
      const pub = publicToolName(name, key.slice(name.length + 1), entry.toolPrefix);
      tools[pub] = this.wrap(pub, name, tool, entry.errorStyle);
      annotations[pub] = (tool as { mcp?: { annotations?: ToolAnnotations } }).mcp?.annotations;
    }
    slot.tools = tools;
    slot.annotations = annotations;
    const downFor = slot.downSince !== undefined ? this.now() - slot.downSince : undefined;
    slot.attempts = 0;
    slot.downSince = undefined;
    this.setStatus(name, { state: 'up', tools: Object.keys(tools).length });
    if (downFor !== undefined) this.opts.onRecovered?.(name, downFor);
  }

  private markDown(name: string, reason: string): void {
    const slot = this.slots[name]!;
    slot.downSince ??= this.now();
    const delay = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, slot.attempts - 1), RETRY_MAX_MS);
    slot.nextAt = this.now() + delay;
    this.setStatus(name, { state: 'down', reason });
  }

  private setStatus(name: string, s: ServerStatus): void {
    const slot = this.slots[name]!;
    const prev = slot.status;
    slot.status = s;
    const changed = prev.state !== s.state || ('reason' in prev && prev.reason === 'connecting');
    if (changed) this.log(`[mcp] ${name}: ${s.state}${'reason' in s ? ` (${s.reason})` : ` (${s.tools} tools)`}`);
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
          const reason = firstLine((err as Error).message);
          const slot = this.slots[server];
          if (slot && slot.status.state === 'up') {
            slot.attempts = 1;
            slot.lastAttemptAt = this.now();
            this.markDown(server, reason); // keeps its tools listed; retried on next message / tick
          }
          return unavailableError(style, server, reason);
        }
      },
    }) as unknown as AnyTool;
  }
}

function firstLine(s: string): string {
  return s.split('\n')[0]!.slice(0, 200);
}
