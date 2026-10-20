/**
 * Friendly approval cards for every gated tool: what will happen, in the user's words, with
 * ✅/❌ (built-in button ids, so Mastra's approval flow handles them). No tool names or raw
 * arguments ever reach the chat.
 */
import { Actions, Button, Card, CardText } from 'chat';
import type { ToolDisplayEvent, ToolDisplayResult } from '@mastra/core/channels';
import type { Lang } from './errors.js';
import { appName, appOfTool } from './errors.js';
import { money } from './outcome.js';

type Rec = Record<string, unknown>;
const MEAL: Record<string, { es: string; en: string }> = {
  breakfast: { es: 'desayuno', en: 'breakfast' },
  lunch: { es: 'almuerzo', en: 'lunch' },
  dinner: { es: 'cena', en: 'dinner' },
  snacks: { es: 'merienda', en: 'snacks' },
};
const meal = (m: unknown, lang: Lang) => (typeof m === 'string' ? (MEAL[m.toLowerCase()]?.[lang] ?? m) : '');
const when = (a: Rec, lang: Lang) => [meal(a.meal, lang), typeof a.date === 'string' ? a.date : ''].filter(Boolean).join(', ');

/** One line saying what the gated call will do. */
export function describeAction(tool: string, a: Rec, lang: Lang, kcal?: number): string {
  const es = lang === 'es';
  const w = when(a, lang);
  const paren = w ? ` (${w})` : '';
  switch (tool) {
    case 'fitness_delete_food':
      return `🗑️ ${es ? 'Borrar de MyFitnessPal' : 'Delete from MyFitnessPal'}: ${String(a.query ?? '?')}${paren}`;
    case 'fitness_delete_exercise':
      return `🗑️ ${es ? 'Borrar ejercicio' : 'Delete exercise'}: ${String(a.query ?? '?')}${a.date ? ` (${a.date})` : ''}`;
    case 'fitness_modify_food':
      return `✏️ ${es ? 'Corregir en MyFitnessPal' : 'Correct in MyFitnessPal'}: ${String(a.query ?? a.old_query ?? '?')}${a.quantity !== undefined ? ` → ${a.quantity}` : ''}${paren}`;
    case 'fitness_clear_food_pin':
      return `📌 ${es ? 'Olvidar la elección guardada de' : 'Forget the saved choice for'}: ${String(a.query ?? '?')}`;
    case 'fitness_log_food':
      return `🍽️ ${es ? 'Registrar en MyFitnessPal' : 'Log in MyFitnessPal'}${kcal ? `: ${Math.round(kcal)} kcal` : ''}${paren}${kcal && kcal > 800 ? (es ? ' — es mucho, confírmelo' : ' — that is a lot, please confirm') : ''}`;
    case 'finance_delete_movement':
      return `🗑️ ${es ? 'Borrar el movimiento' : 'Delete the movement'}${a.description ? ` «${a.description}»` : ''}${typeof a.amount === 'number' ? ` ${money(a.amount)}` : ''}`;
    case 'finance_update_movement':
      return `✏️ ${es ? 'Cambiar el movimiento' : 'Change the movement'}${typeof a.amount === 'number' ? `: ${money(a.amount)}` : ''}`;
    default: {
      const app = appName(appOfTool(tool), lang);
      return `⚠️ ${es ? 'Acción en' : 'Action in'} ${app} ${es ? 'que requiere su aprobación' : 'that needs your approval'}`;
    }
  }
}

export function genericApprovalCard(event: ToolDisplayEvent, lang: Lang, opts: { kcal?: (args: Rec) => number | undefined } = {}): ToolDisplayResult | undefined {
  const es = lang === 'es';
  const args = (event.args ?? {}) as Rec;
  if (event.kind === 'approved') return { kind: 'post', message: es ? '✅ Aprobado, en curso…' : '✅ Approved, working on it…' };
  if (event.kind === 'denied') return { kind: 'post', message: es ? '❌ Cancelado; no se hizo nada.' : '❌ Cancelled; nothing was done.' };
  if (event.kind !== 'approval') return undefined;
  const line = describeAction(event.toolName, args, lang, opts.kcal?.(args));
  return {
    kind: 'post',
    message: Card({
      children: [
        CardText(line),
        Actions([
          Button({ id: `tool_approve:${event.toolCallId}`, label: es ? '✅ Aprobar' : '✅ Approve', style: 'primary' }),
          Button({ id: `tool_deny:${event.toolCallId}`, label: es ? '❌ Cancelar' : '❌ Cancel', style: 'danger' }),
        ]),
      ],
    }),
  };
}
