#!/usr/bin/env bash
# Talk to the local debug entry point (npm run debug-server) and print a compact transcript.
#   scripts/debug-chat.sh "¿qué comí hoy?"
#   scripts/debug-chat.sh --write "almorcé arroz"        # allow writes for this request
#   scripts/debug-chat.sh --press "Aprobar" [--write]     # press a card button
#   scripts/debug-chat.sh --voice note.ogg | --image receipt.jpg ["caption"]
#   scripts/debug-chat.sh --json "…"                      # raw JSON
set -euo pipefail
DIR="${DEBUG_DATA_DIR:-${HUB_DATA_DIR:-$HOME/Library/Application Support/assistant-hub}/debug}"
URL="http://127.0.0.1:${DEBUG_PORT:-4112}"
TOKEN_FILE="$DIR/debug-token"
[ -r "$TOKEN_FILE" ] || { echo "no token at $TOKEN_FILE: start it with 'npm run debug-server'" >&2; exit 1; }
write=false; path=/debug/chat; json=false; voice=""; image=""; button=""
while [ $# -gt 0 ]; do
  case "$1" in
    --write) write=true ;;
    --json) json=true ;;
    --press) path=/debug/press; button="$2"; shift ;;
    --voice) voice="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift ;;
    --image) image="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift ;;
    *) break ;;
  esac
  shift
done
text="${1:-}"
body=$(TEXT="$text" VOICE="$voice" IMAGE="$image" BUTTON="$button" WRITE="$write" node -e '
  const e = process.env, b = { allowWrites: e.WRITE === "true" };
  if (e.BUTTON) b.button = e.BUTTON; if (e.VOICE) b.voice = e.VOICE; if (e.IMAGE) b.image = e.IMAGE; if (e.TEXT) b.text = e.TEXT;
  process.stdout.write(JSON.stringify(b));')
out=$(curl -sS --max-time 300 -X POST "$URL$path" -H 'content-type: application/json' -H "x-debug-token: $(cat "$TOKEN_FILE")" -d "$body")
if $json; then echo "$out"; exit 0; fi
OUT="$out" node -e '
  const r = JSON.parse(process.env.OUT);
  if (r.error) { console.log("✗ " + r.error); process.exit(1); }
  for (const m of r.messages) {
    const tag = { status: "· status", card: "▣ card", photo: "▧ photo", delete: "✕ delete", message: "» alfred" }[m.kind] ?? m.kind;
    const t = (m.text ?? m.file ?? "").replace(/\n/g, "\n                ");
    console.log(`${(tag + (m.op === "editMessageText" ? " (edit)" : "")).padEnd(16)}${t}`);
    if (m.buttons) console.log("                [" + m.buttons.map((b) => b.label).join("] [") + "]");
  }
  const calls = r.llmCalls.length, inTok = r.llmCalls.reduce((a, x) => a + x.input, 0);
  console.log(`— req ${r.requestIds.join(",") || "?"} · ${calls} Gemini calls · ${Math.round(inTok / 100) / 10}K in · today ${r.geminiCallsToday} · writes ${r.allowWrites ? "ON" : "off"}`);'
