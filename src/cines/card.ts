/**
 * Approval cards for cines money tools: a summary (cinema, movie, time, seats, total MXN) with
 * ✅ / ❌ instead of the generic "tool `args` requires approval" card. The buttons keep the
 * built-in ids (tool_approve:/tool_deny:<toolCallId>), so Mastra's approval flow handles them.
 */
import { Actions, Button, Card, CardText } from 'chat';
import type { ToolDisplayEvent, ToolDisplayResult } from '@mastra/core/channels';
import type { Language } from '../persona.js';
import { HARD_CAP_MXN, HOLD_TOOL, PURCHASE_TOOL } from './contract.js';
import type { CinesHub } from './service.js';

type Rec = Record<string, unknown>;
const mxn = (n: number) => `$${n.toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} MXN`;

export function cinesApprovalCard(event: ToolDisplayEvent, cines: Pick<CinesHub, 'holdSummary' | 'releaseAfterDeny'>, lang: Language): ToolDisplayResult | undefined {
  if (event.toolName !== HOLD_TOOL && event.toolName !== PURCHASE_TOOL) return undefined;
  const es = lang === 'es';
  const hold = event.toolName === HOLD_TOOL;
  if (event.kind === 'approved') return { kind: 'post', message: hold ? (es ? '✅ Apartando asientos…' : '✅ Holding seats…') : es ? '✅ Compra aprobada, pagando…' : '✅ Purchase approved, paying…' };
  if (event.kind === 'denied' && !hold) {
    // ❌ on the purchase card → release the seats now (hub flow step 4)
    const holdId = (event.args as Rec | undefined)?.holdId;
    void cines.releaseAfterDeny(typeof holdId === 'string' ? holdId : undefined);
  }
  if (event.kind === 'denied') return { kind: 'post', message: hold ? (es ? '❌ No se apartó nada.' : '❌ Nothing was held.') : es ? '❌ Compra cancelada; no se cobró nada.' : '❌ Purchase cancelled; nothing was charged.' };
  if (event.kind !== 'approval') return undefined;
  const args = (event.args ?? {}) as Rec;
  const buttons = (ok: string, no: string) =>
    Actions([
      Button({ id: `tool_approve:${event.toolCallId}`, label: ok, style: 'primary' }),
      Button({ id: `tool_deny:${event.toolCallId}`, label: no, style: 'danger' }),
    ]);
  if (event.toolName === HOLD_TOOL) {
    const lines = [
      es ? '🎟️ *Apartar asientos* (sin pagar, ~9 min)' : '🎟️ *Hold seats* (no payment, ~9 min)',
      `${es ? 'Función' : 'Showtime'}: ${String(args.showtimeId ?? '?')}`,
      `${es ? 'Asientos' : 'Seats'}: ${String(args.seats ?? '?')}`,
    ];
    return { kind: 'post', message: Card({ children: [CardText(lines.join('\n')), buttons(es ? '✅ Apartar' : '✅ Hold', es ? '❌ Cancelar' : '❌ Cancel')] }) };
  }
  const h = cines.holdSummary(typeof args.holdId === 'string' ? args.holdId : undefined);
  const lines = h
    ? [
        es ? '💳 *Confirmar compra*' : '💳 *Confirm purchase*',
        `🎬 ${h.movie || '?'}`,
        `📍 ${h.cinema || '?'}`,
        `🕗 ${h.when || '?'}`,
        `💺 ${h.seats.join(', ') || '?'}${h.ticketType ? ` · ${h.ticketType}` : ''}`,
        `💰 *${mxn(h.totalMxn)}*${es ? ' (con cargos)' : ' (fees included)'}${h.totalMxn > HARD_CAP_MXN ? (es ? ` — supera el límite de ${mxn(HARD_CAP_MXN)}, no se cobrará` : ` — over the ${mxn(HARD_CAP_MXN)} limit, will not be charged`) : ''}`,
        es ? 'Su banco puede pedir un código (3DS).' : 'Your bank may ask for a code (3DS).',
      ]
    : [es ? '💳 *Confirmar compra*' : '💳 *Confirm purchase*', `${es ? 'Apartado' : 'Hold'}: ${String(args.holdId ?? '?')}`, es ? '(no veo el resumen del apartado)' : '(hold summary not available)'];
  return { kind: 'post', message: Card({ children: [CardText(lines.join('\n')), buttons(es ? '✅ Comprar' : '✅ Buy', es ? '❌ Cancelar' : '❌ Cancel')] }) };
}
