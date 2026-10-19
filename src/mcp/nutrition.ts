/**
 * MyFitnessPal logging guardrails (code-level, independent of what the model decides).
 *
 * Mason's `fitness_draft_food` returns numbered options, each with every serving size and its
 * calories for the WHOLE entry (serving × the draft's quantity). We remember those, so a
 * `fitness_log_food` call can be priced before it runs:
 *  - draft_id + option (+ serving, default the option's suggested_serving) (+ quantity override)
 *  - food_id + weight_id: calories per serving from `fitness_search_food` × quantity
 *  - bare query (a pinned food): unknown up front; checked on the log result instead.
 * Entries above KCAL_CONFIRM_THRESHOLD need the user's approval.
 */
export const KCAL_CONFIRM_THRESHOLD = 800;

type Rec = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

interface DraftServing {
  serving: number;
  label?: string;
  calories?: number;
}
interface DraftOption {
  option: number;
  suggested_serving?: number;
  servings: DraftServing[];
}

export class NutritionTracker {
  private drafts = new Map<string, { quantity: number; options: DraftOption[] }>();
  private search = new Map<string, number>();

  /** Feed every MFP tool result through here (drafts and searches are remembered). */
  recordResult(tool: string, _input: unknown, result: unknown): void {
    const r = result as Rec | undefined;
    if (!r || typeof r !== 'object' || 'error' in r) return;
    if (tool === 'fitness_draft_food' || (tool === 'fitness_log_food' && r.needs_choice)) {
      if (typeof r.draft_id === 'string' && Array.isArray(r.options)) {
        this.drafts.set(r.draft_id, { quantity: num(r.quantity) ?? 1, options: r.options as DraftOption[] });
        if (this.drafts.size > 200) this.drafts.delete(this.drafts.keys().next().value!);
      }
    }
    if (tool === 'fitness_search_food' && Array.isArray(r.results)) {
      for (const f of r.results as Rec[]) {
        const kcal = num(f.calories);
        if (kcal !== undefined && f.food_id && f.weight_id) this.search.set(`${f.food_id}:${f.weight_id}`, kcal);
      }
    }
  }

  /** Expected kcal of a fitness_log_food call, or undefined when it can't be known up front. */
  estimateLogKcal(input: Rec): number | undefined {
    const quantity = num(input.quantity);
    if (typeof input.draft_id === 'string') {
      const d = this.drafts.get(input.draft_id);
      const opt = d?.options.find((o) => o.option === num(input.option));
      if (!d || !opt) return undefined;
      const idx = num(input.serving) ?? opt.suggested_serving ?? 0;
      const kcal = num(opt.servings.find((s) => s.serving === idx)?.calories ?? opt.servings[idx]?.calories);
      if (kcal === undefined) return undefined;
      return quantity !== undefined && d.quantity > 0 ? Math.round((kcal * quantity) / d.quantity) : kcal;
    }
    if (input.food_id && input.weight_id) {
      const per = this.search.get(`${input.food_id}:${input.weight_id}`);
      return per === undefined ? undefined : Math.round(per * (quantity ?? 1));
    }
    return undefined;
  }

  needsConfirmation(input: Rec): boolean {
    const kcal = this.estimateLogKcal(input);
    return kcal !== undefined && kcal > KCAL_CONFIRM_THRESHOLD;
  }

  /** Add entry_kcal, the meal total (readback) and, if needed, an oversize warning. */
  annotateLog(input: Rec, result: unknown): unknown {
    const r = result as Rec | undefined;
    if (!r || typeof r !== 'object' || 'error' in r || !r.logged) return result;
    const estimate = this.estimateLogKcal(input);
    const diary = ((r.day as Rec | undefined)?.diary ?? []) as { meal?: string; name?: string; calories?: number }[];
    const meal = String(r.meal ?? '').toLowerCase();
    const inMeal = diary.filter((e) => String(e.meal ?? '').toLowerCase() === meal);
    const entry = [...inMeal].reverse().find((e) => e.name === r.logged) ?? [...diary].reverse().find((e) => e.name === r.logged);
    const entryKcal = estimate ?? num(entry?.calories);
    const out: Rec = { ...r };
    if (entryKcal !== undefined) out.entry_kcal = entryKcal;
    if (inMeal.length) {
      out.meal_total = {
        meal: inMeal[0]!.meal,
        items: inMeal.length,
        kcal: Math.round(inMeal.reduce((a, e) => a + (num(e.calories) ?? 0), 0)),
      };
    }
    if (estimate === undefined && entryKcal !== undefined && entryKcal > KCAL_CONFIRM_THRESHOLD) {
      out.warning = `This entry is ${entryKcal} kcal (over ${KCAL_CONFIRM_THRESHOLD}). Tell the user and ask them to confirm, or fix it now with fitness_modify_food.`;
    }
    return out;
  }
}
