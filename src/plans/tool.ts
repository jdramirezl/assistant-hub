import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import { PROPOSE_PLAN, type PlanService } from './service.js';

const ActionSchema = z.object({
  tool: z.string().min(1).describe('Exact tool name, e.g. fitness_delete_food'),
  args: z.record(z.string(), z.unknown()).describe('Exact arguments for that tool'),
  summary: z.string().min(1).describe('One line the user can scan: item and kcal, or description, amount, currency and account'),
});

export const ProposePlanInput = z.object({
  title: z.string().min(1).describe('Short title, e.g. "Delete Sunday (17 entries)"'),
  groups: z
    .array(z.object({ label: z.string().min(1).describe('Section, e.g. a meal (Breakfast) or an account/date'), actions: z.array(ActionSchema).min(1) }))
    .min(1),
});

/** Hub-local tool: one approval card for a batch of approval-gated actions. */
export function createProposePlanTool(service: PlanService) {
  return createTool({
    id: PROPOSE_PLAN,
    description:
      'Propose a batch of 2 or more approval-gated actions (deletes, modifications, anything destructive) as ONE plan the user approves all at once. ' +
      'Group actions into sections. Use exact tool names and args; the hub executes exactly these after approval and sends you the results.',
    inputSchema: ProposePlanInput,
    execute: async (input, ctx) => {
      const agent = (ctx as { agent?: { threadId?: string; resourceId?: string } } | undefined)?.agent;
      return service.propose(input, { owner: agent?.resourceId ?? 'dev:local', threadId: agent?.threadId });
    },
  });
}
