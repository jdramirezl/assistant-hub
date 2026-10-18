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
- Local stub for development: `npm run stub:echo` (serves `echo_say`, `echo_delete`, `echo_fail` on `127.0.0.1:8585`).

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

## Security notes

- The Mastra server has **no auth**; it is only ever bound to loopback (config rejects anything else).
- Telegram is fail-closed: it is not started unless `TELEGRAM_ALLOWED_USER_IDS` is set.
- `.env` must be mode 600 and is git-ignored. Telemetry is disabled (`MASTRA_TELEMETRY_DISABLED=1`).

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
| `stub/echo-server.ts` | Echo MCP server for development |
| `tests/` | Vitest tests; `tests/live` runs only with `npm run test:live` |
