import type { ToolAnnotations } from './mcp/toolbox.js';

/** Name segments that always mean "irreversible": finance_delete_movement, x_bulk_delete, y_remove_item. */
const DESTRUCTIVE_VERBS = /(^|_)(delete|remove|purge|destroy|wipe)(_|$)/;

/**
 * "Smart writes" policy: reads and additive writes run straight away; the user approves
 * (Approve/Deny card) anything destructive.
 *
 * - `destructiveHint: true` from the server → approve.
 * - A delete-like verb in the tool name → approve, even if annotations claim otherwise
 *   (annotations are hints from the server, not guarantees).
 * - Missing annotations alone do not trigger approval; otherwise every unannotated create
 *   would prompt. Our own app servers annotate their tools.
 */
export function requiresApproval(toolName: string, annotations: ToolAnnotations | undefined): boolean {
  if (DESTRUCTIVE_VERBS.test(toolName)) return true;
  return annotations?.destructiveHint === true;
}
