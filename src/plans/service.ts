import type { Language, Voice } from '../persona.js';
import { sharedError } from '../mcp/errors.js';
import type { PlanPresenter } from './presenter.js';
import type { PlanStore } from './store.js';
import type { ActionResult, PlanInput, StoredPlan } from './types.js';

export const PROPOSE_PLAN = 'propose_plan';
export const MAX_PLAN_ACTIONS = 100;
/** Stop the rest of a plan on these: retrying the remaining calls can't work. */
export const STOP_CODES = new Set(['MFP_SESSION_EXPIRED', 'UNAUTHORIZED']);

type ToolLike = { execute?: unknown; inputSchema?: { safeParse?: (v: unknown) => { success: boolean; error?: { issues?: { path: unknown[]; message: string }[] } } } };

export interface PlanToolbox {
  getTools(): Promise<Record<string, unknown>>;
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface PlanServiceDeps {
  store: PlanStore;
  toolbox: PlanToolbox;
  presenter: PlanPresenter;
  voice: Voice;
  language: Language;
  allowedUserIds: readonly string[];
  /** Ask the agent for ONE summary of the results (returns undefined to use the fallback). */
  summarize(plan: StoredPlan, results: ActionResult[]): Promise<string | undefined>;
  log?: (m: string) => void;
}

const T = {
  es: {
    unknown: '⛔ Ese plan ya no está disponible; no se ejecutó nada.',
    tampered: '⛔ El plan cambió después de proponerse; no se ejecutó nada. Pídamelo de nuevo.',
    expired: '⌛ Este plan caducó; no se ejecutó nada. Pídamelo de nuevo.',
    notPending: (s: string) => `⛔ Ese plan ya no está pendiente (${s}); no se ejecutó nada.`,
    running: (n: number) => `⏳ Ejecutando ${n} acciones…`,
    done: (ok: number, total: number, failed: number, skipped: number) =>
      failed + skipped === 0 ? `✅ Hecho: ${ok}/${total}` : `⚠️ Hecho ${ok}/${total}: ${failed} fallaron, ${skipped} omitidas`,
    cancelled: '❌ Cancelado. No se ejecutó nada.',
    editing: '✏️ En edición: este plan ya no se puede aprobar.',
    superseded: '↪️ Reemplazado por un plan nuevo.',
  },
  en: {
    unknown: '⛔ That plan is no longer available; nothing was run.',
    tampered: '⛔ The plan changed after it was proposed; nothing was run. Please ask again.',
    expired: '⌛ This plan expired; nothing was run. Please ask again.',
    notPending: (s: string) => `⛔ That plan is no longer pending (${s}); nothing was run.`,
    running: (n: number) => `⏳ Running ${n} actions…`,
    done: (ok: number, total: number, failed: number, skipped: number) =>
      failed + skipped === 0 ? `✅ Done: ${ok}/${total}` : `⚠️ Done ${ok}/${total}: ${failed} failed, ${skipped} skipped`,
    cancelled: '❌ Cancelled. Nothing was run.',
    editing: '✏️ Being edited: this plan can no longer be approved.',
    superseded: '↪️ Replaced by a new plan.',
  },
};

function errorOf(v: unknown): ActionResult['error'] | undefined {
  const e = (v as { error?: { code?: unknown; message?: unknown; retryable?: unknown } } | undefined)?.error;
  if (!e || typeof e !== 'object' || typeof e.code !== 'string') return undefined;
  return { code: e.code, message: String(e.message ?? ''), retryable: e.retryable === true };
}

/** What the agent is asked to summarize after a plan ran. */
export function planResultsPrompt(plan: StoredPlan, results: ActionResult[]): string {
  const compact = results.map((r) => ({ n: r.n, action: r.summary, status: r.status, ...(r.error ? { error: r.error } : {}) }));
  return [
    `[Plan "${plan.title}" (${plan.id}) was approved by the user with "Approve all" and the hub has executed it.]`,
    'Results, in order:',
    JSON.stringify(compact),
    'Write ONE short message for the user: how many actions succeeded, then each failure or skipped action with its error code and message, and what to do next if anything failed. Do not call any tools.',
  ].join('\n');
}

export function fallbackSummary(plan: StoredPlan, results: ActionResult[]): string {
  const ok = results.filter((r) => r.status === 'ok').length;
  const bad = results.filter((r) => r.status !== 'ok');
  return [
    `📋 ${plan.title}: ${ok}/${results.length} ✓`,
    ...bad.map((r) => `${r.status === 'skipped' ? '⏭️' : '❌'} ${r.n}. ${r.summary}${r.error ? ` (${r.error.code}: ${r.error.message})` : ''}`),
  ].join('\n');
}

/**
 * Batch approval: the agent proposes ONE plan of tool calls; the user approves all of it,
 * edits it or cancels it; on approval the hub runs exactly the stored calls (verified by hash)
 * in order, without asking the model again, then asks the agent for one summary.
 */
export class PlanService {
  private readonly log: (m: string) => void;
  private readonly t;

  constructor(private readonly d: PlanServiceDeps) {
    this.log = d.log ?? ((m) => console.warn(m));
    this.t = T[d.language];
  }

  get store(): PlanStore {
    return this.d.store;
  }

  /** propose_plan tool body. Returns what the model sees. */
  async propose(input: PlanInput, meta: { owner: string; threadId?: string }): Promise<unknown> {
    const problems = await this.validate(input);
    if (problems.length) return sharedError('PLAN_INVALID', problems.slice(0, 10).join('; '), false);

    for (const old of await this.d.store.open(meta.owner)) {
      old.status = 'superseded';
      await this.d.store.save(old);
      await this.d.presenter.update(old, this.t.superseded);
    }
    const plan = await this.d.store.create(input, meta);
    plan.messageIds = await this.d.presenter.show(plan);
    await this.d.store.save(plan);
    const total = input.groups.reduce((a, g) => a + g.actions.length, 0);
    this.log(`[plan] ${plan.id} proposed: ${total} actions`);
    return {
      plan_id: plan.id,
      status: 'shown_to_user',
      actions: total,
      note: 'The user now sees this plan with Approve all / Edit / Cancel buttons. Do NOT call these tools yourself. Reply with one short line and stop. After approval the hub runs exactly these calls and sends you the results to summarize. If the user asks for changes, call propose_plan again with the full revised plan.',
    };
  }

  /** Button press from Telegram: plan:<a|e|c>:<id>. */
  async handleAction(actionId: string, userId: string | undefined): Promise<void> {
    const m = actionId.match(/^plan:([aec]):([\w-]{4,32})$/);
    if (!m) return;
    const [, kind, id] = m as unknown as [string, 'a' | 'e' | 'c', string];
    if (!userId || !this.d.allowedUserIds.includes(String(userId))) {
      this.log(`[plan] ignoring button from non-allowlisted user ${userId}`);
      return;
    }
    const plan = await this.d.store.get(id);
    if (!plan) return void (await this.d.presenter.say(this.t.unknown));
    if (!this.d.store.verify(plan)) {
      this.log(`[plan] ${id} hash mismatch; refusing`);
      plan.status = 'invalid';
      await this.d.store.save(plan);
      return void (await this.d.presenter.update(plan, this.t.tampered));
    }
    if (plan.status !== 'pending') return void (await this.d.presenter.say(this.t.notPending(plan.status)));
    if (this.d.store.isExpired(plan)) {
      plan.status = 'expired';
      await this.d.store.save(plan);
      return void (await this.d.presenter.update(plan, this.t.expired));
    }
    if (kind === 'c') {
      plan.status = 'cancelled';
      await this.d.store.save(plan);
      return void (await this.d.presenter.update(plan, this.t.cancelled));
    }
    if (kind === 'e') {
      plan.status = 'editing';
      await this.d.store.save(plan);
      await this.d.presenter.update(plan, this.t.editing);
      return void (await this.d.presenter.say(this.d.voice.planEdit()));
    }
    await this.approve(plan);
  }

  private async approve(plan: StoredPlan): Promise<void> {
    if (!(await this.d.store.claimRun(plan.id))) return; // double tap
    const total = plan.groups.reduce((a, g) => a + g.actions.length, 0);
    plan.status = 'running';
    await this.d.store.save(plan);
    await this.d.presenter.update(plan, this.t.running(total));

    const tools = await this.d.toolbox.getTools();
    const results: ActionResult[] = [];
    let stopped = false;
    let n = 0;
    for (const g of plan.groups) {
      for (const a of g.actions) {
        n++;
        const base = { n, tool: a.tool, summary: a.summary };
        if (stopped) {
          results.push({ ...base, status: 'skipped', error: { code: 'SKIPPED', message: 'not run: an earlier action stopped the plan', retryable: true } });
          continue;
        }
        if (a.tool === PROPOSE_PLAN || !tools[a.tool]) {
          results.push({ ...base, status: 'failed', error: { code: 'TOOL_UNAVAILABLE', message: `${a.tool} is not available right now`, retryable: true } });
          continue;
        }
        const r = await this.d.toolbox.execute(a.tool, structuredClone(a.args));
        const error = errorOf(r);
        results.push(error ? { ...base, status: 'failed', error } : { ...base, status: 'ok', result: r });
        if (error && STOP_CODES.has(error.code)) stopped = true;
      }
    }
    const ok = results.filter((r) => r.status === 'ok').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    plan.status = 'done';
    await this.d.store.save(plan);
    await this.d.presenter.update(plan, this.t.done(ok, total, failed, total - ok - failed));
    this.log(`[plan] ${plan.id} done: ${ok}/${total}`);

    let summary: string | undefined;
    try {
      summary = (await this.d.summarize(plan, results))?.trim();
    } catch (err) {
      this.log(`[plan] summary failed: ${(err as Error).message}`);
    }
    await this.d.presenter.say(summary || fallbackSummary(plan, results));
  }

  private async validate(input: PlanInput): Promise<string[]> {
    const problems: string[] = [];
    const actions = input.groups.flatMap((g) => g.actions);
    if (actions.length === 0) problems.push('the plan has no actions');
    if (actions.length > MAX_PLAN_ACTIONS) problems.push(`at most ${MAX_PLAN_ACTIONS} actions per plan`);
    const tools = (await this.d.toolbox.getTools()) as Record<string, ToolLike>;
    actions.forEach((a, i) => {
      if (a.tool === PROPOSE_PLAN) return void problems.push(`action ${i + 1}: a plan cannot contain propose_plan`);
      const tool = tools[a.tool];
      if (!tool) return void problems.push(`action ${i + 1}: unknown tool ${a.tool}`);
      const check = tool.inputSchema?.safeParse?.(a.args);
      if (check && !check.success) {
        const issue = check.error?.issues?.[0];
        problems.push(`action ${i + 1} (${a.tool}): invalid args${issue ? ` at ${issue.path.join('.') || '(root)'}: ${issue.message}` : ''}`);
      }
    });
    return problems;
  }
}
