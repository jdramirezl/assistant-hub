/**
 * Balance adjustments ("ajusta los saldos a lo de la foto") as ONE approval card. The model gives
 * each pocket's NEW balance (or the delta); the hub reads the current balances itself (fresh),
 * computes the deltas and proposes one batch plan of finance_create_movement calls (income for a
 * rise, expense for a drop), grouped by account: "Cajita Turbo: 5.000 → 5.069,45 (+69,45)".
 * Nothing is written before the user approves.
 */
import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import type { FinanceDirectory } from './finance-cache.js';
import type { PlanInput } from '../plans/types.js';
import type { Language } from '../persona.js';

export interface AdjustDeps {
  directory: Pick<FinanceDirectory, 'snapshot' | 'repairPocket'>;
  propose(input: PlanInput, meta: { owner: string; threadId?: string; trusted?: boolean }): Promise<unknown>;
  today: () => string;
  language: Language;
  log?: (m: string) => void;
}

export const AdjustInput = z.object({
  adjustments: z
    .array(
      z
        .object({
          pocketId: z.string().describe('The POCKET id (from the pocket list), never the account id'),
          newBalance: z.number().optional().describe('The balance the pocket should have (e.g. read from the photo)'),
          delta: z.number().optional().describe('Or the change: positive adds, negative removes'),
        })
        .refine((a) => (a.newBalance === undefined) !== (a.delta === undefined), 'give exactly one of newBalance or delta'),
    )
    .min(1)
    .max(30),
  displayedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD, default today'),
});

const round2 = (n: number) => Math.round(n * 100) / 100;

export function createAdjustBalances(d: AdjustDeps) {
  const es = d.language === 'es';
  const fmt = (n: number) => new Intl.NumberFormat(es ? 'es-CO' : 'en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n);
  const signed = (n: number) => `${n > 0 ? '+' : '−'}${fmt(Math.abs(n))}`;
  return createTool({
    id: 'adjust_balances',
    description:
      'Adjust pocket balances to new values (balance corrections, e.g. "ajusta los saldos" from a screenshot) in ONE approval card. ' +
      'Give each pocket\'s pocketId and its NEW balance (or the delta). The hub reads the current balances, computes the differences and shows the user one card ' +
      '(account · pocket · current → new · delta); nothing is written until they approve. Never record balance adjustments with finance_create_movement directly.',
    inputSchema: AdjustInput,
    execute: async (input, ctx) => {
      const snap = await d.directory.snapshot({ fresh: true });
      if (!snap) return { error: { code: 'UNAVAILABLE', message: 'finance accounts could not be read right now; try again in a minute', retryable: true } };
      const date = input.displayedDate ?? d.today();
      const groups = new Map<string, PlanInput['groups'][number]>();
      const problems: string[] = [];
      let n = 0;
      for (const a of input.adjustments) {
        const r = await d.directory.repairPocket({ pocketId: a.pocketId });
        if ('error' in r) {
          problems.push(r.error);
          continue;
        }
        const p = snap.pockets.find((x) => x.id === r.args.pocketId)!;
        const acc = snap.accounts.find((x) => x.id === p.accountId);
        if (p.balance === undefined && a.newBalance !== undefined) {
          problems.push(`the current balance of ${p.name} is unknown; give a delta instead`);
          continue;
        }
        const current = p.balance ?? 0;
        const delta = round2(a.delta ?? a.newBalance! - current);
        if (!delta) continue;
        const target = round2(current + delta);
        const label = `${acc?.name ?? '?'}${acc?.currency ? ` (${acc.currency})` : ''}`;
        const g = groups.get(p.accountId) ?? { label, actions: [] };
        g.actions.push({
          tool: 'finance_create_movement',
          args: { type: delta > 0 ? 'IngresoNormal' : 'EgresoNormal', amount: Math.abs(delta), accountId: p.accountId, pocketId: p.id, displayedDate: date, notes: `${es ? 'Ajuste de saldo' : 'Balance adjustment'} ${p.name}` },
          summary: `${p.name}: ${p.balance === undefined ? '?' : fmt(current)} → ${p.balance === undefined ? '?' : fmt(target)} (${signed(delta)})`,
        });
        groups.set(p.accountId, g);
        n++;
      }
      if (problems.length) return { error: { code: 'MODEL_ARG', message: problems.join('\n'), retryable: false } };
      if (!n) return { status: 'nothing_to_adjust', note: 'Every pocket already has that balance. Tell the user in one line.' };
      const title = es ? `Ajustar saldos: ${n} ${n === 1 ? 'ajuste' : 'ajustes'} (${date})` : `Adjust balances: ${n} ${n === 1 ? 'adjustment' : 'adjustments'} (${date})`;
      d.log?.(`[finance] adjust_balances: ${n} adjustments in ${groups.size} accounts`);
      const agent = (ctx as { agent?: { threadId?: string; resourceId?: string } } | undefined)?.agent;
      return d.propose({ title, groups: [...groups.values()] }, { owner: agent?.resourceId ?? 'dev:local', threadId: agent?.threadId, trusted: true });
    },
  });
}
