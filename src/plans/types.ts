export interface PlanAction {
  tool: string;
  args: Record<string, unknown>;
  /** One scannable line, e.g. "Eggs, 2 large — 144 kcal" or "Almuerzo — 25.000 COP — Nequi". */
  summary: string;
}

export interface PlanGroup {
  label: string;
  actions: PlanAction[];
}

export interface PlanInput {
  title: string;
  groups: PlanGroup[];
}

export type PlanStatus = 'pending' | 'editing' | 'running' | 'done' | 'cancelled' | 'superseded' | 'expired' | 'invalid';

export interface StoredPlan extends PlanInput {
  id: string;
  hash: string;
  status: PlanStatus;
  /** Memory resource (e.g. telegram:<id>) and thread the plan was proposed in. */
  owner: string;
  threadId?: string;
  createdAt: number;
  expiresAt: number;
  /** Telegram messages showing the plan (buttons are on the last one). */
  messageIds: number[];
}

export interface ActionResult {
  n: number;
  tool: string;
  summary: string;
  status: 'ok' | 'failed' | 'skipped';
  result?: unknown;
  error?: { code: string; message: string; retryable: boolean };
}
