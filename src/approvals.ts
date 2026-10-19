import type { ToolAnnotations } from './mcp/toolbox.js';

/** Name segments that always mean "irreversible": finance_delete_movement, x_bulk_delete, y_remove_item. */
const DESTRUCTIVE_VERBS = /(^|_)(delete|remove|purge|destroy|wipe)(_|$)/;

/**
 * Tools that change or remove existing data without a delete-like verb in their name.
 * MyFitnessPal (Mason): see mfp-weekly-sync docs/hub-integration.md.
 */
export const APPROVAL_REQUIRED_TOOLS: ReadonlySet<string> = new Set([
  'fitness_delete_food',
  'fitness_delete_exercise',
  'fitness_modify_food',
  'fitness_clear_food_pin',
]);

/**
 * "Smart writes" policy: reads and additive writes run straight away; the user approves
 * (Approve/Deny card) anything destructive.
 *
 * - `destructiveHint: true` from the server → approve.
 * - Listed in APPROVAL_REQUIRED_TOOLS → approve.
 * - A delete-like verb in the tool name → approve, even if annotations claim otherwise
 *   (annotations are hints from the server, not guarantees).
 * - Missing annotations alone do not trigger approval; otherwise every unannotated create
 *   would prompt. Our own app servers annotate their tools.
 */
export function requiresApproval(toolName: string, annotations: ToolAnnotations | undefined): boolean {
  if (APPROVAL_REQUIRED_TOOLS.has(toolName)) return true;
  if (DESTRUCTIVE_VERBS.test(toolName)) return true;
  return annotations?.destructiveHint === true;
}
