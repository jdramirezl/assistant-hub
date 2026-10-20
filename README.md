# assistant-hub

Personal assistant you talk to on Telegram. A Mastra agent (Gemini) runs 24/7 on a home Mac
and calls your apps (finance, MyFitnessPal, …) through MCP servers listed in `mcp-servers.json`.

```
Telegram ⇄ (long polling) ⇄ assistant-hub [Mastra · 127.0.0.1:4111 · LibSQL]
                                 ├─ Gemini (gemini-3.5-flash-lite / gemini-3.8-flash)
                                 ├─ Mason MFP MCP   http://127.0.0.1:8484/mcp
                                 ├─ cines-mx-mcp    http://127.0.0.1:8686/mcp (Cinépolis)
                                 └─ finance-app MCP https://<finance-app>/mcp (bearer token)
```

## Requirements

- macOS, Node ≥ 22.13 (Node 24 recommended). On Intel Macs prefer the nodejs.org LTS `.pkg` over Homebrew, which builds Node from source there.
- A Gemini API key on the paid (prepaid) tier

## Development (dev Mac)

```bash
npm ci
cp .env.example .env && chmod 600 .env   # fill in GOOGLE_API_KEY
npm test          # unit + integration tests (no network, no keys needed)
npm run check     # typecheck + lint + tests
npm run dev       # Mastra Studio at http://localhost:4111
```

Values set to `CHANGEME` are treated as not configured. With no Telegram token (or no
`TELEGRAM_ALLOWED_USER_IDS`), the hub runs in Studio-only mode and logs a warning.

### Trying Cinépolis on the dev bot (this laptop)

The dev bot uses `DEV_GOOGLE_API_KEY` (AssistantDev project) as its model key: outside
production it wins over `GOOGLE_API_KEY`, so the prod key is never spent in dev. Startup logs
`[models] Gemini key from DEV_GOOGLE_API_KEY (dev project)`.

```bash
cd ~/code/cines-mx-mcp && npx tsx src/cli.ts probe          # must say OK (FAIL CINES_BLOCKED = Cloudflare blocks this network)
npm run dev &                                                # cines-mx-mcp on 127.0.0.1:8686 (read tools + seat maps, no login)
cd ~/code/assistant-hub && grep -q '^DEV_GOOGLE_API_KEY=' .env || sed -n 's/^REPLAY_GOOGLE_API_KEY=/DEV_GOOGLE_API_KEY=/p' .env >> .env
grep -q '^CINES_MCP_URL=' .env || echo 'CINES_MCP_URL=http://127.0.0.1:8686/mcp' >> .env
npm run dev                                                  # dev hub + @jdrami_hub_dev_bot (long polling)
```

## Apps (MCP servers)

Apps are listed in `mcp-servers.json`. Adding an app means adding one entry; secrets are
referenced by env var name, never written in the file:

```json
"finance": {
  "url": "${FINANCE_MCP_URL}",
  "headers": { "Authorization": { "env": "FINANCE_MCP_TOKEN", "prefix": "Bearer " } }
}
```

- Tools keep a single app prefix (`finance_*`, `fitness_*`); unprefixed tools get `<server>_`.
- A server that is down is skipped (the agent is told which app is unavailable) and retried every minute.
- A server that restarted (e.g. `mfpctl restart`, the weekly refresh) answers "Session not found":
  the hub re-initializes and retries that call once, transparently (rejected before dispatch, so
  safe for writes too).
- `finance_create_movement`: the hub fills `accountId` from the `pocketId` (cached accounts/pockets;
  each pocket is listed with its `accountId` in the prompt).
- Plain `http://` is only accepted for loopback hosts; remote servers must use `https://`.
- Tool errors use the shared shape `{"error":{"code","message","retryable"}}`.
- Local stub for development: `npm run stub:echo` (serves `echo_say`, `echo_delete`, `echo_fail` on `127.0.0.1:8585`); set its `enabled` to `true` locally.
- `toolPrefix` keeps a server's own tool prefix when it differs from the server name (`mfp` serves `fitness_*`).
- `errorStyle: "mason"` maps Mason's plain-text `isError` failures to `MFP_UNAVAILABLE` (retryable), `MFP_SESSION_EXPIRED`, `MFP_BLOCKED`, `MFP_BAD_REQUEST`, `MFP_ERROR`.
- Approval by name, in addition to `destructiveHint`/delete-like verbs: `fitness_delete_food`, `fitness_delete_exercise`, `fitness_modify_food`, `fitness_clear_food_pin`.

Going live on the server Mac: apps are switched on by their URL in `.env` (see below).
`cines` (cines-mx-mcp) is enabled where `CINES_MCP_URL` is set; it uses the default error style
(`CINES_UNAVAILABLE` retryable; `CINES_BLOCKED`, `CINES_SCHEMA_CHANGED`, `CINES_NOT_FOUND`,
`CINES_BAD_REQUEST`, `CINES_SESSION_EXPIRED`, `CINES_HOLD_EXPIRED`, `CINES_PAYMENT_FAILED`,
`CINES_LIMIT_EXCEEDED` not).
`finance` is enabled in the registry but **gated per machine by `.env`**: with `FINANCE_MCP_URL`/`FINANCE_MCP_TOKEN`
set (server Mac, prod token) it connects; left as `CHANGEME` (dev laptop) it is skipped. Never put the prod token on
the dev laptop: it writes to real finances. To test finance in dev, point it at a Vercel **preview** deployment with
`preview.token` and `FINANCE_MCP_BYPASS` (sent as `x-vercel-protection-bypass`; optional headers are omitted when unset).

## Approvals and budget

- **Smart writes:** reads and additive writes run directly. Tools marked `destructiveHint: true`,
  or with a delete-like verb in the name (`_delete_`, `_remove_`, …), require approval:
  Approve/Deny buttons in Telegram, an approval prompt in Studio. Only the requester can answer,
  and pending approvals survive restarts (stored in LibSQL).
- **Daily cap:** tokens and estimated cost are counted per day (America/Bogota midnight reset).
  Defaults: `DAILY_TOKEN_CAP=2000000`, `DAILY_COST_CAP_USD=1`. When either is hit the bot replies
  "⏸️ Paused, budget hit" without calling the model. The prepaid Gemini balance remains the hard stop.

## Batch plans (one approval for many changes)

When a request needs 2 or more approval-gated actions (e.g. clearing an MFP day, deleting several
finance movements), the agent calls the hub-local `propose_plan` tool instead of asking 17 times.
Telegram shows ONE message: the plan grouped by section (meal / account), with
**✅ Approve all**, **✏️ Edit** and **❌ Cancel**. Long plans are split across messages.

- **Approve all:** the hub runs exactly the stored calls, in order, without asking the model again
  (the plan is fingerprinted; a changed plan is refused). No tool chatter while it runs; then the
  agent sends one summary. It stops early on `MFP_SESSION_EXPIRED` / `UNAUTHORIZED`, otherwise it
  continues and reports each failure.
- **Edit:** reply in text ("skip the coffee"); the agent sends a revised plan and the old one is disabled.
- **Cancel:** nothing runs. Plans expire after 30 min, survive restarts (LibSQL), and only the
  allowlisted user can press the buttons.
- Backstop: if the model still calls 2+ gated tools in one step, they are not run and it is told to
  use `propose_plan`. A single gated action keeps the normal Approve/Deny card.

## Only the final answer reaches the chat

- Text the model writes in a step that calls tools (Gemini often narrates its plan there) is
  dropped at the model layer; the live status shows what is happening instead.
- A final reply that looks like planning (tool names, "Rule check", "Let's call", "the user wants
  to"…) is retried once with feedback, then the leaking lines are removed.
- After a plan card is shown, the model's text is dropped: the card is the message.
- Every approval card is written for the user ("🗑️ Borrar de MyFitnessPal: Egg (desayuno)"),
  never tool names or raw arguments. The replay fails any scenario whose messages leak.

## Clearing days (`clear_day`)

- "Borra todo el desayuno", "limpia hoy y mañana": the hub-side `clear_day({dates, meals,
  then_log})` reads each day, builds the deletes itself (one per entry, from the diary) and shows
  ONE compact card ("• Desayuno 2026-10-20: 4 entradas, 620 kcal"). After ✅ the hub runs every
  delete in code, then the optional re-add (`then_log`, the same items as `log_meal`), and sends
  one summary (items it could not log are listed). Each entry is one
  `fitness_delete_food(query=<exact name>, meal, date)` call. On Mason 0.4.1 identical duplicates
  can't be deleted by name: the summary says "N entradas no se pudieron borrar (duplicados
  idénticos…)" and nothing is retried (the same code succeeds once Mason is upgraded). A single
  delete that matches several entries (or none) becomes a ❓ question with the candidates.
  While the card waits, the status says
  "❓ Esperando su aprobación"; "Ejecutando N…" only appears after ✅.

## MyFitnessPal logging quality

- Meals go through the hub-side **`log_meal`** tool: one call with every item (English name, the
  user's quantity and unit, the model's kcal estimate). In code, per item: Mason draft → first
  serving matching the unit (quantity converted to servings) → must be within 2× of the estimate →
  log (pinned in Mason, so a confirmed food/serving is preferred next time) → meal totals. Items it
  is not sure about are **not guessed**: they come back as `ambiguous` and Alfred asks.
- **Hard guard:** any single `fitness_log_food` entry estimated above **800 kcal** needs approval,
  whatever the model decided. The estimate comes from Mason's draft (calories per serving for the
  whole entry, scaled by a quantity override) or search results; for pinned foods (no estimate up
  front) the log result is checked and the agent is told to confirm or fix it.
- Each log result carries `entry_kcal` and `meal_total`, so the agent reports e.g.
  "Breakfast logged: 3 items, 420 kcal".

## Voice notes

- A voice note is transcribed by the hub first (one flash-lite call, kind `transcribe` in `llm_calls`,
  counted in the daily budget). The agent then gets `[voice note] <transcript>` as text, so the
  topic router, the meal and the reply language work as for typed messages. If transcription fails,
  the audio is sent to the agent as before.
- **Meal in code:** `log_meal` uses the meal the user said (cena → Dinner, almuerzo/comida → Lunch,
  desayuno → Breakfast, snack/merienda/onces → Snacks); with no meal word, a plain "comí X" about
  now uses the Bogotá hour. The model's guess is overridden (and logged).
- **Language:** a voice note's language goes in the prompt tail ("reply in Spanish").
- **Common foods** (rice, beans, pasta, soup, salad, drinks, chicken, eggs, bread, arepa, fruit) get a
  standard portion when the unit is vague ("arroz", "un plato de arroz" = 1.5 cups), so they are
  logged without asking. The 2× check and the 800 kcal guard still apply.

## Cines (Cinépolis)

- **Topic:** película, cine, cartelera, función, boletos, Cinépolis, horarios, asientos, estreno,
  preventa, IMAX, VIP, the cinema names and seat labels ("F7,F8") load only the `cines_*` tools and
  the cines rules (the user's cinemas, subtitled first, 1–4 adults, seat preferences, best + 2
  alternatives). An unclear follow-up within 20 min, and approval buttons, keep the topic.
- **Seat maps:** when a result carries `imageUrl`, the hub fetches it (loopback http only, PNG
  checked, ≤ 5 MB, 5 s) and uploads it with `sendPhoto` before the reply. The model only sees
  "image sent"; if it fails, it is told to say so and list the seats.
- **Showtime ids are checked in code:** the hub remembers the showtimes the user was shown
  (best_showtime / showtimes / seat map, 30 min). A hold or seat check with an id the user never
  saw uses the seat map's showtime (or the only one shown), else goes back to the model with the
  real ids. Seats are validated (`cines_validate_seats`) BEFORE the hold card, which shows the
  real function. Placeholder args ("...") are rejected; calls to tools that don't exist and
  failures the model recovered from in the same run never show a ❌. Error results carry the
  real cause (`user_message`) so the model does not invent another. Photo delivery is logged
  (`[photo] sent N bytes` / `[photo] failed: …`).
- **Secure input** (CVV, bank 3DS/OTP, Cinépolis e-mail code): a result
  `{status:"needs_cvv"|"needs_3ds"|"needs_email_code", challengeId, kind, expiresAt}` opens ONE
  pending request per chat (LibSQL, no secret stored, ≤ 5 min or the server's `expiresAt`) and
  Alfred asks "🔒 Envíe el CVV, Amo Julián. No lo verá el modelo…" (plus the result's image, if any).
  The user's next message is taken by the channel before the agent: it is deleted from the chat,
  format-checked by the hub (code 6 digits, CVV 3–4, OTP 4–10 alphanumerics; a bad one is asked
  again without calling anything), sent straight to the hub-only `cines_submit_code`, and never
  reaches the model, memory, logs or `llm_calls`; the agent gets only the redacted result.
  "cancelar" stops; a late reply up to 10 min after expiry is still deleted and not used.
- **Purchase rules (code, not prompt):**
  - `cines_hold_seats` and `cines_purchase` are approval-gated; `cines_release_hold` never is.
  - The first 3 successful purchases always show a summary card (cinema, movie, time, seats,
    total MXN) with ✅/❌. After that, the hold's approval covers the purchase of that hold.
  - Hard cap **$1,000 MXN** per purchase, checked against the total of the hold the hub saw (never
    the model's number); over it the call is refused before reaching the server.
  - The hub sets `expectedTotal` (the hold's `total`, fees included) and `userApproved` itself; the
    model cannot. If the server's hold result still says `purchaseApprovalRequired`, the card is shown.
  - ❌ on the purchase card releases the hold (`cines_release_hold`); unanswered holds expire on the
    server after ~9 min.
  - `CINES_PURCHASE_DRY_RUN=1` sends every purchase with `dryRun` (nothing is charged; not counted).
    Real payment is disabled on cines-mx-mcp until the live PayPal check.
  - A hold is paid at most once (claimed before the call): a failed or unknown payment is never
    retried. The success counter is persistent (LibSQL). Money tools cannot go in batch plans.
- The Phase 3 tool shapes follow cines-mx-mcp's final contract v1 (docs/hub-integration.md,
  `542f827`) and live in `src/cines/contract.ts` only; test fixtures are exported from that commit.

## Status messages (`src/status/`)

Every non-answer message comes from one layer, in Alfred's voice and the request's language:
icon + what happened + what's next, one line.

- **One live message per request**, separate from Alfred's answer, edited in place (throttled):
  📥 received (voice/photo/pdf, right away) → ⏳ working (after ~8 s, specific: "Buscando 4
  alimentos en MyFitnessPal…") → the result. A quick read-only answer gets no status message.
- **Result from the tool results, not the model's words:** ✅ done (only after a successful
  write: "✅ Desayuno: 3 alimentos, 420 kcal · 3 gastos, $35.000"), ⚠️ partial ("Guardé 2 de 3
  gastos. Falló: camisa $262 — falta la cuenta. ¿Con cuál la pagó?"), ❌ failed, ❓ need info.
  Failures carry a monospace line `CODE · req 7f3a2c`; the same id prefixes the hub log lines
  (`[req 7f3a2c] …`) and is the `request_id` in `llm_calls`.
- **Error table** (`src/status/errors.ts`): every known code → a sentence + an action (es/en);
  unknown codes still name the code. Validation errors name the missing field.
- ⏸️ only for a real Gemini 429; the hub's own pacing just shows ⏳. Recoverable errors are
  retried first (validation → model, MCP session → reconnect, 503 → retry).
- 🔌 when an app is down for 10+ min and when it is back; 🔄 once per deploy/reboot with the
  version (git sha, or `HUB_VERSION`) and the connected apps; 💸 when the daily budget is hit.
- The false-save guard also catches "todo registrado" when some writes failed.
- **`/estado`** (allowlisted user, no model call): apps with tool counts and up/down time, Gemini
  calls today per model (+ 429s) and peak RPM, budget used vs cap, the last 3 failures with their
  request ids, the deployed version.

## Persona

By default the assistant is **Alfred** (Alfred Pennyworth): formal, dry wit, "Amo Julián" in
Spanish and "Master Julian" in English, one short line and then plain facts. It also voices the
startup ping, weekly digest, "app is back" and rate-limit notices. Switch off with
`HUB_PERSONA=plain`; `HUB_LANGUAGE` (es/en) sets the language of notices and plan buttons, and
`OWNER_NAME` the name.

## Usage, cost and the replay harness

- Every Gemini HTTP call (including 429 attempts) is logged in the `llm_calls` table: request id,
  step, kind (chat/resume/plan/digest), keyword intent (meal, mfp-other, expense, finance-read,
  plan, mixed, chat), media, model, tokens (input/cached/output/thinking), tools sent, system
  prompt size, tools called.
- **`/usage`** in Telegram (allowlisted user, no model call): today and the last 7 days — requests
  and calls per intent, calls and input tokens per request, cached %, peak RPM, and the estimated
  cost at paid prices (flash-lite $0.30 in / $0.03 cached / $2.50 out per 1M; thinking billed as output).
- **Replay** (`npm run replay -- --label <name> [--only id,id]`, opt-in, uses real Gemini and the
  free-tier quota, paced at 12 RPM): 25 typical requests through the real Telegram channel against
  replicas of Mason, finance-app and cines-mx-mcp that serve their exact tool definitions
  (`tests/support/fixtures/*-tools.json`); voice fixtures are regenerated with
  `tests/support/fixtures/make-voice.sh`; `REPLAY_DEBUG=1` prints the hub log and the bot's messages. It records the writes each request caused plus calls and
  tokens; `npm run replay -- --compare baseline,final` prints the before/after table.

## How calls and tokens are kept low

- **Stable prefix:** static rules first; the clock (hour precision), app status and the cached
  finance accounts go in a `## Now` tail, so Gemini's implicit cache can reuse the prefix.
- **Short working memory:** updated only when the user states a durable preference.
- **Trimmed results:** drafts keep 3 options and the servings that match the unit; log results drop
  the day dump; finance lists keep essential fields. Older turns keep their text, not their tool calls.
- **Tools by topic:** a keyword router sends only fitness or finance tools (plus `propose_plan`);
  unclear messages and voice notes get all of them.
- **`log_meal`:** a whole meal in one model step (see above); **finance accounts/pockets** are cached
  by the hub and put in the prompt, so an expense is one tool call.
- **Pacing:** calls wait for a slot below 14 RPM (flash-lite) / 4 RPM (3.8-flash) instead of hitting 429.
  Inline media (a voice note's base64) is not counted as text tokens, and each window entry is
  corrected with the tokens Gemini billed. A pacing wait of 10 s or more says "⏳ Un momento…
  procesando"; "Límite de Gemini, reintento en N s" is only for real 429s. Voice notes get an
  immediate "🎙️ Recibido…" acknowledgement.

## Weekly digest

- The `weekly-digest` workflow is scheduled by Mastra for **Sunday 19:00 America/Bogota** (`0 19 * * 0`).
- If the Mac was asleep or off at that time, the missed digest is sent at the next startup.
  Each week is sent at most once, so the scheduler, the catch-up and retries can't double-send.
- Apps contribute *sections* (`DigestSection` in `src/digest.ts`); the `reporter` agent writes the
  message on `gemini-3.8-flash`. With no sections yet, a short placeholder is sent without a model call.
- Run it now: `npm run digest`. It's safe while the service runs, because delivery uses a plain `sendMessage`.
  Without Telegram configured, the digest is written to the log.

## Running 24/7 on the server Mac

Do this on the always-on Mac itself; no SSH is needed.

```bash
git clone git@github.com:jdramirezl/assistant-hub.git ~/code/assistant-hub
cd ~/code/assistant-hub
scripts/setup-mac.sh           # add --dry-run to preview; it asks before sudo or installs
$EDITOR .env                   # GOOGLE_API_KEY (+ Telegram, healthchecks when ready)
scripts/deploy.sh              # anytime later: pull → ci → test → build → restart → health check
```

`setup-mac.sh`:
- detects Apple Silicon or Intel and the macOS version
- picks a Node ≥ 22.13 on a stable path for launchd: `NODE_BIN` in `.env`, else Homebrew `node@24`/`node`, `/usr/local/bin/node` (nodejs.org pkg) or `node` on PATH; it only offers `brew install node@24` if none is found
- creates `~/Library/Application Support/assistant-hub` (mode 700) and `~/Library/Logs/assistant-hub`
- sets `.env` to mode 600
- offers `sudo pmset -c sleep 0 disksleep 0 displaysleep 10 womp 1 autorestart 1`
- reminds you about the battery charge limit and the lid
- installs two LaunchAgents:

| LaunchAgent | What |
|---|---|
| `com.jdrami.assistant-hub` | `node .mastra/output/index.mjs`, `KeepAlive`, starts at login, restarts on crash (30s throttle) |
| `com.jdrami.assistant-hub.backup` | 03:15 daily: consistent sqlite snapshot to iCloud Drive `assistant-hub-backups/`, keeps 7; trims logs over 10 MB |

The plists are rendered from `launchd/*.plist.tmpl` by `scripts/render-plist.sh` using this machine's paths.

In production (`NODE_ENV=production`), at startup the hub:
- sends "✅ I'm up" on Telegram (at most once per 5 minutes, so crash loops stay quiet)
- pings `HEALTHCHECK_URL` every 5 minutes, or `/fail` if its database check fails; set the healthchecks.io period to 5 min and the grace time to about 10 min
- catches up a missed weekly digest

Useful commands:

```bash
launchctl print gui/$(id -u)/com.jdrami.assistant-hub | head -20   # status
launchctl kickstart -k gui/$(id -u)/com.jdrami.assistant-hub       # restart
tail -f ~/Library/Logs/assistant-hub/hub.err.log                   # logs
curl -s http://127.0.0.1:4111/health                               # health
npm run backup                                                     # backup now
launchctl bootout gui/$(id -u)/com.jdrami.assistant-hub            # stop (until next setup/deploy)
```

Restore a backup: stop the service, then copy a snapshot over
`~/Library/Application Support/assistant-hub/mastra.db` (delete any `mastra.db-wal`/`-shm` first), then kickstart.


### Per-machine `.env` (server Mac)

Apps are switched on by their URL in `.env`, not by editing `mcp-servers.json`:

```bash
MFP_MCP_URL=http://127.0.0.1:8484/mcp               # Mason on this Mac
CINES_MCP_URL=http://127.0.0.1:8686/mcp             # cines-mx-mcp on this Mac
FINANCE_MCP_URL=https://finance-app-backend-ten.vercel.app/mcp
FINANCE_MCP_TOKEN=<contents of ~/.config/finance-mcp/prod.token>
HEALTHCHECK_URL=https://hc-ping.com/<uuid>          # optional, healthchecks.io check (period 5 min, grace 10 min)
# NODE_BIN=/usr/local/bin/node                      # only if auto-detection picks the wrong Node
```

Keep the checkout clean: `deploy.sh` refuses to run with local edits.

### Keeping a MacBook server alive

- **Closed lid:** `pmset` sleep settings don't stop clamshell sleep without an external display.
  Run `sudo pmset -a disablesleep 1` to keep it awake with the lid closed (undo with
  `sudo pmset -a disablesleep 0`). It runs warmer closed; leave it on a hard, ventilated surface.
- **Login required:** LaunchAgents start only after you log in. After a reboot or power cut the
  bot stays down until someone logs in. Automatic login fixes that but **requires turning FileVault
  off** (System Settings → Users & Groups → Automatically log in as…). The tradeoff: with
  FileVault off, anyone with the laptop can read the disk, including `.env`. With FileVault on,
  plan to log in by hand after reboots; `autorestart 1` brings the Mac back after power loss,
  but not past the login screen.
- **macOS updates:** turn off automatic install (System Settings → General → Software Update →
  Automatic Updates: keep "Download" and "Security Responses" if you like, turn off "Install macOS
  updates"). Otherwise an overnight update reboots the Mac to the login screen and the bot is
  down until you notice. Update by hand, then check that the bot says "✅ I'm up".
- **Know when it's down:** set `HEALTHCHECK_URL` and turn on email/Telegram alerts in
  healthchecks.io. The hub pings every 5 minutes; a sleeping Mac, a crash loop or a dead network
  all show up as missed pings.

## Security notes

- The Mastra server has **no auth**; it is only ever bound to loopback (config rejects anything else).
- Telegram is fail-closed: it is not started unless `TELEGRAM_ALLOWED_USER_IDS` is set.
- `.env` must be mode 600 and is git-ignored; the plists contain no secrets. Telemetry is disabled (`MASTRA_TELEMETRY_DISABLED=1`).
- `deploy.sh`/`setup-mac.sh` fail if port 4111 is ever listening on a non-loopback address.
- Backups go to iCloud Drive (your Apple ID); they contain chat history and preferences. Snapshot files are mode 600.

## Layout

| Path | What |
|---|---|
| `src/config.ts` | Env schema (Zod), placeholders, safe defaults |
| `src/hub.ts` | Builds the Mastra instance (all wiring) |
| `src/mastra/index.ts` | Entry point for `mastra dev` / `mastra build` |
| `src/channels/telegram.ts` | Telegram channel (polling, allowlist, dedup) |
| `src/mcp/` | Registry parsing and the MCP toolbox |
| `src/approvals.ts` | Which tools need approval |
| `src/cines/` | Cines: contract adapter, purchase policy + secure input, images, approval cards |
| `src/voice/`, `src/meal.ts` | Voice-note transcription; meal and language from the user's words |
| `src/budget.ts` | Daily token/cost cap (counter + agent processor) |
| `src/digest.ts`, `src/workflows/weekly-digest.ts` | Weekly digest and its schedule |
| `src/notify.ts` | Proactive Telegram messages (digest, startup ping) |
| `src/ops.ts` | Startup "I'm up" ping and healthchecks.io heartbeat |
| `launchd/`, `scripts/` | LaunchAgent templates, setup/deploy/backup scripts |
| `stub/echo-server.ts` | Echo MCP server for development |
| `tests/` | Vitest tests; `tests/live` runs only with `npm run test:live` |
