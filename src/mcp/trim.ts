/**
 * Model-facing trimming of MCP tool results. The full result is still what the hub's guards see
 * (nutrition tracking runs before trimming); the model gets only what it needs to act and reply.
 */
type Rec = Record<string, unknown>;

/** Drop null/undefined/empty values and noisy defaults, recursively. */
export function compact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(compact);
  if (v && typeof v === 'object') {
    const out: Rec = {};
    for (const [k, x] of Object.entries(v as Rec)) {
      if (x === null || x === undefined || x === '' || (Array.isArray(x) && x.length === 0)) continue;
      if (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x as Rec).length === 0) continue;
      out[k] = compact(x);
    }
    return out;
  }
  return v;
}

const pick = (o: Rec, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));

const UNIT_WORDS = ['slice', 'egg', 'cup', 'tbsp', 'tsp', 'piece', 'unit', 'container', 'bottle', 'can', 'bowl', 'serving', 'arepa', 'medium', 'large', 'small', 'tray', 'sandwich', 'g', 'ml', 'oz'];
/** Unit words the user/model put in the draft query ("2 slices whole wheat bread", "100 g rice"). */
export function unitsIn(query: string): string[] {
  const q = ` ${query.toLowerCase()} `;
  return UNIT_WORDS.filter((u) => new RegExp(`[\\s\\d](${u})(e?s)?[\\s,.]`).test(q));
}

const MAX_OPTIONS = 3;
const MAX_SERVINGS = 3;

function trimDraft(r: Rec): Rec {
  const units = unitsIn(String(r.query ?? ''));
  const options = ((r.options as Rec[] | undefined) ?? [])
    .map((o, i) => ({ o, i }))
    .sort((a, b) => Number(!!b.o.pinned) - Number(!!a.o.pinned) || a.i - b.i)
    .slice(0, MAX_OPTIONS)
    .sort((a, b) => a.i - b.i)
    .map(({ o }) => {
      const servings = ((o.servings as Rec[] | undefined) ?? []).map((s) => pick(s, ['serving', 'label', 'calories', 'protein', 'carbs', 'fat']));
      const suggested = Number(o.suggested_serving ?? 0);
      const matches = (s: Rec) => units.some((u) => String(s.label ?? '').toLowerCase().includes(u));
      const keep = servings.filter((s) => s.serving === suggested || matches(s));
      const rest = servings.filter((s) => !keep.includes(s));
      const chosen = [...keep, ...rest].slice(0, Math.max(MAX_SERVINGS, keep.length)).sort((a, b) => Number(a.serving) - Number(b.serving));
      return { ...pick(o, ['option', 'name', 'brand', 'suggested_serving']), ...(o.pinned ? { pinned: true } : {}), servings: chosen };
    });
  return { ...pick(r, ['draft_id', 'query', 'meal', 'quantity', 'needs_choice', 'logged']), note: 'servings show kcal for the WHOLE entry (serving × quantity)', options };
}

function trimDay(day: Rec): Rec {
  const nutrition = (day.nutrition as Rec | undefined) ?? {};
  const diary = ((day.diary as Rec[] | undefined) ?? []).map((e) => pick(e, ['meal', 'name', 'calories']));
  return compact({ day: day.day, totals: pick(nutrition, ['calories', 'protein', 'carbs', 'fat', 'water_ml', 'weight', 'goal_calories']), diary, note: day.note, feel: day.feel }) as Rec;
}

const LIST_FIELDS: Record<string, string[]> = {
  finance_list_accounts: ['id', 'name', 'currency', 'type', 'balance'],
  finance_list_pockets: ['id', 'accountId', 'name', 'balance', 'currency', 'type'],
  finance_list_movements: ['id', 'type', 'amount', 'currency', 'displayedDate', 'accountId', 'pocketId', 'notes', 'category', 'isPending'],
};

/** What the model sees from a tool result. Errors and unknown tools pass through compacted. */
export function trimForModel(tool: string, result: unknown): unknown {
  if (!result || typeof result !== 'object' || 'error' in (result as Rec)) return result;
  const r = result as Rec;
  if (tool === 'fitness_draft_food' || (tool === 'fitness_log_food' && r.needs_choice)) return trimDraft(r);
  if (tool === 'fitness_log_food' || tool === 'fitness_modify_food') {
    const rest = { ...r };
    for (const k of ['day', 'food_id', 'weight_id']) delete rest[k];
    return compact(rest);
  }
  if (tool === 'fitness_get_day') return trimDay(r);
  if (tool === 'fitness_search_food' && Array.isArray(r.results)) {
    return { query: r.query, results: (r.results as Rec[]).slice(0, 5).map((x) => pick(x, ['name', 'brand', 'calories', 'serving', 'food_id', 'weight_id'])) };
  }
  const fields = LIST_FIELDS[tool];
  if (fields) {
    const list = Array.isArray(r.result) ? (r.result as Rec[]) : Array.isArray(result) ? (result as Rec[]) : undefined;
    if (list) {
      const items = list.map((x) => {
        const p = pick(x, fields);
        return Object.keys(p).length >= 2 ? p : compact(x); // unknown shape: keep it all
      });
      return compact({ ...r, result: items });
    }
  }
  return compact(result);
}
