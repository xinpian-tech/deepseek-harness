# infra/ — Nix as the fleet's only dependency source

English | [中文](README.zh.md)

This directory documents the fleet's build and deployment wiring, not a package surface.

`infra/requirements` is satisfied from here: everything the cluster needs to build and run is expressed in Nix, and nothing depends on a tool that happens to exist on a machine. The requirement this implements is [`infra-requirements.dsh.md`](../infra-requirements.dsh.md), chiefly its invariant **R-8** (§2) and its change list (§11).

## What Nix enforces

| Layer | Mechanism | Where |
|---|---|---|
| Environment | The dev shell carries node, pnpm, tmux, git, jq, nix and the harness binaries; nothing is installed on the host | [`../flake.nix`](../flake.nix) `devShells.default` |
| Execution | Commands run through `nix develop -c …`, and the `@dsh-fleet/nix-shell` plugin runs every agent shell command inside the flake | [`../packages/infra/nix-shell`](../packages/infra/nix-shell/README.md) |
| Visibility | `@dsh-fleet/nix-sandbox` confines a command to `/nix/store` (read-only), the workspace and a private temp directory, with no package manager on `PATH` and no network unless a flake input needs it | [`../packages/infra/nix-sandbox`](../packages/infra/nix-sandbox/README.md) |
| Declaration | A prompt section at order 700, written together with the workspace `AGENTS.md` so every harness in the fleet reads the same rule | [`../packages/infra/nix-mandate`](../packages/infra/nix-mandate/README.md) |

## Commands

```sh
nix develop                      # the only supported build environment
nix develop -c infra/scripts/check.sh   # typecheck + fleet tests + composition gate
nix build .#default              # the deployable fleet runtime (`result/`)
nix flake check                  # runtime, vendoring record, change inventory
```

`nix build .#default` produces one store path holding the fleet entry points (`dsh-fleet-machine-id`, `dsh-fleet-worker`, `dsh-fleet-push`), the profile patch layers, the vendored harness flake, the change inventory and the ConfigGeneration fingerprint. Deleting `result/` and rebuilding reproduces it.

Harness binaries are **not** re-exported as packages of this flake, because `nix flake check` builds everything a flake exposes and this repository does not own those artifacts. Take them from the vendored flake:

```sh
nix build ./infra/nix/llm-agents.nix#codex
nix build ./infra/nix/llm-agents.nix#claude-code
```

## Layout

| Path | Role |
|---|---|
| [`../flake.nix`](../flake.nix) | Inputs, packages, dev shells, checks |
| [`nix/fleet.nix`](nix/fleet.nix) | Assembles the runtime, the shells, the ConfigGeneration fingerprint and the inventory checks |
| [`nix/llm-agents.nix/`](nix/llm-agents.nix) | The vendored upstream flake: every harness the fleet places in a pane |
| [`nix/vendor.json`](nix/vendor.json) | The revision, narHash and nixpkgs revision the vendored copy is pinned to |
| [`fleet.manifest.json`](fleet.manifest.json) | Every §11 change and §12 removal mapped to the package or patch row that implements it |
| [`scripts/`](scripts) | `machine-id.sh`, `worker.sh`, `push-queue.sh`, `check.sh`, `vendor-llm-agents.sh` |
| [`vitest.config.ts`](vitest.config.ts) | Test entry point for the fleet packages |

## Vendoring numtide/llm-agents.nix

The fleet never fetches harnesses at run time: the upstream flake is copied into [`nix/llm-agents.nix/`](nix/llm-agents.nix) and pinned by this repository's own `flake.lock`. `nix/llm-agents.nix/flake.lock` and `nix/vendor.json` record the same revision, and [`nix/fleet.nix`](nix/fleet.nix) refuses to evaluate if they disagree — a fleet whose recorded fingerprint does not match the harness it ran cannot explain a result after the fact.

Re-vendor a different revision with:

```sh
infra/scripts/vendor-llm-agents.sh <rev-or-tag>
```

Production pins an exact revision rather than the upstream default branch: dsh is a developer preview, and following its main branch would import every upstream refactor into every machine at once (§8.1).

## Generated artifacts this change maintains

Adding a package with a `Config`, or a durable session event, makes a few **generated** repository artifacts stale. They are derived data, not hand-written code, and the fleet regenerates them with the repository's own generators:

```sh
nix develop -c pnpm --config.verify-deps-before-run=false exec tsx scripts/gen-persistence-catalog.ts
nix develop -c pnpm --config.verify-deps-before-run=false exec tsx scripts/gen-config-catalog.ts
nix develop -c pnpm install --lockfile-only
```

The persistence catalog is not optional. `packages/core/session/src/known-event-types.ts` is the vocabulary a cold reader accepts, and a session log holding a type that vocabulary does not know is refused rather than silently reconstructed — so the fleet's durable events (`tmux/placement`, `tmux/interrupt`, `git/checkpoint`, `worktree/*`, `machine/context`, `config/generation`, `prompt/source`, `task/*`) must appear there.

## The additive boundary (R-0)

Everything the fleet adds lives in new files: `packages/infra/*`, `packages/bundle/fleet/*`, `infra/*` and `flake.nix`. No upstream dsh source file is patched; the runtime differences are expressed as a profile bundle and its patch layers, so an upstream sync stays a fast-forward.

Four repository files are maintained rather than added, and none of them changes upstream behavior:

| File | Why it has to change | How |
|---|---|---|
| `pnpm-lock.yaml` | A workspace member's importers must exist for `--frozen-lockfile` to pass | `pnpm install --lockfile-only` |
| `packages/core/session/src/known-event-types.ts`, `docs/persistence-catalog.md` | A cold reader refuses a durable event whose type its vocabulary does not know, so the fleet's own events must be registered | `tsx scripts/gen-persistence-catalog.ts` |
| `docs/config-catalog.md` | The catalog enumerates every package `Config`; fifteen new packages carry one | `tsx scripts/gen-config-catalog.ts` |
| `tsconfig.base.json` (hand-written alias region) | A bundle patch row must resolve to workspace **source** for a `tsx` launch and for `scripts/verify-cordis-config.ts`; the generated region covers only the `@deepseek-ai/dsh-*` namespace, so the fleet's own namespace is mapped beside it | fifteen `"@dsh-fleet/<name>": ["./packages/infra/<name>/src"]` entries |
| `scripts/gen-cordis-catalog.ts`, `scripts/verify-concrete-terms.ts`, `scripts/translation-pairing.manifest.json` | The vendored harness flake is a pinned upstream copy, so its prose is out of scope for the term and bilingual-document gates exactly as `vendor/` already is, and the fleet's own services name their documentation owner | one namespace note, one excluded prefix, one exemption entry per fleet service |

They are the mechanical registration every contributor performs when adding a workspace package, an event type, a `Config` schema, or a plugin namespace. The runtime differences between the fleet and upstream dsh remain expressed only as new packages and profile patch layers.

## ConfigGeneration

[`nix/fleet.nix`](nix/fleet.nix) emits `config-generation.json` into the runtime and `@dsh-fleet/config-generation` produces the same record at run time, so any execution can be explained by the flake URI, `flake.lock` hash, llm-agents revision and narHash it ran under (§11 item 12).
