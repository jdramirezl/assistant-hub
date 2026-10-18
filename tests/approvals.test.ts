import { describe, expect, it } from 'vitest';
import { requiresApproval } from '../src/approvals.js';

describe('requiresApproval (smart writes)', () => {
  it('asks for tools the server marks destructive', () => {
    expect(requiresApproval('echo_delete', { destructiveHint: true })).toBe(true);
    expect(requiresApproval('finance_update_movement', { readOnlyHint: false, destructiveHint: true })).toBe(true);
  });

  it('asks for anything whose name says delete, whatever the annotations say', () => {
    expect(requiresApproval('finance_delete_movement', { destructiveHint: false })).toBe(true);
    expect(requiresApproval('fitness_delete_food_entry', undefined)).toBe(true);
    expect(requiresApproval('x_bulk_delete', undefined)).toBe(true);
    expect(requiresApproval('x_remove_item', undefined)).toBe(true);
  });

  it('lets reads and additive writes through', () => {
    expect(requiresApproval('finance_list_movements', { readOnlyHint: true })).toBe(false);
    expect(requiresApproval('finance_create_movement', { readOnlyHint: false, destructiveHint: false })).toBe(false);
    expect(requiresApproval('echo_say', undefined)).toBe(false);
  });

  it('does not match "delete" inside other words', () => {
    expect(requiresApproval('finance_list_undeleted', { readOnlyHint: true })).toBe(false);
  });

  it('a read-only hint never overrides a delete name', () => {
    expect(requiresApproval('finance_delete_movement', { readOnlyHint: true })).toBe(true);
  });
});
