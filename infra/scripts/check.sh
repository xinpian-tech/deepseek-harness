#!/usr/bin/env bash
# The fleet project's check entry point (infra-requirements.dsh.md §2.4).
#
# Every acceptance set the fleet generates names this script, so a task on this
# repository is accepted or rejected by exactly one machine-decidable command:
#
#   nix develop -c infra/scripts/check.sh
#
# It runs inside `nix develop`, so the TypeScript compiler, vitest and tmux are
# the flake's, never the host's. `nix flake check` and `nix build .#default`
# remain separate acceptance criteria; this script covers the source checks
# that need the workspace.
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "== fleet typecheck =="
# Build mode, because a package tsconfig carries project references: `tsc -p`
# alone refuses ("output file has not been built"). Emitted declarations land
# under the packages' `lib/types`, which `.gitignore` covers.
./node_modules/.bin/tsc -b \
  packages/infra/tmux \
  packages/infra/subagent-tmux \
  packages/infra/tmux-gateway \
  packages/infra/worker-template \
  packages/infra/prompt-source \
  packages/infra/git-checkpoint \
  packages/infra/session-archive \
  packages/infra/worktree \
  packages/infra/ledger \
  packages/infra/machine-registry \
  packages/infra/task-spec \
  packages/infra/config-generation \
  packages/infra/nix-sandbox \
  packages/infra/nix-shell \
  packages/infra/nix-mandate

echo "== fleet tests =="
# `infra/vitest.config.ts` hands Vite the repository's own alias table. The
# repository entry point resolves those aliases through the root solution
# tsconfig, which maps nothing, so it falls through to unbuilt `lib/` output.
./node_modules/.bin/vitest run --config infra/vitest.config.ts

echo "== fleet composition =="
# The removal layer and the composition layer must name plugins that exist.
./node_modules/.bin/tsx scripts/verify-cordis-config.ts
