#!/usr/bin/env bash
# Two-phase git archival (infra requirement §7.1, §11 item 6).
#
# Phase 1 — every turn commits locally. No network, no blocking; a turn never
# waits on a remote.
# Phase 2 — pushes happen asynchronously with bounded backoff until they
# succeed. Only the final commit of a task pushes synchronously, because the
# parent layer must be able to fetch that commit before it continues.
#
# Putting the network round-trip inside the turn loop would let one unreachable
# remote freeze every machine in the fleet; splitting the phases confines that
# failure to the final push.
#
# Usage:
#   dsh-fleet-push commit  <repo> <message>          # phase 1
#   dsh-fleet-push enqueue <repo> <ref> [<remote>]   # phase 2, background retry
#   dsh-fleet-push drain   [<state-dir>]             # retry every pending ref
#   dsh-fleet-push final   <repo> <ref> [<remote>]   # synchronous, blocks until pushed
set -euo pipefail

STATE_DIR="${DSH_FLEET_PUSH_STATE:-${DSH_HOME:-$PWD/.dsh}/push-queue}"
BACKOFF_BASE_SECONDS="${DSH_FLEET_PUSH_BACKOFF:-2}"
BACKOFF_MAX_SECONDS="${DSH_FLEET_PUSH_BACKOFF_MAX:-300}"
MAX_ATTEMPTS="${DSH_FLEET_PUSH_ATTEMPTS:-0}" # 0 = retry forever

log() { printf '[dsh-fleet-push] %s\n' "$*" >&2; }

# A queue entry is a single line: <repo>\t<remote>\t<ref>. The ref is what makes
# a push idempotent: re-pushing an already-pushed ref succeeds without a change.
queue_path() { printf '%s/pending.tsv' "$1"; }

cmd_commit() {
  local repo="$1" message="$2"
  git -C "$repo" add -A
  if git -C "$repo" diff --cached --quiet; then
    log "nothing to commit in $repo"
    return 0
  fi
  git -C "$repo" commit --quiet -m "$message"
  git -C "$repo" rev-parse HEAD
}

cmd_enqueue() {
  local repo="$1" ref="$2" remote="${3:-origin}"
  mkdir -p "$STATE_DIR"
  local entry
  entry="$(printf '%s\t%s\t%s' "$repo" "$remote" "$ref")"
  touch "$(queue_path "$STATE_DIR")"
  if ! grep -Fqx "$entry" "$(queue_path "$STATE_DIR")"; then
    printf '%s\n' "$entry" >>"$(queue_path "$STATE_DIR")"
  fi
  log "enqueued $ref -> $remote"
}

# Push one entry with exponential backoff. Returns non-zero only when the
# attempt budget is exhausted (MAX_ATTEMPTS > 0) or the ref is gone.
push_entry() {
  local repo="$1" remote="$2" ref="$3"
  local attempt=1 delay="$BACKOFF_BASE_SECONDS"
  while true; do
    if git -C "$repo" push --quiet "$remote" "$ref" 2>/dev/null; then
      return 0
    fi
    if [[ "$MAX_ATTEMPTS" -gt 0 && "$attempt" -ge "$MAX_ATTEMPTS" ]]; then
      log "giving up on $ref after $attempt attempts"
      return 1
    fi
    log "push $ref failed (attempt $attempt), retrying in ${delay}s"
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
    if [[ "$delay" -gt "$BACKOFF_MAX_SECONDS" ]]; then
      delay="$BACKOFF_MAX_SECONDS"
    fi
  done
}

cmd_drain() {
  local dir="${1:-$STATE_DIR}"
  local pending
  pending="$(queue_path "$dir")"
  [[ -f "$pending" ]] || return 0
  local remaining
  remaining="$(mktemp)"
  # A ref is dropped from the queue only after its push succeeded, so a crash
  # mid-drain loses nothing.
  while IFS=$'\t' read -r repo remote ref; do
    [[ -n "${repo:-}" ]] || continue
    if push_entry "$repo" "$remote" "$ref"; then
      log "pushed $ref"
    else
      printf '%s\t%s\t%s\n' "$repo" "$remote" "$ref" >>"$remaining"
    fi
  done <"$pending"
  mv "$remaining" "$pending"
}

cmd_final() {
  local repo="$1" ref="$2" remote="${3:-origin}"
  # The one synchronous push: the parent layer must be able to fetch this
  # commit, so blocking here is the point rather than a regression.
  push_entry "$repo" "$remote" "$ref"
  cmd_drain
}

command="${1:-}"
shift || true
case "$command" in
  commit) cmd_commit "${1:?repo required}" "${2:?message required}" ;;
  enqueue) cmd_enqueue "${1:?repo required}" "${2:?ref required}" "${3:-origin}" ;;
  drain) cmd_drain "${1:-}" ;;
  final) cmd_final "${1:?repo required}" "${2:?ref required}" "${3:-origin}" ;;
  *)
    log "usage: commit|enqueue|drain|final"
    exit 2
    ;;
esac
