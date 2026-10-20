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
  tg.push(textUpdate(ME, "compra el F7 para Dune hoy en la noche"));
  for (const needle of ["tool_approve:call-1", "tool_approve:call-2"]) {
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
      "⏳ Esperando que apruebe el pago en PayPal en el Mac, Amo Julián…",
    );
    expect(status().at(-1)).toBe(
      "✅ 🎟️ Compra confirmada: reserva BK001 · $99 MXN",
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
      /^⚠️ No sé si se cobró; revise su correo\. No liberé los asientos\.\n<code>CINES_PAYMENT_UNKNOWN · req [0-9a-f]{6}<\/code>$/,
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
        /Confirmar compra[\s\S]*\$99 MXN/.test(
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
    await tg.waitFor(() => status().some((x) => /^✅ 1 apartado de asientos/.test(x)), 10_000);
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
