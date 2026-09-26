#!/usr/bin/env bash
# Launch (or reuse) one persistent worker pane (infra requirement §11 item 4,
# §5.3 transport).
#
# A worker is a `dsh --profile sdk` process living inside a tmux pane. It stays
# alive for the whole task because `session/prompt` enqueues rather than
# completes, and a fresh process would recreate the session instead of resuming
# it (§5.4). The pane is the real-time channel's physical carrier: stdin carries
# NDJSON frames in, `pipe-pane` carries NDJSON frames out.
#
# Usage:
#   dsh-fleet-worker start <pane-key> [--cwd DIR]
#   dsh-fleet-worker send  <pane-key> <frame-file>
#   dsh-fleet-worker read  <pane-key> [--lines N]
#   dsh-fleet-worker stop  <pane-key>
#
# `pane-key` names the worker; the same key always maps to the same tmux window,
# which is what makes `context: resident` mean "resume the same conversation".
set -euo pipefail

# The harness binary is pinned by the flake that built this script; an operator
# may point at a different one for a canary, but never at an unbuilt checkout.
DSH_BIN="${DSH_FLEET_DSH:-dsh}"
SESSION_PREFIX="${DSH_FLEET_TMUX_PREFIX:-dsh-fleet}"
# Credentials are injected through the process environment (§8.2). dsh strips
# credential-shaped variables when it spawns an out-of-process child, so the
# worker template must hand them to the pane explicitly.
CREDENTIAL_VARS=(
  DEEPSEEK_API_KEY
  DEEPSEEK_BASE_URL
  ANTHROPIC_API_KEY
  OPENAI_API_KEY
  MOONSHOT_API_KEY
  GEMINI_API_KEY
  GOOGLE_API_KEY
  ZHIPUAI_API_KEY
)

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

session_name() { printf '%s' "$SESSION_PREFIX"; }
window_name() { printf 'w-%s' "$1"; }

# Build the `-e VAR=value` list tmux needs. tmux copies the server's environment
# into new panes, and the tmux server outlives this script, so every credential
# must be passed on each pane-creating call.
tmux_env_args() {
  local var
  for var in "${CREDENTIAL_VARS[@]}"; do
    if [[ -n "${!var:-}" ]]; then
      printf -- '-e\n%s=%s\n' "$var" "${!var}"
    fi
  done
}

ensure_session() {
  if ! tmux has-session -t "$(session_name)" 2>/dev/null; then
    tmux new-session -d -s "$(session_name)" -n "$(window_name bootstrap)"
  fi
}

cmd_start() {
  local key="$1" cwd="$2"
  ensure_session
  local window
  window="$(window_name "$key")"

  if tmux list-windows -t "$(session_name)" -F '#{window_name}' | grep -qx "$window"; then
    printf '%s\n' "$window"
    return 0
  fi

  local frame_dir="${DSH_FLEET_FRAMES:-$PWD/.dsh-fleet/frames/$key}"
  mkdir -p "$frame_dir"

  # shellcheck disable=SC2046 # word splitting is the point: -e VAR=value pairs
  tmux new-window -d -t "$(session_name)" -n "$window" -c "$cwd" $(tmux_env_args) \
    "$DSH_BIN --profile sdk"

  # `stty -echo -icanon` is mandatory: a tty echoes what is written to it, and
  # that echo would arrive in the output stream as a corrupted frame (§5.3).
  tmux send-keys -t "$(session_name):$window" -l "stty -echo -icanon"$'\n'

  # Output side of the channel: newline-delimited JSON-RPC frames appended to
  # the worker's own frame log.
  tmux pipe-pane -t "$(session_name):$window" -o "cat >>'$frame_dir/out.ndjson'"

  printf '%s\n' "$window"
}

cmd_send() {
  local key="$1" frame="$2"
  # `-l` sends the bytes literally, so a JSON frame is never interpreted as key
  # names, and the trailing newline delimits it.
  tmux send-keys -t "$(session_name):$(window_name "$key")" -l "$(cat "$frame")"$'\n'
}

cmd_read() {
  local key="$1" lines="$2"
  local frame_dir="${DSH_FLEET_FRAMES:-$PWD/.dsh-fleet/frames/$key}"
  tail -n "$lines" "$frame_dir/out.ndjson"
}

cmd_stop() {
  local key="$1"
  tmux kill-window -t "$(session_name):$(window_name "$key")" 2>/dev/null || true
}

command="${1:-}"
case "$command" in
  start)
    key="${2:?pane key required}"
    cwd="$PWD"
    shift 2
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --cwd)
          cwd="$2"
          shift 2
          ;;
        *) usage ;;
      esac
    done
    cmd_start "$key" "$cwd"
    ;;
  send)
    cmd_send "${2:?pane key required}" "${3:?frame file required}"
    ;;
  read)
    key="${2:?pane key required}"
    lines=200
    shift 2
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --lines)
          lines="$2"
          shift 2
          ;;
        *) usage ;;
      esac
    done
    cmd_read "$key" "$lines"
    ;;
  stop)
    cmd_stop "${2:?pane key required}"
    ;;
  *) usage ;;
esac
