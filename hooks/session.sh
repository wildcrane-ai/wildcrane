#!/bin/sh
# Tells the model this Cursor conversation's id, which discuss-goal keeps its goals under, and the
# Runner's `akb`. Cursor puts no conversation id in the agent's shell, so the model passes it.
[ -n "${WILDCRANE_JOB:-}" ] && exit 0
id=$(tr -d '\n' | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_.:-]*\)".*/\1/p')
[ -n "$id" ] || exit 0
akb="${WILDCRANE_HOME:-$HOME/.wildcrane}/bin/akb/akb"
printf '{"additional_context":"WildCrane: this Cursor conversation id is %s. Run every akb command for discuss-goal as `CURSOR_CONVERSATION_ID=%s akb ...`. When `akb` is not on PATH, run `%s` in its place."}\n' "$id" "$id" "$akb"
