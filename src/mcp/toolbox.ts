import { MCPClient } from '@mastra/mcp';
import { createTool, type Tool } from '@mastra/core/tools';
import { noopLogger } from '@mastra/core/logger';
import { toStandardSchema } from '@mastra/schema-compat/adapters/json-schema';
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
  /** Called ONCE per outage when a server has been down for `longDownMs` (default 10 min). */
  onDownLong?: (name: string, downForMs: number) => void;
  longDownMs?: number;
  /** Per-tool hooks (e.g. MFP calorie guard). */
  hooks?: ToolHooks;
}

export interface ToolHooks {
  /** Extra, input-dependent approval for a tool (on top of the static policy). */
  approval?(tool: string): ((input: Record<string, unknown>) => boolean | Promise<boolean>) | undefined;
  /** Approval decision that REPLACES the static policy for this tool (e.g. cines_purchase). */
  approvalOverride?(tool: string): ((input: Record<string, unknown>) => boolean | Promise<boolean>) | undefined;
  /** Last checks before the server is called: new args, or a shared-shape error (not called). */
  beforeCall?(tool: string, input: Record<string, unknown>): Promise<{ args: Record<string, unknown> } | { error: unknown }> | undefined;
  /** Adjust a tool's JSON Schema before it is shown to the model and validated (e.g. a field the hub fills). */
  schema?(tool: string, schema: Record<string, unknown>): Record<string, unknown>;
  /** Inspect/transform a tool's normalized result (may be async). */
  afterResult?(tool: string, input: Record<string, unknown>, result: unknown, opts: { raw: boolean }): unknown;
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

/**
 * The server forgot our MCP session (it restarted: `mfpctl restart`, the weekly refresh…).
 * Streamable HTTP servers answer "Session not found" (JSON-RPC -32600, HTTP 400/404) BEFORE
 * dispatching the call, so re-initializing and retrying once is safe, also for writes.
 */
export const SESSION_LOST = /session not found|no valid session|unknown session|session (?:has )?expired|"code"\s*:\s*-32600|\bHTTP 404\b|status(?:Code)?[ :=]+404/i;

/** JSON Schema formats accepted without validation (they are hints for the model). */
const SCHEMA_FORMATS = Object.fromEntries(
  ['uuid', 'date', 'date-time', 'time', 'duration', 'email', 'uri', 'uri-reference', 'url', 'hostname', 'ipv4', 'ipv6', 'regex', 'int32', 'int64', 'float', 'double', 'byte', 'binary', 'password'].map((f) => [f, true]),
) as Record<string, true>;

interface ServerSlot {
  client?: MCPClient;
  /** Raw MCP tools of the CURRENT client (wrapped tools resolve them at call time). */
  raw: Record<string, AnyTool>;
  tools: Record<string, AnyTool>;
  annotations: Record<string, ToolAnnotations | undefined>;
  status: ServerStatus;
  attempts: number;
  lastAttemptAt: number;
  nextAt: number;
  downSince?: number;
  /** When the current state began (for /estado). */
  since: number;
  /** onDownLong already fired for this outage. */
  longNotified?: boolean;
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

  /** Status with the time each state began (for /estado). */
  statusDetail(): Record<string, ServerStatus & { since: number }> {
    return Object.fromEntries(Object.entries(this.slots).map(([n, s]) => [n, { ...s.status, since: s.since }]));
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
    const long = this.opts.longDownMs ?? 10 * 60_000;
    for (const [n, s] of Object.entries(this.slots)) {
      if (s.status.state !== 'down' || s.longNotified || s.downSince === undefined || this.now() - s.downSince < long) continue;
      s.longNotified = true;
      this.opts.onDownLong?.(n, this.now() - s.downSince);
    }
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
        raw: {},
        tools: {},
        annotations: {},
        status: { state: 'skipped', reason: skip ?? 'connecting' },
        attempts: 0,
        lastAttemptAt: -Infinity,
        nextAt: 0,
        since: this.now(),
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
    const rawTools: Record<string, AnyTool> = {};
    const annotations: Record<string, ToolAnnotations | undefined> = {};
    for (const [key, tool] of Object.entries(raw as Record<string, AnyTool>)) {
      if (!key.startsWith(`${name}_`)) continue;
      const pub = publicToolName(name, key.slice(name.length + 1), entry.toolPrefix);
      // the raw MCP tool validates its input too: same schema, with the formats declared
      (tool as { inputSchema?: unknown }).inputSchema = this.schemaFor(pub, (tool as { inputSchema?: unknown }).inputSchema, false);
      rawTools[pub] = tool;
      tools[pub] = this.wrap(pub, name, tool, entry.errorStyle);
      annotations[pub] = (tool as { mcp?: { annotations?: ToolAnnotations } }).mcp?.annotations;
    }
    slot.raw = rawTools;
    slot.tools = tools;
    slot.annotations = annotations;
    const downFor = slot.downSince !== undefined ? this.now() - slot.downSince : undefined;
    slot.attempts = 0;
    slot.downSince = undefined;
    slot.longNotified = false;
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
    if (prev.state !== s.state) slot.since = this.now();
    if (changed) this.log(`[mcp] ${name}: ${s.state}${'reason' in s ? ` (${s.reason})` : ` (${s.tools} tools)`}`);
  }

  private approvalFor(name: string, annotations: ToolAnnotations | undefined) {
    const override = this.opts.hooks?.approvalOverride?.(name);
    if (override) return (input: unknown) => override((input ?? {}) as Record<string, unknown>);
    if (requiresApproval(name, annotations)) return true;
    const dynamic = this.opts.hooks?.approval?.(name);
    return dynamic ? (input: unknown) => dynamic((input ?? {}) as Record<string, unknown>) : false;
  }

  /** True when the static policy gates this tool (destructive / delete-like / named). */
  isGated(name: string): boolean {
    return requiresApproval(name, this.annotationsFor(name));
  }

  /**
   * Run a tool directly with exact args, bypassing the agent and its approval gate (used to
   * execute a plan the user approved). Returns the normalized result or the shared error shape.
   */
  async execute(name: string, args: Record<string, unknown>, opts: { raw?: boolean } = {}): Promise<unknown> {
    const tool = (await this.getTools())[name] as unknown as { execute?: (i: unknown, c: unknown) => Promise<unknown> } | undefined;
    if (!tool?.execute) return sharedError('TOOL_UNAVAILABLE', `${name} is not available right now`, true);
    try {
      return await tool.execute(args, opts.raw ? { hubRaw: true } : {});
    } catch (err) {
      return sharedError('TOOL_ERROR', firstLine((err as Error).message), false);
    }
  }

  /**
   * Call the CURRENT client's tool; if the server lost our session, re-initialize once and
   * retry the same call once (the server rejected it before running anything).
   */
  private async callWithSessionRetry(server: string, name: string, fallback: AnyTool, input: unknown, ctx: unknown): Promise<unknown> {
    const slot = this.slots[server];
    const run = (tool: AnyTool) => (tool.execute as (i: unknown, c: unknown) => Promise<unknown>)(input, ctx);
    const client = slot?.client;
    try {
      return await run(slot?.raw[name] ?? fallback);
    } catch (err) {
      // retry once when the server lost our session, or when another call already replaced
      // the dead client (our request was on the old session, which the server rejects
      // before dispatch, so nothing ran)
      const replaced = !!slot && slot.client !== client;
      if (!slot || (!replaced && !SESSION_LOST.test((err as Error).message ?? ''))) throw err;
      if (!replaced) {
        this.log(`[mcp] ${server}: session lost (server restarted?); reconnecting and retrying ${name} once`);
        await this.connect(server); // parallel calls share one reconnect (in-flight dedup)
      } else if (slot.inflight) await slot.inflight;
      const fresh = slot.raw[name];
      if (!fresh || slot.status.state !== 'up') throw err;
      return run(fresh);
    }
  }

  /**
   * The tool's input schema, rebuilt from its JSON Schema: (1) with the hub's adjustments, and
   * (2) with the JSON Schema string formats MCP servers use (uuid, date…) declared, so Ajv does
   * not log "unknown format ignored" on every call. Formats are hints only, as before.
   */
  private schemaFor(name: string, schema: unknown, adjust = true): unknown {
    const json = (schema as { getSchema?: () => unknown } | undefined)?.getSchema?.();
    if (!json || typeof json !== 'object') return schema;
    let s = structuredClone(json) as Record<string, unknown>;
    if (adjust) s = this.opts.hooks?.schema?.(name, s) ?? s;
    return toStandardSchema(s as never, { ajvOptions: { formats: SCHEMA_FORMATS } });
  }

  private wrap(name: string, server: string, tool: AnyTool, style: ErrorStyle): AnyTool {
    const t = tool as AnyTool & { mcp?: { annotations?: ToolAnnotations } };
    return createTool({
      id: name,
      description: t.description ?? name,
      inputSchema: this.schemaFor(name, t.inputSchema) as never,
      mcp: t.mcp as never,
      requireApproval: this.approvalFor(name, t.mcp?.annotations),
      execute: async (given: unknown, ctx: unknown) => {
        try {
          let input = given;
          const before = await this.opts.hooks?.beforeCall?.(name, (given ?? {}) as Record<string, unknown>);
          if (before && 'error' in before) return before.error;
          if (before) input = before.args;
          const out = normalizeResult(await this.callWithSessionRetry(server, name, t, input, ctx), style);
          const hook = this.opts.hooks?.afterResult;
          const raw = (ctx as { hubRaw?: boolean } | undefined)?.hubRaw === true; // hub-internal call: full, untrimmed result
          if (!hook) return out;
          const hooked = await hook(name, (input ?? {}) as Record<string, unknown>, out, { raw }); // side effects (guards) always run
          return raw ? out : hooked;
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
