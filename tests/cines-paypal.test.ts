/** cines-mx-mcp 4013a93: PayPal approved at the Mac (in_progress → poll), confirmation image, not armed. */
import { afterEach, describe, expect, it } from "vitest";
import { createHub, type Hub } from "../src/hub.js";
import { testConfig } from "./helpers.js";
import {
  scriptedModel,
  lastToolResult,
  type Turn,
} from "./support/scripted-model.js";
import {
  MockTelegram,
  callbackUpdate,
  findButton,
  textUpdate,
} from "./support/mock-telegram.js";
import {
  CINES_REGISTRY,
  startFakeCines,
  type FakeCines,
  type FakeCinesOptions,
} from "./support/fake-cines.js";

const ME = 42;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

let tg: MockTelegram;
let cines: FakeCines;
async function buy(opts: FakeCinesOptions) {
  tg = await new MockTelegram().start();
  closers.push(() => tg.stop());
  cines = await startFakeCines({ phase3: true, ...opts });
  closers.push(cines.close);
  const script: Turn[] = [
    { tool: "cines_best_showtime", args: { movie: "Dune", window: "night" } },
    (p) => ({
      tool: "cines_hold_seats",
      args: {
        showtimeId: JSON.parse(lastToolResult(p)).value.best.showtimeId,
        seats: "F7",
      },
    }),
    (p) => ({
      tool: "cines_purchase",
      args: {
        holdId: (JSON.parse(lastToolResult(p)).value ?? {}).holdId,
        expectedTotal: 99,
      },
    }),
    { text: "Listo." },
  ];
  const sm = scriptedModel(script);
  const logs: string[] = [];
  const hub: Hub = createHub(
    testConfig({
      TELEGRAM_BOT_TOKEN: "1:abc",
      TELEGRAM_ALLOWED_USER_IDS: String(ME),
    }),
    {
      model: sm.model as never,
      cinesPollMs: 20,
      registry: CINES_REGISTRY(cines.url),
      telegram: {
        apiBaseUrl: tg.url,
        longPolling: { timeout: 0, retryDelayMs: 50 },
        log: (m) => logs.push(m),
      },
    },
  );
  closers.push(() => hub.stop());
  await hub.start();
  tg.push(textUpdate(ME, "compra el F7 para Dune hoy en la noche, con PayPal"));
  for (const needle of ["tool_approve:call-1", "cines:b:"]) {
    await tg.waitFor(() => !!findButton(tg, needle), 10_000);
    const b = findButton(tg, needle)!;
    tg.push(callbackUpdate(ME, { message_id: b.messageId }, b.data));
  }
  return { sm, logs, hub };
}
const status = () =>
  tg.calls
    .filter(
      (c) =>
        /sendMessage|editMessageText/.test(c.method) &&
        c.body.parse_mode === "HTML",
    )
    .map((c) => String(c.body.text));

describe("PayPal at the Mac: in_progress → the hub polls cines_hold_status", () => {
  it("paid: waiting status, confirmation photo, ✅ with booking number and total; no model calls, never re-calls purchase", async () => {
    const { sm, logs, hub } = await buy({
      inProgress: { polls: 3, outcome: "paid" },
    });
    await tg.waitFor(
      () => status().some((s) => /^✅ 🎟️ Compra confirmada/.test(s)),
      10_000,
    );
    expect(status()).toContain(
      "⏳ Esperando que apruebe el pago en PayPal en el Mac, Master Julian…",
    );
    expect(status().at(-1)).toBe(
      "✅ 🎟️ Compra confirmada: Dune: Mesías · Cinépolis Parque Toreo · lun 19 20:30 · F7 · $99 MXN · reserva BK001 (revise su correo)",
    );
    expect(cines.calls.filter((c) => c.tool === "cines_purchase")).toHaveLength(
      1,
    );
    expect(
      cines.calls.filter((c) => c.tool === "cines_hold_status").length,
    ).toBeGreaterThanOrEqual(3);
    expect(tg.sent("sendPhoto")).toHaveLength(1); // the confirmation screenshot
    const photoAt = tg.calls.indexOf(tg.sent("sendPhoto")[0]!);
    const doneAt = tg.calls.findIndex((c) =>
      /Compra confirmada/.test(String(c.body.text ?? "")),
    );
    expect(photoAt).toBeLessThan(doneAt);
    expect(logs.join("\n")).toMatch(/purchase paid after 3 polls/);
    // the model was not called while polling: 3 tool steps + 1 reply
    expect(sm.calls).toHaveLength(4);
    expect(await hub.cines.successes()).toBe(1);
  });

  it("failed → ❌ with the server message; unknown → ⚠️ not released; neither is retried", async () => {
    await buy({ inProgress: { polls: 2, outcome: "failed" } });
    await tg.waitFor(
      () => status().some((s) => /^❌ El pago no se completó/.test(s)),
      10_000,
    );
    expect(cines.calls.filter((c) => c.tool === "cines_purchase")).toHaveLength(
      1,
    );
    for (const c of closers.splice(0).reverse()) await c();

    await buy({ inProgress: { polls: 2, outcome: "unknown" } });
    await tg.waitFor(() => status().some((s) => /^⚠️/.test(s)), 10_000);
    expect(status().at(-1)).toMatch(
      /^⚠️ No sé si se cobró; revise su correo de Cinépolis y su banco\. No liberé los asientos ni lo reintento\.\n<code>CINES_PAYMENT_UNKNOWN · req [0-9a-f]{6}<\/code>$/,
    );
    expect(cines.calls.map((c) => c.tool)).not.toContain("cines_release_hold");
    expect(cines.calls.filter((c) => c.tool === "cines_purchase")).toHaveLength(
      1,
    );
  });
});

describe("payment not armed", () => {
  it("a clear 🔒 message, not a generic failure; the hold can be paid once armed", async () => {
    const { logs, hub } = await buy({ paymentArmed: false });
    await tg.waitFor(() => status().some((s) => /^🔒/.test(s)), 10_000);
    expect(status().at(-1)).toMatch(
      /^🔒 El pago real no está armado\. En el Mac corra: bin\/cinesctl arm-payment/,
    );
    expect(status().join("\n")).not.toMatch(/❌/);
    expect(logs.join("\n")).toMatch(/not armed on the Mac \(nothing charged\)/);
    // nothing was recorded: the hub's one-attempt claim is released
    expect(await hub.kv.get("cines:attempt:hold_1")).toBeNull();
  });
});

describe("a hold that takes > 40 s: in_progress → the hub polls cines_hold_status", () => {
  it("held: waiting status, then the purchase card from the hold (total from hold-status); hold never re-called", async () => {
    const { sm, logs } = await buy({
      holdInProgress: { polls: 3 },
      inProgress: { polls: 1, outcome: "paid" },
    });
    await tg.waitFor(
      () => status().some((s) => /^✅ 🎟️ Compra confirmada/.test(s)),
      10_000,
    );
    expect(status()).toContain("⏳ Apartando en Cinépolis…");
    expect(
      cines.calls.filter((c) => c.tool === "cines_hold_seats"),
    ).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/hold hold_1 appeared after 3 polls/);
    // the purchase got the hold's total (from hold-status totalMxn), set by the hub
    expect(
      cines.calls.find((c) => c.tool === "cines_purchase")!.args,
    ).toMatchObject({
      holdId: "hold_1",
      expectedTotal: 99,
      userApproved: true,
    });
    expect(
      tg.calls.some((c) =>
        /confirmo la compra[\s\S]*\$99 MXN/.test(
          String(c.body.text ?? "").replace(/\\/g, ""),
        ),
      ),
    ).toBe(true);
    expect(sm.calls).toHaveLength(4); // no model calls while polling
  });

  for (const legacyError of [false, true]) {
    it(`a failed hold job (${legacyError ? "legacy holdError" : "lastJob.error"}): the server error, not retried`, async () => {
      tg = await new MockTelegram().start();
      closers.push(() => tg.stop());
      cines = await startFakeCines({
        phase3: true,
        holdInProgress: {
          polls: 2,
          failError: "Cinépolis respondió: la función ya no admite ventas.",
          legacyError,
        },
      });
      closers.push(cines.close);
      const sm = scriptedModel([
        {
          tool: "cines_hold_seats",
          args: { showtimeId: "570-1002", seats: "F7" },
        },
        (p) => ({
          text: /ya no admite ventas/.test(lastToolResult(p))
            ? "No se pudo."
            : "otro",
        }),
      ]);
      const hub: Hub = createHub(
        testConfig({
          TELEGRAM_BOT_TOKEN: "1:abc",
          TELEGRAM_ALLOWED_USER_IDS: String(ME),
        }),
        {
          model: sm.model as never,
          cinesPollMs: 20,
          registry: CINES_REGISTRY(cines.url),
          telegram: {
            apiBaseUrl: tg.url,
            longPolling: { timeout: 0, retryDelayMs: 50 },
            log: () => {},
          },
        },
      );
      closers.push(() => hub.stop());
      await hub.start();
      tg.push(textUpdate(ME, "aparta el F7 de la 570-1002"));
      await tg.waitFor(() => !!findButton(tg, "tool_approve:"), 10_000);
      const b = findButton(tg, "tool_approve:")!;
      tg.push(callbackUpdate(ME, { message_id: b.messageId }, b.data));
      await tg.waitFor(() => status().some((s) => /^❌/.test(s)), 10_000);
      expect(status().at(-1)).toMatch(
        /^❌ .*Cinépolis respondió: la función ya no admite ventas/,
      );
      expect(
        cines.calls.filter((c) => c.tool === "cines_hold_seats"),
      ).toHaveLength(1);
    });
  }
});

describe('a hold slower than the MCP timeout (the live hold_ac2cffa16eab)', () => {
  it('is not reported as "Cinépolis no responde": the hub polls hold-status and finds the hold; server stays up', async () => {
    tg = await new MockTelegram().start();
    closers.push(() => tg.stop());
    cines = await startFakeCines({ phase3: true, holdDelayMs: 1500 });
    closers.push(cines.close);
    const sm = scriptedModel([{ tool: 'cines_hold_seats', args: { showtimeId: '570-1002', seats: 'B7' } }, { text: 'ok' }]);
    const logs: string[] = [];
    const hub: Hub = createHub(testConfig({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_ALLOWED_USER_IDS: String(ME) }), {
      model: sm.model as never,
      cinesPollMs: 200,
      registry: { servers: { cines: { url: cines.url, timeoutMs: 500 } } }, // shorter than the hold
      telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: (m) => logs.push(m) },
    });
    closers.push(() => hub.stop());
    await hub.start();
    tg.push(textUpdate(ME, 'aparta el B7 de la 570-1002'));
    await tg.waitFor(() => !!findButton(tg, 'tool_approve:'), 10_000);
    const b = findButton(tg, 'tool_approve:')!;
    tg.push(callbackUpdate(ME, { message_id: b.messageId }, b.data));
    // the hub's purchase card shows the hold (no duplicate "🎟️ Apartado" status line)
    await tg.waitFor(() => /confirmo la compra[\s\S]*B7/.test(tg.outgoingText(ME)), 10_000);
    expect(status().join('\n')).not.toMatch(/🎟️ Apartado/);
    expect(status()).toContain('⏳ Apartando en Cinépolis…');
    expect(status().join('\n')).not.toMatch(/no responde|MCP_UNAVAILABLE|❌/);
    // the model saw a normal "held" result (it can now call cines_purchase → the card)
    const toolOut = JSON.stringify(sm.calls[1]!.prompt);
    expect(toolOut).toContain('hold_1');
    expect(toolOut).toMatch(/held/);
    expect(logs.join('\n')).toMatch(/cines_hold_seats failed in transport .*not marking down/);
    expect(logs.join('\n')).not.toMatch(/cines: down/);
    expect(hub.toolbox.status().cines).toMatchObject({ state: 'up' });
    expect(cines.calls.filter((c) => c.tool === 'cines_hold_seats')).toHaveLength(1);
  });

  it('a read that times out does not mark the server down', async () => {
    const { McpToolbox } = await import('../src/mcp/toolbox.js');
    const { parseRegistry } = await import('../src/mcp/registry.js');
    cines = await startFakeCines({ phase3: true, holdDelayMs: 1500 });
    closers.push(cines.close);
    const logs: string[] = [];
    const tb = new McpToolbox(parseRegistry({ servers: { cines: { url: cines.url, timeoutMs: 400 } } }), {}, { log: (m) => logs.push(m) });
    closers.push(() => tb.close());
    expect(await tb.execute('cines_hold_seats', { showtimeId: '570-1002', seats: 'B7' })).toMatchObject({ error: { code: 'MCP_UNAVAILABLE' } });
    expect(tb.status().cines).toMatchObject({ state: 'up' });
    expect(logs.join('\n')).toMatch(/timed out .*server stays up/);
  });
});

describe('the hub purchase card (deterministic, no model)', () => {
  it('shows the summary + Comprar/Cancelar after a hold; expiry edits it and releases; a model purchase call is refused', async () => {
    const { CinesHub } = await import('../src/cines/service.js');
    const sent: { text: string; kb: unknown }[] = [];
    const edits: string[] = [];
    const executed: string[] = [];
    const store = new Map<string, unknown>();
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      setIfNotExists: async (k: string, v: unknown) => (store.has(k) ? false : (store.set(k, v), true)),
      incr: async () => 1,
    };
    const hubc = new CinesHub({
      kv: kv as never,
      toolbox: { execute: async (n: string) => (executed.push(n), { status: 'released' }) },
      securePrompt: () => '',
      secureBadFormat: () => '',
      secureExpired: () => '',
      lang: 'es',
      sendCard: async (_c, text, kb) => (sent.push({ text, kb }), 77),
      editCard: async (_c, _id, text) => void edits.push(text),
    });
    const held = { status: 'held', holdId: 'hold_9', cinema: 'Cinépolis Parque Toreo', movie: 'Clayface', startsAt: '2026-10-23T18:30:00-06:00', seats: ['B8'], ticketType: 'Admision General', unitMxn: 92, chargesMxn: 7, total: 99, currency: 'MXN', expiresAt: new Date(Date.now() + 1200).toISOString(), language: 'SUB', format: '2D' };
    const out = (await hubc.afterResult('cines_hold_seats', {}, held, { chatId: '42' })) as { next: string };
    expect(out.next).toMatch(/hub has shown the user the purchase card/);
    expect(sent[0]!.text).toMatch(/Clayface[\s\S]*Cinépolis Parque Toreo · 2026-10-23 18:30 · subtitulada 2D[\s\S]*B8 · Admision General[\s\S]*\$99 MXN \(boletos \$92 \+ cargos \$7\)[\s\S]*⌛ Expira \d\d:\d\d/);
    expect(JSON.stringify(sent[0]!.kb)).toMatch(/✅ Comprar \$99.*cines:b:hold_9.*❌ Cancelar.*cines:r:hold_9/);
    expect(await hubc.purchaseNeedsApproval({ holdId: 'hold_9' })).toBe(false); // no second approval card
    expect(await hubc.beforeCall('cines_purchase', { holdId: 'hold_9', expectedTotal: 99 }, { chatId: '42' })).toMatchObject({ error: { status: 'card_shown' } });
    await new Promise((r) => setTimeout(r, 1500));
    expect(edits.at(-1)).toMatch(/⌛ El apartado expiró/);
    expect(executed).toContain('cines_release_hold');
    expect(await hubc.buyFromCard('hold_9')).toBeUndefined(); // expired: Comprar no longer works
  });
});
