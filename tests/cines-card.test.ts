/**
 * cines-mx-mcp 0e2f600 / 3520a56 / cddca3d: pay with the saved card. Comprar → needs_cvv (or
 * needs_arm_pin first) → secure input → cines_submit_code → paid (no image); or in_progress →
 * the CVV challenge appears in cines_hold_status.pendingInput. Secrets never reach the model.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHub, type Hub } from '../src/hub.js';
import { testConfig } from './helpers.js';
import { scriptedModel, lastToolResult, type Turn } from './support/scripted-model.js';
import { MockTelegram, callbackUpdate, findButton, textUpdate } from './support/mock-telegram.js';
import { CINES_REGISTRY, startFakeCines, type FakeCines, type FakeCinesOptions } from './support/fake-cines.js';

const ME = 42;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

let tg: MockTelegram;
let cines: FakeCines;
let logs: string[];
async function buy(card: NonNullable<FakeCinesOptions['card']>, text = 'compra el F7 para Dune hoy en la noche', extra: FakeCinesOptions = {}) {
  tg = await new MockTelegram().start();
  closers.push(() => tg.stop());
  cines = await startFakeCines({ phase3: true, card, ...extra });
  closers.push(cines.close);
  const script: Turn[] = [
    { tool: 'cines_best_showtime', args: { movie: 'Dune', window: 'night' } },
    (p) => ({ tool: 'cines_hold_seats', args: { showtimeId: JSON.parse(lastToolResult(p)).value.best.showtimeId, seats: 'F7' } }),
    { text: 'Listo, le mostré la compra.' },
    { text: 'otra respuesta' },
  ];
  const sm = scriptedModel(script);
  logs = [];
  const cfg = testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME) });
  const hub: Hub = createHub(cfg, {
    model: sm.model as never,
    cinesPollMs: 20,
    registry: CINES_REGISTRY(cines.url),
    telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: (m) => logs.push(m) },
  });
  closers.push(() => hub.stop());
  await hub.start();
  tg.push(textUpdate(ME, text));
  for (const needle of ['tool_approve:call-1', 'cines:b:']) {
    await tg.waitFor(() => !!findButton(tg, needle), 10_000);
    const b = findButton(tg, needle)!;
    tg.push(callbackUpdate(ME, { message_id: b.messageId }, b.data));
  }
  return { sm, hub, cfg };
}
const status = () => tg.calls.filter((c) => /sendMessage|editMessageText/.test(c.method) && c.body.parse_mode === 'HTML').map((c) => String(c.body.text));
const out = () => tg.outgoingText(ME).replace(/\\/g, '');
/** Send a secret once the hub asked for it (🔒 … matching `asked`); returns the update. */
async function sendSecret(asked: RegExp, value: string) {
  await tg.waitFor(() => asked.test(out()), 10_000);
  const u = textUpdate(ME, value);
  tg.push(u);
  return u;
}
const purchases = () => cines.calls.filter((c) => c.tool === 'cines_purchase');
const FINAL = '✅ 🎟️ Compra confirmada: Dune: Mesías · Cinépolis Parque Toreo · lun 19 20:30 · F7 · $99 MXN · reserva BK001 (revise su correo)';
/** Status messages (HTML) still showing ⏳ at the end (not edited to a result, not deleted). */
function leftoverWorking(): string[] {
  const last = new Map<number, string>();
  for (const c of tg.calls) {
    if (c.method === 'sendMessage' && c.body.parse_mode === 'HTML') last.set(Number((c.result as { message_id?: number })?.message_id), String(c.body.text));
    if (c.method === 'editMessageText' && c.body.parse_mode === 'HTML') last.set(Number(c.body.message_id), String(c.body.text));
    if (c.method === 'deleteMessage') last.delete(Number(c.body.message_id));
  }
  return [...last.values()].filter((t) => t.startsWith('⏳'));
}
/** The final confirmation is a NEW message (sent last among status messages), not an edit above the prompts. */
const finalIsNewMessage = () => {
  const sends = tg.sent('sendMessage').filter((c) => c.body.parse_mode === 'HTML');
  return String(sends.at(-1)?.body.text ?? '').startsWith('✅ 🎟️ Compra confirmada:');
};

describe('saved card: Comprar → CVV via secure input → paid', () => {
  it('the card says how it is paid; CVV asked privately, deleted, never seen by the model; ✅ booking line with no photo', async () => {
    const CVV = '4729';
    const { sm, hub } = await buy({});
    await tg.waitFor(() => /confirmo la compra/.test(out()));
    expect(out()).toMatch(/💳 Tarjeta guardada \(predeterminada\); le pediré el CVV en privado/);
    const msg = await sendSecret(/🔒 Envíe el CVV de su tarjeta \*1234 \(\$99 MXN\), Amo Julián\. No lo verá el modelo/, CVV);
    await tg.waitFor(() => status().some((s) => /^✅ 🎟️ Compra confirmada/.test(s)), 10_000);
    expect(status().at(-1)).toBe(FINAL);
    expect(finalIsNewMessage()).toBe(true);
    expect(leftoverWorking()).toEqual([]);
    expect(purchases()).toHaveLength(1);
    // the hub's total; method left to the server default (the saved card); no secret argument
    expect(purchases()[0]!.args).toEqual({ holdId: 'hold_1', expectedTotal: 99, userApproved: true });
    expect(cines.secrets).toEqual([CVV]);
    expect(tg.sent('deleteMessage').map((c) => Number(c.body.message_id))).toContain(msg.message.message_id);
    expect(tg.sent('sendPhoto')).toHaveLength(0); // card `paid` has no imageUrl: nothing to wait for
    // deterministic after the CVV: no model call at all (2 tool steps + 1 reply)
    expect(sm.calls).toHaveLength(3);
    for (const blob of [JSON.stringify(sm.calls.map((c) => c.prompt)), logs.join('\n')]) expect(blob).not.toContain(CVV);
    expect(await hub.cines.successes()).toBe(1);
    // the hold's purchase card is the message: the model's own text after it is dropped
    expect(out()).not.toMatch(/Listo, le mostré la compra/);
    // the purchase card itself is closed with the outcome
    expect(tg.sent('editMessageText').map((c) => String(c.body.text)).join('\n')).toMatch(/✅ Pagado: reserva BK001/);
  }, 30_000);

  it('slow: in_progress BEFORE the CVV challenge → the poller finds it in pendingInput, asks, keeps polling → paid', async () => {
    const { sm } = await buy({ slow: true, cvvAfterPolls: 2 });
    await sendSecret(/🔒 Envíe el CVV de su tarjeta \*1234/, '321');
    await tg.waitFor(() => status().some((s) => /^✅ 🎟️ Compra confirmada/.test(s)), 10_000);
    expect(status().at(-1)).toBe(FINAL);
    expect(finalIsNewMessage()).toBe(true);
    expect(leftoverWorking()).toEqual([]);
    expect(purchases()).toHaveLength(1); // never re-called
    expect(cines.secrets).toEqual(['321']);
    expect(status().join('\n')).not.toMatch(/PayPal/);
    expect(logs.join('\n')).toMatch(/secure input from cines_hold_status \(cvv\)/);
    expect(sm.calls).toHaveLength(3);
    expect(JSON.stringify(sm.calls.map((c) => c.prompt))).not.toContain('321');
  }, 30_000);

  it('declined after the CVV: ❌ nothing charged, seats released by the server; never retried', async () => {
    await buy({ outcome: 'declined' });
    await sendSecret(/🔒 Envíe el CVV/, '123');
    await tg.waitFor(() => status().some((s) => /^❌/.test(s)), 10_000);
    expect(status().at(-1)).toMatch(/^❌ El pago no se completó: Cinépolis rechazó el pago con la tarjeta \*1234 \(fondos insuficientes\)\. No se cobró nada y liberé los asientos\.\n<code>CINES_PAYMENT_FAILED/);
    expect(purchases()).toHaveLength(1);
  }, 30_000);

  it('uncertain ("incierto"): ⚠️ check e-mail and bank, hold NOT released, never retried', async () => {
    await buy({ outcome: 'uncertain' });
    await sendSecret(/🔒 Envíe el CVV/, '123');
    await tg.waitFor(() => status().some((s) => /^⚠️/.test(s)), 10_000);
    expect(status().at(-1)).toMatch(/^⚠️ No sé si se cobró; revise su correo de Cinépolis y su banco\. No liberé los asientos ni lo reintento\.\n<code>CINES_PAYMENT_UNKNOWN/);
    expect(cines.calls.map((c) => c.tool)).not.toContain('cines_release_hold');
    expect(purchases()).toHaveLength(1);
  }, 30_000);

  it('3-D Secure card: refused before any charge, a plain Spanish line, no CVV asked', async () => {
    await buy({ outcome: '3ds' });
    await tg.waitFor(() => status().some((s) => /^❌/.test(s)), 10_000);
    expect(status().at(-1)).toMatch(/^❌ Su banco pide una verificación extra \(3-D Secure\) que aún no puedo hacer\. No se cobró nada y Cinépolis liberó los asientos\. Puede pagar con PayPal \(en el Mac\) o en la app de Cinépolis\./);
    expect(out()).not.toMatch(/🔒/);
    expect(cines.secrets).toEqual([]);
  }, 30_000);

  it('the user named a card or PayPal: cardLast4 / method passed to the purchase', async () => {
    await buy({}, 'compra el F7 para Dune hoy en la noche con la tarjeta terminación 4321');
    await tg.waitFor(() => purchases().length === 1, 10_000);
    expect(purchases()[0]!.args).toMatchObject({ cardLast4: '4321' });
    expect(out()).toMatch(/💳 Tarjeta guardada \*4321/);
  }, 30_000);
});

describe('PIN arming from Telegram (needs_arm_pin → needs_cvv)', () => {
  it('PIN then CVV, both private; paid', async () => {
    const { sm, cfg } = await buy({ pin: 'ok' }, undefined, { realPaymentDisabled: false });
    const pinMsg = await sendSecret(/🔒 Envíe su PIN de compras \(\$99 MXN\)/, '246810');
    await sendSecret(/🔒 Envíe el CVV de su tarjeta \*1234/, '987');
    await tg.waitFor(() => status().some((s) => /^✅ 🎟️ Compra confirmada/.test(s)), 10_000);
    expect(cines.secrets).toEqual(['246810', '987']);
    expect(status()).toContain('✅ PIN correcto');
    expect(status().join('\n')).not.toMatch(/esperando su código/);
    expect(status().at(-1)).toBe(FINAL);
    expect(finalIsNewMessage()).toBe(true);
    expect(leftoverWorking()).toEqual([]);
    expect(tg.sent('deleteMessage').map((c) => Number(c.body.message_id))).toContain(pinMsg.message.message_id);
    const blob = JSON.stringify(sm.calls.map((c) => c.prompt)) + logs.join('\n');
    expect(blob).not.toContain('246810');
    expect(blob).not.toContain('987');
    // nor in any file of the data dir (memory, llm_calls, kv)
    for (const f of readdirSync(cfg.dataDir)) expect(readFileSync(join(cfg.dataDir, f)).toString('latin1')).not.toContain('246810');
  }, 30_000);

  it('a PIN that is too short is asked again without the server', async () => {
    await buy({ pin: 'ok' });
    await sendSecret(/🔒 Envíe su PIN de compras/, '1234');
    await tg.waitFor(() => /no parece correcto, Amo Julián \(6 a 8 dígitos\)/.test(out()), 10_000);
    expect(cines.secrets).toEqual([]);
  }, 30_000);

  it('wrong PIN: nothing charged, the purchase card stays valid (Comprar again after 30 s)', async () => {
    const { hub } = await buy({ pin: 'wrong' });
    await sendSecret(/🔒 Envíe su PIN de compras/, '111111');
    await tg.waitFor(() => status().some((s) => /PIN incorrecto/.test(s)), 10_000);
    expect(status().at(-1)).toMatch(/^🔒 PIN incorrecto \(te quedan 2 intentos; espera 30 s\)\. No se cobró nada\. Puede volver a tocar Comprar\./);
    expect(await hub.kv.get('cines:attempt:hold_1')).toBeNull(); // nothing recorded: a retry is allowed
    const edits = tg.sent('editMessageText').filter((c) => c.body.parse_mode !== 'HTML');
    expect(JSON.stringify(edits.at(-1)!.body.reply_markup)).toMatch(/cines:b:hold_1/);
  }, 30_000);
});

describe('PayPal + PIN: needs_arm_pin → the PayPal step', () => {
  it('PIN privately, then the PayPal wait (in_progress polled) → paid', async () => {
    await buy({ pin: 'ok' }, 'compra el F7 para Dune hoy en la noche con PayPal', { inProgress: { polls: 2, outcome: 'paid' } });
    await sendSecret(/🔒 Envíe su PIN de compras \(\$99 MXN\)/, '246810');
    await tg.waitFor(() => status().some((s) => /^✅ 🎟️ Compra confirmada/.test(s)), 10_000);
    expect(status()).toContain('⏳ Esperando que apruebe el pago en PayPal en el Mac, Amo Julián…');
    expect(out()).not.toMatch(/🔒 Envíe el CVV/);
    expect(purchases()[0]!.args).toMatchObject({ method: 'paypal' });
    expect(cines.secrets).toEqual(['246810']);
  }, 30_000);
});

describe('PIN refused before the prompt (PinArm.usable)', () => {
  it('3rd wrong PIN earlier → disabled: 🔒 run set-arm-pin at the Mac; no prompt, card still usable', async () => {
    const { hub } = await buy({ pin: 'disabled' });
    await tg.waitFor(() => status().some((s) => /desactivado/.test(s)), 10_000);
    expect(status().at(-1)).toMatch(/^🔒 El armado por PIN está desactivado tras 3 PIN incorrectos\. No se cobró nada y el apartado sigue\. En el Mac corra: bin\/cinesctl set-arm-pin/);
    expect(out()).not.toMatch(/🔒 Envíe/);
    expect(await hub.kv.get('cines:attempt:hold_1')).toBeNull();
    expect(JSON.stringify(tg.sent('editMessageText').filter((c) => c.body.parse_mode !== 'HTML').at(-1)!.body.reply_markup)).toMatch(/cines:b:hold_1/);
  }, 30_000);

  it('"Espera N s": the server text, the card stays (Comprar again)', async () => {
    await buy({ pin: 'wait' });
    await tg.waitFor(() => status().some((s) => /Espera 22 s/.test(s)), 10_000);
    expect(status().at(-1)).toMatch(/^🔒 Espera 22 s antes de intentar el PIN otra vez\. Puede volver a tocar Comprar\./);
    expect(JSON.stringify(tg.sent('editMessageText').filter((c) => c.body.parse_mode !== 'HTML').at(-1)!.body.reply_markup)).toMatch(/cines:b:hold_1/);
  }, 30_000);
});

describe('not armed (no PIN configured)', () => {
  it('the 🔒 line mentions both the Mac command and the PIN option', async () => {
    await buy({}, undefined, { paymentArmed: false });
    await tg.waitFor(() => status().some((s) => /^🔒 El pago real/.test(s)), 10_000);
    expect(status().at(-1)).toMatch(/bin\/cinesctl arm-payment.*bin\/cinesctl set-arm-pin/);
  }, 30_000);
});
