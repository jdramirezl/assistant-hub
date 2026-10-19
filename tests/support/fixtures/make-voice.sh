#!/usr/bin/env bash
# Regenerate the synthetic voice-note fixtures used by the replay (macOS `say` + `afconvert`).
# 16 kHz mono 16-bit WAV, like the original voice-meal.wav / voice-expense.wav.
set -euo pipefail
cd "$(dirname "$0")"
make() { # file voice text
  local tmp; tmp=$(mktemp -t voice).aiff
  say -v "$2" -o "$tmp" "$3"
  afconvert -f WAVE -d LEI16@16000 -c 1 "$tmp" "$1"
  rm -f "$tmp"
  echo "wrote $1"
}
make voice-breakfast.wav Paulina "En el desayuno me comí dos huevos revueltos y una arepa."
make voice-snack.wav     Paulina "Me comí un banano."
make voice-dinner-en.wav Samantha "For dinner I had a plate of rice and a grilled chicken breast."
# Was an opaque recording that Gemini heard as "almuerzo y cena" / "una taza de maicena";
# regenerated with an unambiguous meal word (the scenario: a dinner voice note).
make voice-meal.wav      Paulina "Para la cena comí una porción de arroz y una pechuga de pollo a la plancha."
