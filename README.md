# assistant-hub

Personal assistant you talk to on Telegram. A Mastra agent (Gemini) runs 24/7 on a home Mac
and calls your apps (finance, MyFitnessPal, …) through MCP servers listed in `mcp-servers.json`.

```
Telegram ⇄ (long polling) ⇄ assistant-hub [Mastra · 127.0.0.1:4111 · LibSQL]
                                 ├─ Gemini (gemini-3.5-flash-lite / gemini-3.8-flash)
                                 ├─ Mason MFP MCP   http://127.0.0.1:8484/mcp
                                 └─ finance-app MCP https://<finance-app>/mcp (bearer token)
```

## Requirements

- macOS, Node 24 (`mise install` or `brew install node@24`; Node ≥ 22.13 works)
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
- Plain `http://` is only accepted for loopback hosts; remote servers must use `https://`.
- Tool errors use the shared shape `{"error":{"code","message","retryable"}}`.
- Local stub for development: `npm run stub:echo` (serves `echo_say`, `echo_delete`, `echo_fail` on `127.0.0.1:8585`); set its `enabled` to `true` locally.
- `toolPrefix` keeps a server's own tool prefix when it differs from the server name (`mfp` serves `fitness_*`).
- `errorStyle: "mason"` maps Mason's plain-text `isError` failures to `MFP_UNAVAILABLE` (retryable), `MFP_SESSION_EXPIRED`, `MFP_BLOCKED`, `MFP_BAD_REQUEST`, `MFP_ERROR`.
- Approval by name, in addition to `destructiveHint`/delete-like verbs: `fitness_delete_food`, `fitness_delete_exercise`, `fitness_modify_food`, `fitness_clear_food_pin`.

Going live on the server Mac: set `"enabled": true` for `mfp` once Mason runs there; for `finance`, add
`FINANCE_MCP_URL` and `FINANCE_MCP_TOKEN` to `.env` and set `"enabled": true`.

## Approvals and budget

- **Smart writes:** reads and additive writes run directly. Tools marked `destructiveHint: true`,
  or with a delete-like verb in the name (`_delete_`, `_remove_`, …), require approval:
  Approve/Deny buttons in Telegram, an approval prompt in Studio. Only the requester can answer,
  and pending approvals survive restarts (stored in LibSQL).
- **Daily cap:** tokens and estimated cost are counted per day (America/Bogota midnight reset).
  Defaults: `DAILY_TOKEN_CAP=2000000`, `DAILY_COST_CAP_USD=0.5`. When either is hit the bot replies
  "⏸️ Paused, budget hit" without calling the model. The prepaid Gemini balance remains the hard stop.

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
- installs Homebrew `node@24`, which has a stable path for launchd
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
| `src/budget.ts` | Daily token/cost cap (counter + agent processor) |
| `src/digest.ts`, `src/workflows/weekly-digest.ts` | Weekly digest and its schedule |
| `src/notify.ts` | Proactive Telegram messages (digest, startup ping) |
| `src/ops.ts` | Startup "I'm up" ping and healthchecks.io heartbeat |
| `launchd/`, `scripts/` | LaunchAgent templates, setup/deploy/backup scripts |
| `stub/echo-server.ts` | Echo MCP server for development |
| `tests/` | Vitest tests; `tests/live` runs only with `npm run test:live` |
