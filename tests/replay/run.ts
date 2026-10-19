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

const RESULTS = join(import.meta.dirname, 'results');
const FIXTURES = join(import.meta.dirname, '..', 'support', 'fixtures');
const ME = 42;
const RPM = Number(process.env.REPLAY_RPM ?? 12);

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
  ms: number;
}

/** Sliding-window pacer + in-flight counter around the real fetch (protects the shared quota). */
function pacedFetch() {
  const starts: number[] = [];
  let inflight = 0;
  let lastActivity = Date.now();
  const f = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    for (;;) {
      const now = Date.now();
      while (starts.length && now - starts[0]! >= 60_000) starts.shift();
      if (starts.length < RPM) break;
      await new Promise((r) => setTimeout(r, 60_000 - (now - starts[0]!) + 50));
    }
    starts.push(Date.now());
    inflight++;
    lastActivity = Date.now();
    try {
      return await fetch(input, init);
    } finally {
      inflight--;
      lastActivity = Date.now();
    }
  }) as typeof fetch;
  return { fetch: f, busy: () => inflight > 0, lastActivity: () => lastActivity };
}

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
  };
  const mason = await startMasonReplica(state, today);
  const finance = await startFinanceReplica(state, today, 'replay-token');
  const tg = await new MockTelegram().start();
  for (const f of ['receipt.png', 'voice-expense.wav', 'voice-meal.wav']) {
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
    MCP_REGISTRY_PATH: join(process.cwd(), 'mcp-servers.json'),
  };
  const logs: string[] = [];
  const hub: Hub = createHub(loadConfig(env), {
    env,
    geminiFetch: pacer.fetch,
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
          cards.push(data.includes('plan:a:') ? `plan(${(text.match(/(\d+) (acciones|actions)/) ?? [])[1] ?? '?'})` : `tool:${(text.match(/fitness\\?_\w+|finance\\?_\w+|\w+_\w+/) ?? ['?'])[0]!.replace(/\\/g, '')}`);
          tg.push(callbackUpdate(ME, { message_id: msgId, text }, data));
          found = true;
          await settle();
        }
      }
      if (!found) return;
    }
  };

  for (const turn of s.turns) {
    tg.push(toUpdate(turn));
    await settle();
    await approvePending();
  }
  await sleep(500);
  const rows = (await hub.usage.rows(t0)).filter((r) => r.kind !== 'digest');
  const ok = rows.filter((r) => r.status === 200);
  const reply = tg.calls
    .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && String(c.body.chat_id) === String(ME))
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
    actions: state.actions.map((a) => `${a.app}.${a.op} ${a.detail}`),
    cards,
    ok: true,
    reply: reply.slice(0, 400),
    ms: Date.now() - t0,
  };
  const verdict = s.ok({ actions: state.actions, state, cards, reply, today, yesterday });
  result.ok = verdict === true ? true : String(verdict);
  await hub.stop();
  await tg.stop();
  await mason.close();
  await finance.close();
  return result;

  function toUpdate(m: Msg) {
    if (typeof m === 'string') return textUpdate(ME, m);
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
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY is required (npm run replay loads .env)');
  mkdirSync(RESULTS, { recursive: true });
  const out = join(RESULTS, `${label}.json`);
  const prev = existsSync(out) && args.includes('--resume') ? (JSON.parse(readFileSync(out, 'utf8')).results as ScenarioResult[]) : [];
  const pacer = pacedFetch();
  const results: ScenarioResult[] = [...prev];
  for (const s of SCENARIOS) {
    if (only && !only.has(s.id)) continue;
    if (results.some((r) => r.id === s.id)) continue;
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
