/**
 * Replay harness: ~25 typical requests through the REAL Telegram channel and REAL Gemini,
 * against replicas of Mason and finance-app. Records the writes each request caused, plus
 * model calls and tokens (from llm_calls). Opt-in and paced (shares the free-tier quota):
 *
 *   npm run replay -- --label baseline            # all scenarios
 *   npm run replay -- --label step1 --only a,b    # a subset
 *   npm run replay -- --compare baseline,step1    # table only
 *
 * Results: tests/replay/results/<label>.json
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { createHub, type Hub } from '../../src/hub.js';
import { bogotaDay } from '../../src/budget.js';
import { MockTelegram, photoUpdate, textUpdate, callbackUpdate, voiceUpdate } from '../support/mock-telegram.js';
import { startFinanceReplica, startMasonReplica, type ReplicaState } from './replica.js';
import { SCENARIOS, type Msg, type Scenario } from './scenarios.js';
import { devGeminiKey } from '../support/dev-key.js';
import { startFakeCines } from '../support/fake-cines.js';

const RESULTS = join(import.meta.dirname, 'results');
const FIXTURES = join(import.meta.dirname, '..', 'support', 'fixtures');
const ME = 42;
const RPM = Number(process.env.REPLAY_RPM ?? 12);
/** Hard stop: the run ends once this many Gemini HTTP calls were made (429s included). */
const MAX_CALLS = Number(process.env.REPLAY_MAX_CALLS ?? 120);

class BudgetExceeded extends Error {}

export interface ScenarioResult {
  id: string;
  calls: number;
  rateLimited: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  toolsSentAvg: number;
  systemCharsAvg: number;
  actions: string[];
  cards: string[];
  ok: true | string;
  reply: string;
  /** Final text of the request's status message, if any. */
  status?: string;
  ms: number;
}

/** Sliding-window pacer + in-flight counter around the real fetch (protects the shared quota). */
function pacedFetch() {
  const starts: number[] = [];
  let inflight = 0;
  let total = 0;
  let lastActivity = Date.now();
  const bodies: string[] = [];
  const f = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    inflight++; // waiting for a slot counts as busy
    lastActivity = Date.now();
    for (;;) {
      const now = Date.now();
      while (starts.length && now - starts[0]! >= 60_000) starts.shift();
      if (starts.length < RPM) break;
      await new Promise((r) => setTimeout(r, 60_000 - (now - starts[0]!) + 50));
    }
    if (total >= MAX_CALLS) {
      inflight--;
      throw new BudgetExceeded(`replay call budget reached (${MAX_CALLS} calls; REPLAY_MAX_CALLS)`);
    }
    total++;
    starts.push(Date.now());
    lastActivity = Date.now();
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    try {
      return await fetch(input, init);
    } finally {
      inflight--;
      lastActivity = Date.now();
    }
  }) as typeof fetch;
  return { fetch: f, busy: () => inflight > 0, lastActivity: () => lastActivity, total: () => total, bodies };
}

/** Today at hh:30 in Bogotá (UTC-5, no DST). */
const atLocalHour = (h: number) => Date.parse(`${bogotaDay(Date.now(), 'America/Bogota')}T${String(h).padStart(2, '0')}:30:00-05:00`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runScenario(s: Scenario, pacer: ReturnType<typeof pacedFetch>, apiKey: string): Promise<ScenarioResult> {
  const t0 = Date.now();
  const today = bogotaDay(Date.now(), 'America/Bogota');
  const yesterday = bogotaDay(Date.now() - 86_400_000, 'America/Bogota');
  const state: ReplicaState = {
    diary: structuredClone(s.diary ?? []),
    pins: structuredClone(s.pins ?? []),
    actions: [],
    calls: [],
    movements: structuredClone(s.movements ?? []).map((m) => ({ ...m, displayedDate: m.displayedDate === 'TODAY' ? today : m.displayedDate })),
    ...(s.financeReject ? { rejectCreate: s.financeReject } : {}),
  };
  const mason = await startMasonReplica(state, today);
  const finance = await startFinanceReplica(state, today, 'replay-token');
  // like the real server today: real payment disabled; the hub sends dryRun (CINES_PURCHASE_DRY_RUN)
  const cines = await startFakeCines({ phase3: true, realPaymentDisabled: true, ...(s.cines ?? {}) });
  const tg = await new MockTelegram().start();
  for (const f of ['receipt.png', 'voice-expense.wav', 'voice-meal.wav', 'voice-breakfast.wav', 'voice-snack.wav', 'voice-dinner-en.wav', 'voice-mixed.wav', 'voice-snack-items.wav']) {
    tg.addFile(f, { path: `files/${f}`, mime: f.endsWith('.png') ? 'image/png' : 'audio/wav', bytes: readFileSync(join(FIXTURES, f)) });
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'replay-'));
  const env = {
    GOOGLE_API_KEY: apiKey,
    HUB_DATA_DIR: dataDir,
    TELEGRAM_BOT_TOKEN: '1:replay',
    TELEGRAM_ALLOWED_USER_IDS: String(ME),
    MFP_MCP_URL: mason.url,
    FINANCE_MCP_URL: finance.url,
    FINANCE_MCP_TOKEN: 'replay-token',
    CINES_MCP_URL: cines.url,
    CINES_PURCHASE_DRY_RUN: '1',
    MCP_REGISTRY_PATH: join(process.cwd(), 'mcp-servers.json'),
  };
  const logs: string[] = [];
  const hub: Hub = createHub(loadConfig(env), {
    env,
    geminiFetch: pacer.fetch,
    ...(s.localHour !== undefined ? { localNow: () => atLocalHour(s.localHour!) } : {}),
    telegram: { apiBaseUrl: tg.url, longPolling: { timeout: 0, retryDelayMs: 50 }, log: (m) => logs.push(m) },
  });
  const memory = await hub.mastra.getAgentById('assistant').getMemory();
  await memory?.updateWorkingMemory({
    threadId: 'seed',
    resourceId: `telegram:${ME}`,
    workingMemory: '# User preferences\n- Name: Julián\n- Language preference: Spanish\n- Default currency: COP\n- Pockets / accounts: Nequi, Bancolombia, Nu México\n',
  });
  await hub.start();
  const cards: string[] = [];
  const pressed = new Set<string>();

  /** Wait until the bot is idle: no model call in flight and no Telegram/model activity for 4 s. */
  const settle = async () => {
    let lastCalls = -1;
    let quietSince = Date.now();
    for (let waited = 0; waited < 240_000; waited += 250) {
      await sleep(250);
      if (tg.calls.length !== lastCalls || pacer.busy()) {
        lastCalls = tg.calls.length;
        quietSince = Date.now();
        continue;
      }
      if (Date.now() - quietSince > 4000 && Date.now() - pacer.lastActivity() > 4000) return;
    }
  };
  /** Press any approval button that appeared (the user approves everything in the replay). */
  const approvePending = async () => {
    for (let round = 0; round < 6; round++) {
      let found = false;
      for (const call of [...tg.calls]) {
        const kb = (call.body.reply_markup as { inline_keyboard?: { callback_data?: string; text?: string }[][] } | undefined)?.inline_keyboard;
        for (const btn of kb?.flat() ?? []) {
          const data = btn.callback_data ?? '';
          const isApprove = /tool_approve:|plan:a:/.test(data);
          if (!isApprove || pressed.has(data)) continue;
          pressed.add(data);
          const msgId = Number(call.body.message_id ?? (call.result as { message_id?: number } | undefined)?.message_id ?? 0);
          const text = String(call.body.text ?? (call.body.rich_message as { markdown?: string } | undefined)?.markdown ?? '');
          cards.push(data.includes('plan:a:') ? `plan(${(text.match(/(\d+) (acciones|actions)/) ?? [])[1] ?? '?'})` : `tool:${(text.replace(/\\/g, '').match(/(?:fitness|finance)_\w+|\w+_\w+/) ?? ['?'])[0]}`);
          tg.push(callbackUpdate(ME, { message_id: msgId, text }, data));
          found = true;
          await settle();
        }
      }
      if (!found) return;
    }
  };

  for (const turn of s.turns) {
    if (typeof turn === 'object' && 'secret' in turn) {
      // the user types a secret ONLY when the hub asked for it privately (🔒); it must go to
      // cines_submit_code, never to the model
      if (!/🔒/.test(tg.outgoingText(ME))) {
        logs.push('SKIPPED: secret turn, but the hub never asked for a secure input');
        continue;
      }
      tg.push(textUpdate(ME, turn.secret));
      await settle();
      await approvePending();
      continue;
    }
    tg.push(toUpdate(turn));
    await settle();
    await approvePending();
  }
  await sleep(500);
  const rows = (await hub.usage.rows(t0)).filter((r) => r.kind !== 'digest');
  const ok = rows.filter((r) => r.status === 200);
  // status messages (HTML, the hub's own) are not Alfred's reply
  const status = tg.calls
    .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.body.parse_mode === 'HTML' && String(c.body.chat_id) === String(ME))
    .map((c) => String(c.body.text ?? ''));
  const reply = tg.calls
    .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.body.parse_mode !== 'HTML' && String(c.body.chat_id) === String(ME))
    .map((c) => String((c.body.rich_message as { markdown?: string } | undefined)?.markdown ?? c.body.text ?? ''))
    .filter((t) => t && t !== '...')
    .at(-1) ?? '';
  const result: ScenarioResult = {
    id: s.id,
    calls: rows.length,
    rateLimited: rows.filter((r) => r.status === 429).length,
    inputTokens: ok.reduce((a, r) => a + r.inputTokens, 0),
    cachedTokens: ok.reduce((a, r) => a + r.cachedTokens, 0),
    outputTokens: ok.reduce((a, r) => a + r.outputTokens, 0),
    toolsSentAvg: ok.length ? Math.round(ok.reduce((a, r) => a + r.toolsSent, 0) / ok.length) : 0,
    systemCharsAvg: ok.length ? Math.round(ok.reduce((a, r) => a + r.systemChars, 0) / ok.length) : 0,
    actions: [...state.actions.map((a) => `${a.app}.${a.op} ${a.detail}`), ...cines.actions.map((a) => `cines.${a.op} ${a.detail}`)],
    cards,
    ok: true,
    reply: reply.slice(0, 400),
    status: status.at(-1),
    ms: Date.now() - t0,
  };
  const cinesCalls = cines.calls.map((c) => c.tool);
  const photos = tg.sent('sendPhoto').length;
  // a secret the user typed must never reach Gemini
  for (const t of s.turns) if (typeof t === 'object' && 'secret' in t && pacer.bodies.some((b) => b.includes(t.secret))) logs.push('LEAK: secret sent to Gemini');
  const verdict = s.ok({ actions: state.actions, state, cards, reply, today, yesterday, cines: { calls: cinesCalls, args: cines.calls, actions: cines.actions, secrets: cines.secrets }, photos, logs, outgoing: tg.outgoingText(ME), status: status.at(-1) ?? '' });
  result.ok = verdict === true ? true : String(verdict);
  if (process.env.REPLAY_DEBUG) console.log(`--- ${s.id} status: ${status.join(' → ')}`);
  if (process.env.REPLAY_DEBUG) console.log(`--- ${s.id} bot said:\n${tg.calls.filter((c) => /send|edit/.test(c.method) && c.method !== 'sendChatAction').map((c) => `  [${c.method}] ${String((c.body.rich_message as { markdown?: string } | undefined)?.markdown ?? c.body.text ?? '').slice(0, 300)}`).join('\n')}\n--- cines calls: ${JSON.stringify(cines.calls)}`);
  if (process.env.REPLAY_DEBUG) console.log(`--- ${s.id} hub log\n${logs.filter((l) => !/^\[mcp\] \w+: up/.test(l)).join('\n')}\n--- reply: ${reply}`);
  await hub.stop();
  await tg.stop();
  await mason.close();
  await finance.close();
  await cines.close();
  return result;

  function toUpdate(m: Msg) {
    if (typeof m === 'string') return textUpdate(ME, m);
    if ('secret' in m) return textUpdate(ME, m.secret);
    if ('photo' in m) return photoUpdate(ME, m.photo, m.caption);
    const u = voiceUpdate(ME, m.voice) as { message: { voice: { mime_type: string } } };
    u.message.voice.mime_type = 'audio/wav';
    return u;
  }
}

function table(labels: string[]) {
  const runs = labels.map((l) => JSON.parse(readFileSync(join(RESULTS, `${l}.json`), 'utf8')) as { label: string; results: ScenarioResult[] });
  const base = runs[0]!;
  const ids = base.results.map((r) => r.id);
  const lines = [`| scenario | ${runs.map((r) => `${r.label} calls / in / cached`).join(' | ')} | same actions | ok |`, `|---|${runs.map(() => '---').join('|')}|---|---|`];
  const tot = runs.map(() => ({ calls: 0, input: 0, cached: 0, n: 0 }));
  for (const id of ids) {
    const cells = runs.map((run, i) => {
      const r = run.results.find((x) => x.id === id);
      if (!r) return '—';
      tot[i]!.calls += r.calls;
      tot[i]!.input += r.inputTokens;
      tot[i]!.cached += r.cachedTokens;
      tot[i]!.n++;
      return `${r.calls} / ${(r.inputTokens / 1000).toFixed(1)}K / ${(r.cachedTokens / 1000).toFixed(1)}K`;
    });
    const last = runs.at(-1)!.results.find((x) => x.id === id);
    const b = base.results.find((x) => x.id === id)!;
    const same = last ? (JSON.stringify([...last.actions].sort()) === JSON.stringify([...b.actions].sort()) ? 'yes' : 'NO') : '—';
    lines.push(`| ${id} | ${cells.join(' | ')} | ${same} | ${last ? (last.ok === true ? '✓' : `✗ ${last.ok.slice(0, 60)}`) : '—'} |`);
  }
  lines.push(`| **total** | ${tot.map((t) => `${t.calls} / ${(t.input / 1000).toFixed(0)}K / ${(t.cached / 1000).toFixed(0)}K (n=${t.n})`).join(' | ')} | | |`);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const get = (k: string) => args[args.indexOf(k) + 1];
  if (args.includes('--compare')) return console.log(table(get('--compare')!.split(',')));
  const label = get('--label') ?? 'run';
  const only = args.includes('--only') ? new Set(get('--only')!.split(',')) : undefined;
  const { key: apiKey, reason } = devGeminiKey();
  if (!apiKey) throw new Error(`refusing to run: ${reason}`);
  mkdirSync(RESULTS, { recursive: true });
  const out = join(RESULTS, `${label}.json`);
  const prev = existsSync(out) && args.includes('--resume') ? (JSON.parse(readFileSync(out, 'utf8')).results as ScenarioResult[]) : [];
  const pacer = pacedFetch();
  const results: ScenarioResult[] = [...prev];
  for (const s of SCENARIOS) {
    if (only && !only.has(s.id)) continue;
    if (results.some((r) => r.id === s.id)) continue;
    if (pacer.total() >= MAX_CALLS) {
      console.log(`STOPPED: call budget of ${MAX_CALLS} reached before ${s.id}; resume later with --resume`);
      break;
    }
    const r = await runScenario(s, pacer, apiKey);
    results.push(r);
    writeFileSync(out, JSON.stringify({ label, at: new Date().toISOString(), results }, null, 1) + '\n');
    console.log(`${r.ok === true ? '✓' : '✗'} ${r.id}: ${r.calls} calls${r.rateLimited ? ` (429×${r.rateLimited})` : ''}, ${(r.inputTokens / 1000).toFixed(1)}K in (${(r.cachedTokens / 1000).toFixed(1)}K cached), tools ${r.toolsSentAvg}, ${Math.round(r.ms / 1000)}s | ${r.actions.join(' ; ') || 'no actions'}${r.cards.length ? ` | cards ${r.cards.join(',')}` : ''}${r.ok === true ? '' : ` | ✗ ${r.ok}`}`);
  }
  const sum = (f: (r: ScenarioResult) => number) => results.reduce((a, r) => a + f(r), 0);
  console.log(`TOTAL ${label}: ${results.length} scenarios, ${sum((r) => r.calls)} calls, ${(sum((r) => r.inputTokens) / 1000).toFixed(0)}K in, ${(sum((r) => r.cachedTokens) / 1000).toFixed(0)}K cached, ok ${results.filter((r) => r.ok === true).length}/${results.length}`);
}

void main().then(
  () => process.exit(0),
  (err) => (console.error(err), process.exit(1)),
);
