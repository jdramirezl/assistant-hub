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
| `tests/` | Vitest tests; `tests/live` runs only with `npm run test:live` |
