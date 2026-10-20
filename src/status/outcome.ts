/**
 * What a request actually did, from its tool results (not from the model's words): which
 * writes succeeded, which failed (and why), what still needs the user. Validation errors the
 * model fixed itself (a later success of the same tool) are not failures.
 */
import { appName, appOfTool, candidatesOf, errorOf, explain, type Explained, type Lang } from './errors.js';
import { expiryOf } from '../cines/service.js';

type Rec = Record<string, unknown>;
export interface ToolOutcome {
  tool: string;
  args: Rec;
  result?: unknown;
  /** The tool threw (transport); `result` is then undefined. */
  thrown?: string;
}
export interface Failure {
  tool: string;
  label: string;
  why: Explained;
  /** The server's own message (purchases show it verbatim). */
  message?: string;
}
export interface Outcome {
  kind: 'none' | 'done' | 'partial' | 'failed';
  /** Done parts, e.g. ["Almuerzo: 3 alimentos, 420 kcal", "3 gastos, $35.000"] */
  done: string[];
  failures: Failure[];
  /** Things the user must answer (ambiguous foods, approvals). */
  needInfo: string[];
  /** Successful write count and attempted write count per noun group. */
  okCount: number;
  total: number;
  noun?: string;
  /** Singular noun, for "No borré el alimento". */
  nounOne?: string;
  /** Verb of the failed writes: 'save' | 'delete' | 'change'. */
  verb?: 'save' | 'delete' | 'change';
}

const MEALS: Record<string, { es: string; en: string }> = {
  breakfast: { es: 'Desayuno', en: 'Breakfast' },
  lunch: { es: 'Almuerzo', en: 'Lunch' },
  dinner: { es: 'Cena', en: 'Dinner' },
  snacks: { es: 'Merienda', en: 'Snacks' },
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const NOUN: Record<string, { es: [string, string]; en: [string, string] }> = {
  log_meal: { es: ['alimento', 'alimentos'], en: ['food', 'foods'] },
  fitness_log_food: { es: ['alimento', 'alimentos'], en: ['food', 'foods'] },
  expense: { es: ['gasto', 'gastos'], en: ['expense', 'expenses'] },
  income: { es: ['ingreso', 'ingresos'], en: ['income', 'incomes'] },
  finance_create_transfer: { es: ['transferencia', 'transferencias'], en: ['transfer', 'transfers'] },
  finance_update_movement: { es: ['movimiento actualizado', 'movimientos actualizados'], en: ['movement updated', 'movements updated'] },
  finance_delete_movement: { es: ['movimiento borrado', 'movimientos borrados'], en: ['movement deleted', 'movements deleted'] },
  fitness_delete_food: { es: ['alimento borrado', 'alimentos borrados'], en: ['food deleted', 'foods deleted'] },
  fitness_modify_food: { es: ['alimento corregido', 'alimentos corregidos'], en: ['food corrected', 'foods corrected'] },
  cines_hold_seats: { es: ['apartado de asientos', 'apartados de asientos'], en: ['seat hold', 'seat holds'] },
  cines_purchase: { es: ['compra hecha', 'compras hechas'], en: ['purchase made', 'purchases made'] },
  cines_release_hold: { es: ['apartado liberado', 'apartados liberados'], en: ['hold released', 'holds released'] },
  generic: { es: ['cambio', 'cambios'], en: ['change', 'changes'] },
};
const nounKey = (o: ToolOutcome) =>
  o.tool === 'finance_create_movement' ? (/^Ingreso/.test(String(o.args.type ?? '')) ? 'income' : 'expense') : NOUN[o.tool] ? o.tool : 'generic';

export function money(n: number, currency?: string): string {
  const s = `$${Math.round(n).toLocaleString('es-CO')}`;
  return currency ? `${s} ${currency}` : s;
}

/** A short label for one attempted write (for "Falló: camisa $262"). */
function labelOf(o: ToolOutcome, lang: Lang): string {
  const a = o.args;
  if (o.tool.startsWith('finance_') && typeof a.amount === 'number') return [a.notes ?? a.description ?? a.category, money(a.amount)].filter(Boolean).join(' ');
  if (typeof a.query === 'string') return a.query;
  if (typeof a.seats === 'string' || Array.isArray(a.seats)) return `${lang === 'es' ? 'asientos' : 'seats'} ${[a.seats].flat().join(',')}`;
  return o.tool.replace(/^[a-z]+_/, '').replace(/_/g, ' ');
}

export function summarizeOutcome(events: ToolOutcome[], isWrite: (tool: string) => boolean, lang: Lang = 'es'): Outcome {
  const writes = events.filter((e) => isWrite(e.tool));
  const done: string[] = [];
  const reads = events.filter((e) => !isWrite(e.tool));
  const failures: Failure[] = [];
  const needInfo: string[] = [];
  const meals = new Map<string, { n: number; kcal: number }>();
  const groups = new Map<string, { ok: number; total: number; sum: number; currency?: string }>();
  const g = (k: string) => groups.get(k) ?? (groups.set(k, { ok: 0, total: 0, sum: 0 }), groups.get(k)!);
  writes.forEach((e, i) => {
    const err = e.thrown ? { code: 'TOOL_ERROR', message: e.thrown } : errorOf(e.result);
    const key = nounKey(e);
    // the model's own bad argument (placeholder, invented id, wrong year): bounced back to it, never shown
    if (err?.code === 'MODEL_ARG') return;
    if (err) {
      // a validation error the model fixed (same tool succeeded later) is not a failure
      const label = labelOf(e, lang);
      const sameItem = (x: ToolOutcome) => x.tool === e.tool && (labelOf(x, lang) === label || (typeof e.args.amount === 'number' && x.args.amount === e.args.amount) || x.tool.startsWith('cines_'));
      // only the run's FINAL outcome counts: a later success of the same item means it recovered
      const fixed = writes.slice(i + 1).some((x) => sameItem(x) && !x.thrown && !errorOf(x.result));
      if (fixed) return;
      // several entries match: a question for the user, not a failure
      if (err.code === 'MFP_AMBIGUOUS' || (err.code === 'MFP_NOT_FOUND' && /delete|modify/.test(e.tool))) {
        const c = candidatesOf(err.message);
        const q =
          err.code === 'MFP_NOT_FOUND'
            ? lang === 'es'
              ? `No encontré ${label ? `«${label}»` : 'esa entrada'}; ¿cuál es?`
              : `I could not find ${label ? `"${label}"` : 'that entry'}; which one is it?`
            : lang === 'es'
              ? `¿Cuál ${label ? `«${label}»` : 'entrada'}?`
              : `Which ${label ? `"${label}"` : 'entry'}?`;
        const line = c.length ? `${q} ${c.join(' · ')}` : q;
        if (!needInfo.includes(line)) needInfo.push(line);
        return;
      }
      // the model retrying the same item counts once
      if (failures.some((f) => f.tool === e.tool && f.label === label)) return;
      g(key).total++;
      failures.push({ tool: e.tool, label, why: explain(err.code, err.message, lang, appName(appOfTool(e.tool), lang)), message: err.message });
      return;
    }
    const r = (e.result ?? {}) as Rec;
    // not an outcome yet: waiting for a code, still running, or nothing to do
    if (typeof r.status === 'string' && /^(needs_|waiting|in_progress|secure_input|none$|shown_to_user$|nothing_to_delete$|card_shown$)/.test(r.status)) {
      // a payment secret (CVV / PIN / bank code): the 🔒 prompt is the message, no extra ❓ line
      const paymentSecret = /^(waiting_for_secure_input|needs_cvv|needs_arm_pin|needs_3ds)$/.test(r.status) && /^(cvv|arm_pin|otp_3ds)$/.test(String(r.kind ?? ''));
      if (paymentSecret) return;
      if (/needs_|waiting|secure_input_busy/.test(r.status)) needInfo.push(lang === 'es' ? '🔒 esperando su código' : '🔒 waiting for your code');
      else if (r.status === 'in_progress') needInfo.push(lang === 'es' ? 'sigue en curso' : 'still running');
      return;
    }
    if (e.tool === 'cines_hold_seats' && r.status === 'held' && typeof r.holdId === 'string') {
      const es = lang === 'es';
      const seats = [r.seats ?? []].flat().join(', ');
      const total = typeof r.total === 'number' ? r.total : r.totalMxn;
      const exp = typeof r.expiresAt === 'string' ? expiryOf(r.expiresAt, Date.now()) : undefined;
      done.push(`${es ? 'Apartado' : 'Held'} ${seats}${typeof total === 'number' ? ` · $${total}` : ''}${exp ? ` · ${es ? 'expira' : 'expires'} ${exp.time}` : ''}`);
      g(key).ok++;
      g(key).total++;
      return;
    }
    if (e.tool === 'cines_purchase' && r.status === 'paid') {
      const es = lang === 'es';
      const price = typeof r.total === 'number' ? `$${r.total} ${r.currency ?? 'MXN'}` : '';
      const booking = r.bookingNumber ? `${es ? 'reserva' : 'booking'} ${r.bookingNumber}` : '';
      const sim = r.dryRun ? (es ? ' (simulada)' : ' (simulated)') : '';
      // with the hold's summary (movie · cinema · day time · seats) the line stands on its own
      done.unshift(
        typeof r.summary === 'string' && r.summary
          ? `🎟️ ${es ? 'Compra confirmada' : 'Purchase confirmed'}: ${[r.summary, price, booking].filter(Boolean).join(' · ')}${sim}${r.dryRun ? '' : es ? ' (revise su correo)' : ' (check your e-mail)'}`
          : `🎟️ ${es ? 'Compra confirmada' : 'Purchase confirmed'}${booking ? `: ${booking}` : ''}${price ? ` · ${price}` : ''}${sim}`,
      );
      g(key).ok++;
      g(key).total++;
      return;
    }
    if (e.tool === 'log_meal') {
      for (const l of (r.logged as Rec[] | undefined) ?? []) {
        const m = meals.get(String(l.meal)) ?? { n: 0, kcal: 0 };
        m.n++;
        m.kcal += Number(l.kcal ?? 0);
        meals.set(String(l.meal), m);
      }
      const logged = ((r.logged as unknown[]) ?? []).length;
      const failed = (r.failed as Rec[] | undefined) ?? [];
      g(key).ok += logged;
      g(key).total += logged + failed.length;
      for (const f of failed) {
        const fe = errorOf({ error: f.error }) ?? { code: 'MFP_ERROR', message: '' };
        failures.push({ tool: e.tool, label: String(f.query ?? ''), why: explain(fe.code, fe.message, lang, 'MyFitnessPal') });
      }
      const amb = ((r.ambiguous as unknown[]) ?? []).length;
      const conf = ((r.needs_confirmation as unknown[]) ?? []).length;
      if (amb) needInfo.push(lang === 'es' ? `${plural(amb, 'alimento', 'alimentos')} por confirmar` : `${plural(amb, 'food', 'foods')} to confirm`);
      if (conf) needInfo.push(lang === 'es' ? `${plural(conf, 'alimento espera', 'alimentos esperan')} su aprobación` : `${plural(conf, 'food awaits', 'foods await')} your approval`);
      return;
    }
    if (e.tool === 'fitness_log_food') {
      const m = meals.get(String(e.args.meal ?? 'snacks')) ?? { n: 0, kcal: 0 };
      m.n++;
      m.kcal += Number(r.entry_kcal ?? 0);
      meals.set(String(e.args.meal ?? 'snacks'), m);
    }
    const gg = g(key);
    gg.ok++;
    gg.total++;
    if (typeof e.args.amount === 'number') gg.sum += e.args.amount;
    if (typeof r.currency === 'string') gg.currency = r.currency;
  });
  for (const [meal, m] of meals) done.push(`${MEALS[meal]?.[lang] ?? meal}: ${plural(m.n, NOUN.log_meal![lang][0], NOUN.log_meal![lang][1])}, ${Math.round(m.kcal)} kcal`);
  for (const [k, v] of groups) {
    if (k === 'log_meal' || k === 'fitness_log_food' || k === 'cines_purchase' || v.ok === 0) continue;
    if (k === 'cines_hold_seats') continue; // its own line (above)
    const n = NOUN[k]![lang];
    done.push(`${plural(v.ok, n[0], n[1])}${v.sum ? `, ${money(v.sum, v.currency)}` : ''}`);
  }
  // read errors (nothing to save, but the user should know why there is no answer), unless a
  // later call to the same app succeeded (the model recovered)
  const ok = (x: ToolOutcome) => !x.thrown && !errorOf(x.result);
  for (const e of reads) {
    const err = e.thrown ? { code: 'TOOL_ERROR', message: e.thrown } : errorOf(e.result);
    if (!err || err.code === 'VALIDATION_ERROR' || err.code === 'MODEL_ARG') continue;
    const app = appOfTool(e.tool);
    if (events.slice(events.indexOf(e) + 1).some((x) => appOfTool(x.tool) === app && ok(x))) continue;
    if (failures.some((f) => f.why.code === err.code)) continue;
    failures.push({ tool: e.tool, label: '', why: explain(err.code, err.message, lang, appName(appOfTool(e.tool), lang)) });
  }
  const okCount = [...groups.values()].reduce((a, v) => a + v.ok, 0);
  const total = [...groups.values()].reduce((a, v) => a + v.total, 0);
  const nounGroups = [...groups.entries()].filter(([, v]) => v.total > 0);
  const nk = nounGroups.length === 1 ? nounGroups[0]![0] : undefined;
  const noun = nk ? NOUN[nk]![lang][1] : undefined;
  const nounOne = nk ? NOUN[nk]![lang][0] : undefined;
  const ft = failures[0]?.tool ?? '';
  const verb: Outcome['verb'] = /delete|release/.test(ft) ? 'delete' : /modify|update|clear_food_pin/.test(ft) ? 'change' : 'save';
  const kind = okCount > 0 ? (failures.length ? 'partial' : 'done') : failures.length ? 'failed' : 'none';
  return { kind, done, failures, needInfo, okCount, total, noun, nounOne, verb };
}
