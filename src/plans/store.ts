import { createHash, randomBytes } from 'node:crypto';
import type { KvStore } from '../kv.js';
import type { PlanInput, StoredPlan } from './types.js';

export const PLAN_TTL_MS = 30 * 60_000;
const KEEP_MS = 2 * 24 * 60 * 60_000;

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** Fingerprint of exactly what the user sees and approves (title + every tool, args, summary). */
export function planHash(plan: PlanInput): string {
  const body = {
    title: plan.title,
    ...(plan.compact ? { compact: true } : {}),
    groups: plan.groups.map((g) => ({ label: g.label, ...(g.summary ? { summary: g.summary } : {}), actions: g.actions.map((a) => ({ tool: a.tool, args: a.args, summary: a.summary })) })),
  };
  return createHash('sha256').update(JSON.stringify(stable(body))).digest('hex');
}

/** Pending plans in LibSQL (via KvStore), so they survive restarts. */
export class PlanStore {
  constructor(
    private readonly kv: KvStore,
    private readonly now: () => number = Date.now,
    readonly ttlMs = PLAN_TTL_MS,
  ) {}

  async create(input: PlanInput, meta: { owner: string; threadId?: string }): Promise<StoredPlan> {
    const plan: StoredPlan = {
      id: randomBytes(6).toString('base64url'),
      title: input.title,
      groups: input.groups,
      ...(input.compact ? { compact: true } : {}),
      hash: planHash(input),
      status: 'pending',
      owner: meta.owner,
      threadId: meta.threadId,
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
      messageIds: [],
    };
    await this.save(plan);
    const open = (await this.kv.get<string[]>(this.openKey(meta.owner))) ?? [];
    await this.kv.set(this.openKey(meta.owner), [...open.slice(-20), plan.id], KEEP_MS);
    return plan;
  }

  get(id: string): Promise<StoredPlan | null> {
    return this.kv.get<StoredPlan>(`plan:${id}`);
  }

  save(plan: StoredPlan): Promise<void> {
    return this.kv.set(`plan:${plan.id}`, plan, KEEP_MS);
  }

  /** True when the stored actions are exactly the ones that were shown. */
  verify(plan: StoredPlan): boolean {
    return planHash(plan) === plan.hash;
  }

  isExpired(plan: StoredPlan): boolean {
    return this.now() > plan.expiresAt;
  }

  /** Plans of this owner still waiting for a decision (pending or being edited). */
  async open(owner: string): Promise<StoredPlan[]> {
    const ids = (await this.kv.get<string[]>(this.openKey(owner))) ?? [];
    const plans = await Promise.all(ids.map((id) => this.get(id)));
    return plans.filter((p): p is StoredPlan => !!p && (p.status === 'pending' || p.status === 'editing'));
  }

  /** Exactly-once execution claim (a double tap runs the plan once). */
  claimRun(id: string): Promise<boolean> {
    return this.kv.setIfNotExists(`plan:${id}:run`, this.now(), KEEP_MS);
  }

  private openKey(owner: string) {
    return `plans:open:${owner}`;
  }
}
