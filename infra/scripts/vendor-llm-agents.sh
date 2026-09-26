#!/usr/bin/env bash
# Replace the vendored numtide/llm-agents.nix copy with another revision.
#
# The fleet pins an exact revision (§8.1): dsh is a developer preview, so a
# production fleet must not follow the upstream default branch. This script
# fetches one revision, replaces `infra/nix/llm-agents.nix` wholesale, and
# records the revision, narHash and nixpkgs revision in `infra/nix/vendor.json`.
#
# Usage:
#   infra/scripts/vendor-llm-agents.sh <rev-or-tag>
#
# After it runs, re-lock the workspace flake and re-run the checks:
#   nix flake lock && nix flake check && nix build .#default
set -euo pipefail

REV="${1:?usage: vendor-llm-agents.sh <rev-or-tag>}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VENDOR_DIR="$REPO_ROOT/infra/nix/llm-agents.nix"
VENDOR_RECORD="$REPO_ROOT/infra/nix/vendor.json"

# `nix flake metadata` resolves the reference, fetches it into the store and
# prints everything the record needs, so no separate clone or checksum step is
# required.
metadata="$(nix flake metadata "github:numtide/llm-agents.nix/$REV" --json)"
store_path="$(printf '%s' "$metadata" | jq -r '.path')"
rev="$(printf '%s' "$metadata" | jq -r '.revision')"
nar_hash="$(printf '%s' "$metadata" | jq -r '.locked.narHash')"
last_modified="$(printf '%s' "$metadata" | jq -r '.locked.lastModified')"
nixpkgs_rev="$(jq -r '.nodes.nixpkgs.locked.rev' "$store_path/flake.lock")"

rm -rf "$VENDOR_DIR"
cp -r "$store_path" "$VENDOR_DIR"
chmod -R u+w "$VENDOR_DIR"

jq -n \
  --arg url "github:numtide/llm-agents.nix" \
  --arg rev "$rev" \
  --arg narHash "$nar_hash" \
  --argjson lastModified "$last_modified" \
  --arg vendorPath "infra/nix/llm-agents.nix" \
  --arg nixpkgsRev "$nixpkgs_rev" \
  '{
    url: $url,
    rev: $rev,
    narHash: $narHash,
    lastModified: $lastModified,
    vendorPath: $vendorPath,
    nixpkgsRev: $nixpkgsRev,
    note: "Production fleets pin an exact revision: dsh is a developer preview, so tracking the upstream default branch would import every upstream refactor into 100 machines. infra/scripts/vendor-llm-agents.sh replaces this copy wholesale."
  }' > "$VENDOR_RECORD"

# The vendored tree carries a `lib/` directory that the repository's
# `.gitignore` (`lib/`) would otherwise hide; Nix only sees tracked files, so
# force-add it or the flake fails to evaluate.
git -C "$REPO_ROOT" add -f "$VENDOR_DIR" >/dev/null

echo "vendored llm-agents.nix at $rev (nixpkgs $nixpkgs_rev)"
echo "next: nix flake lock && nix flake check && nix build .#default"
