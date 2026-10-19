import type { Processor, ProcessOutputStepArgs } from '@mastra/core/processors';
import { PROPOSE_PLAN } from './service.js';

/**
 * Backstop for the batch-approval rule: if one model step calls 2+ approval-gated tools
 * directly, nothing runs and no per-item cards are posted; the step is retried with feedback
 * telling the model to use propose_plan. Gives up (with a message) after two retries.
 */
export class PlanGuard implements Processor<'plan-guard'> {
  readonly id = 'plan-guard' as const;
  readonly name = 'Batch approval guard';

  constructor(
    private readonly isGated: (tool: string) => boolean,
    private readonly log: (m: string) => void = () => {},
  ) {}

  processOutputStep(args: ProcessOutputStepArgs) {
    const gated = (args.toolCalls ?? []).filter((tc) => tc.toolName !== PROPOSE_PLAN && this.isGated(tc.toolName));
    if (gated.length >= 2) {
      const names = [...new Set(gated.map((g) => g.toolName))].join(', ');
      this.log(`[plan] bounced ${gated.length} direct gated calls (${names})`);
      if (args.retryCount < 2) {
        args.abort(
          `You tried to call ${gated.length} approval-gated tools (${names}) one by one. Do not. Call propose_plan ONCE with all ${gated.length} actions (exact tool names and args, grouped into sections, one summary line each).`,
          { retry: true },
        );
      }
      args.abort('I need to show these changes as one plan to approve; please ask me again.');
    }
    return args.messageList;
  }
}
