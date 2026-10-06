#!/usr/bin/env bash
# push-state.sh — write to the reels branch without clobbering other writers.
#
#   push-state.sh "<commit message>" <command that edits ./state and ./staging>
#
# Runs the edit inside a throwaway worktree of origin/reels, commits and pushes
# with no force. If another job pushed first, it starts over from the fresh
# branch and re-runs the edit, which is why every edit must be an idempotent
# upsert rather than a copy of a whole file.
set -euo pipefail
MSG="$1"; shift
REPO="$(git rev-parse --show-toplevel)"
for attempt in 1 2 3 4 5; do
  WT="$(mktemp -d)"
  git -C "$REPO" fetch -q origin reels
  git -C "$REPO" worktree add -q --detach "$WT" origin/reels
  ( cd "$WT" && mkdir -p state staging && REPO="$REPO" bash -c "$*" )
  if ( cd "$WT" && git add -A && { git diff --cached --quiet || git -c user.name=finalyst-reels-bot -c user.email=prabhashsahaj@gmail.com commit -qm "$MSG"; } && git push -q origin HEAD:reels ); then
    git -C "$REPO" worktree remove --force "$WT"; echo "pushed: $MSG"; exit 0
  fi
  git -C "$REPO" worktree remove --force "$WT"
  echo "push raced on attempt $attempt, retrying"; sleep $((attempt * 3))
done
echo "could not push state after 5 attempts" >&2; exit 1
