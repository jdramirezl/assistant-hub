import type { InlineButton } from '../telegram-api.js';
import type { Language } from '../persona.js';
import type { PlanInput } from './types.js';

/** Telegram allows 4096 chars per message; keep headroom for the status line added later. */
export const PLAN_TEXT_LIMIT = 3800;

const L = {
  es: { actions: 'acciones', action: 'acción', approve: '✅ Aprobar todo', edit: '✏️ Editar', cancel: '❌ Cancelar', expires: (m: number) => `Caduca en ${m} min. Nada se ejecuta hasta que apruebe.` },
  en: { actions: 'actions', action: 'action', approve: '✅ Approve all', edit: '✏️ Edit', cancel: '❌ Cancel', expires: (m: number) => `Expires in ${m} min. Nothing runs until you approve.` },
};

export function planTexts(lang: Language) {
  return L[lang];
}

/** Plain, scannable plan text (split into Telegram-sized chunks) and its buttons. */
export function renderPlan(plan: PlanInput & { id: string }, lang: Language, ttlMinutes = 30): { chunks: string[]; keyboard: InlineButton[][] } {
  const t = L[lang];
  const total = plan.groups.reduce((a, g) => a + g.actions.length, 0);
  const lines = [`📋 ${plan.title}`, `${total} ${total === 1 ? t.action : t.actions}`];
  let n = 0;
  if (plan.compact) {
    lines.push('');
    for (const g of plan.groups) lines.push(`• ${g.label}: ${g.summary ?? `${g.actions.length} ${g.actions.length === 1 ? t.action : t.actions}`}`);
  } else {
    for (const g of plan.groups) {
      lines.push('', g.label);
      for (const a of g.actions) lines.push(`${++n}. ${a.summary}`);
    }
  }
  lines.push('', `⏳ ${t.expires(ttlMinutes)}`);

  const chunks: string[] = [];
  let cur = '';
  for (const line of lines) {
    const piece = line.length > PLAN_TEXT_LIMIT ? `${line.slice(0, PLAN_TEXT_LIMIT - 1)}…` : line;
    if (cur && cur.length + 1 + piece.length > PLAN_TEXT_LIMIT) {
      chunks.push(cur);
      cur = piece;
    } else cur = cur ? `${cur}\n${piece}` : piece;
  }
  if (cur) chunks.push(cur);

  const keyboard: InlineButton[][] = [
    [
      { text: t.approve, callback_data: `plan:a:${plan.id}` },
      { text: t.edit, callback_data: `plan:e:${plan.id}` },
      { text: t.cancel, callback_data: `plan:c:${plan.id}` },
    ],
  ];
  return { chunks, keyboard };
}
