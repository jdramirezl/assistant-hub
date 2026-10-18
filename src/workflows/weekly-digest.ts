import { z } from 'zod';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { DIGEST_CRON, type Digest } from '../digest.js';

/**
 * Weekly digest workflow. Declarative schedule: Mastra's scheduler starts it every
 * Sunday 19:00 in the hub timezone. Missed runs are also caught up at startup by
 * `Digest.catchUp()`; the per-period claim makes the two paths safe together.
 */
export function createDigestWorkflow(digest: Digest, timezone: string) {
  const run = createStep({
    id: 'run-digest',
    inputSchema: z.object({ trigger: z.string(), force: z.boolean() }),
    outputSchema: z.object({ status: z.enum(['sent', 'skipped']), period: z.string(), text: z.string().optional() }),
    execute: async ({ inputData }) => digest.run(inputData),
  });

  return createWorkflow({
    id: 'weekly-digest',
    description: 'Weekly summary across connected apps, sent to Telegram',
    inputSchema: z.object({ trigger: z.string().default('manual'), force: z.boolean().default(false) }),
    outputSchema: run.outputSchema,
    schedule: { cron: DIGEST_CRON, timezone, inputData: { trigger: 'schedule', force: false } },
  })
    .then(run)
    .commit();
}
