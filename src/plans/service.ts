import { HUB_ONLY_TOOLS, MONEY_TOOLS } from '../cines/contract.js';
import type { Language, Voice } from '../persona.js';
import { sharedError } from '../mcp/errors.js';
import { usageContext } from '../telemetry/context.js';
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
  execute(name: string, args: Record<string, unknown>, opts?: { raw?: boolean }): Promise<unknown>;
}

const MEAL_ALIASES: Record<string, string> = { desayuno: 'breakfast', almuerzo: 'lunch', comida: 'lunch', cena: 'dinner', onces: 'snacks', merienda: 'snacks', snack: 'snacks' };
const mealKey = (m: unknown) => {
  const k = String(m ?? '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim();
  return MEAL_ALIASES[k] ?? k;
};

/**
 * For a "delete everything" request: diary entries of the plan's meals (or the whole day when
 * the deletes carry no meal) that no action covers. Uses the full fitness_get_day result.
 */
export async function missingFromDeletePlan(input: PlanInput, toolbox: PlanToolbox): Promise<string[] | undefined> {
  const actions = input.groups.flatMap((g) => g.actions);
  if (!actions.length || !actions.every((a) => a.tool === 'fitness_delete_food')) return undefined;
  const date = actions.find((a) => typeof a.args.date === 'string')?.args.date as string | undefined;
  const day = (await toolbox.execute('fitness_get_day', date ? { date } : {}, { raw: true })) as { diary?: { meal?: string; name?: string }[] } | undefined;
  if (!day || !Array.isArray(day.diary)) return undefined;
  const meals = new Set(actions.map((a) => mealKey(a.args.meal)).filter(Boolean));
  const scope = day.diary.filter((e) => !meals.size || meals.has(mealKey(e.meal)));
  const remaining = [...actions];
  const missing: string[] = [];
  for (const e of scope) {
    const name = String(e.name ?? '').toLowerCase();
    const i = remaining.findIndex((a) => name.includes(String(a.args.query ?? '').toLowerCase()) && (!a.args.meal || mealKey(a.args.meal) === mealKey(e.meal)));
    if (i >= 0) remaining.splice(i, 1);
    else missing.push(`${e.name} (${e.meal})`);
  }
  return missing;
}

export interface PlanServiceDeps {
  store: PlanStore;
  toolbox: PlanToolbox;
  presenter: PlanPresenter;
  voice: Voice;
  language: Language;
  allowedUserIds: readonly string[];
  /** Unused: the result message is deterministic (kept for compatibility). */
  summarize?(plan: StoredPlan, results: ActionResult[]): Promise<string | undefined>;
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

/** The result message, built ONLY from the hub's execution results (never from model text). */
export function fallbackSummary(plan: StoredPlan, results: ActionResult[], lang: Language = 'es'): string {
  const ok = results.filter((r) => r.status === 'ok').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const es = lang === 'es';
  const head = [`✅ ${ok}/${results.length} ${es ? 'ejecutadas' : 'done'}`, failed ? `❌ ${failed} ${es ? 'fallaron' : 'failed'}` : '', skipped ? `⏭️ ${skipped} ${es ? 'omitidas' : 'skipped'}` : '']
    .filter(Boolean)
    .join(' · ');
  return [
    `📋 ${plan.title}: ${head}`,
    ...results.filter((r) => r.status !== 'ok').map((r) => `${r.status === 'skipped' ? '⏭️' : '❌'} ${r.n}. ${r.summary}${r.error ? ` (${r.error.code}: ${r.error.message})` : ''}`),
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
    if (usageContext.getStore()?.intent === 'plan') {
      const missing = await missingFromDeletePlan(input, this.d.toolbox).catch(() => undefined);
      if (missing?.length) {
        this.log(`[plan] incomplete delete-all plan: missing ${missing.length}`);
        return sharedError(
          'PLAN_INCOMPLETE',
          `The user asked to delete everything, but the diary also has: ${missing.join(', ')}. Call propose_plan again with ALL entries (one fitness_delete_food per entry).`,
          false,
        );
      }
    }

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

    await this.d.presenter.say(fallbackSummary(plan, results, this.d.language));
  }

  private async validate(input: PlanInput): Promise<string[]> {
    const problems: string[] = [];
    const actions = input.groups.flatMap((g) => g.actions);
    if (actions.length === 0) problems.push('the plan has no actions');
    if (actions.length > MAX_PLAN_ACTIONS) problems.push(`at most ${MAX_PLAN_ACTIONS} actions per plan`);
    const tools = (await this.d.toolbox.getTools()) as Record<string, ToolLike>;
    actions.forEach((a, i) => {
      if (a.tool === PROPOSE_PLAN) return void problems.push(`action ${i + 1}: a plan cannot contain propose_plan`);
      if (MONEY_TOOLS.has(a.tool) || HUB_ONLY_TOOLS.has(a.tool)) return void problems.push(`action ${i + 1}: ${a.tool} cannot be part of a plan (it has its own approval); call it directly`);
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
