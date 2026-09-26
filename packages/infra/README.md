---
description: "The infra package group: the fleet composition that runs every agent as a tmux pane, keeps durable state in git, and takes every dependency from a Nix flake."
kind: "package-group"
---

# infra/ — the fleet composition

English | [中文](README.zh.md)

## Summary

The `infra` group carries the fleet composition: every agent above the human is a tmux pane, so tmux is the only real-time channel between agents, git is the only durable one, and a Nix flake is the only dependency source. The packages split by role — delegation and placement over tmux, per-turn archival and candidate isolation in git, machine and task identity, and the three Nix enforcement layers. Use this page to find the package that owns one item of the fleet requirement; each package README owns its own configuration, service contract, and limitations.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each row names one package, what it contributes, and the requirement item it implements. [`@dsh-fleet/bundle`](../bundle/fleet/README.md) is the profile layer that mounts them; [`fleet.manifest.json`](../../infra/fleet.manifest.json) is the machine-readable inventory that `infra/nix/fleet.nix` holds to this tree.

| Package | Role | Requirement |
|---|---|---|
| [`tmux`](tmux/README.md) | Placement, the NDJSON frame channel, and the interrupt path: one member is one pane on one machine | §11 items 2, 13 |
| [`subagent-tmux`](subagent-tmux/README.md) | The delegation provider every call resolves to: a child is a `dsh --profile sdk` process in a pane, started fresh or resumed resident | §11 item 1 |
| [`tmux-gateway`](tmux-gateway/README.md) | Reaches another machine's tmux unix socket over TCP on a kernel-assigned port | §11 item 3 |
| [`worker-template`](worker-template/README.md) | The launch contract for a worker pane: resident sdk process, tty echo suppressed, credential variables passed explicitly | §11 item 4 |
| [`git-checkpoint`](git-checkpoint/README.md) | One local commit per stopping turn, an asynchronous push queue, and one blocking final push | §11 item 6 |
| [`session-archive`](session-archive/README.md) | A per-turn copy of each session log under a per-machine ref namespace, with families rebuilt from session headers | §11 item 7 |
| [`worktree`](worktree/README.md) | One worktree and branch per candidate, with swept-out candidates kept as evidence | §11 item 8 |
| [`ledger`](ledger/README.md) | Durable outcome entries per member and the aggregates derived from them | §11 item 9 |
| [`machine-registry`](machine-registry/README.md) | One machine identity — hostid, alias, and nix system — recorded on every session | §11 item 10 |
| [`config-generation`](config-generation/README.md) | The flake fingerprint an execution ran under | §11 item 12 |
| [`task-spec`](task-spec/README.md) | Acceptance criteria as machine-decidable task data, with the Nix checks built into every generated set | §11 items 11, 17 |
| [`prompt-source`](prompt-source/README.md) | Tells a leader-issued prompt from a human one in the session log | §11 item 5 |
| [`nix-sandbox`](nix-sandbox/README.md) | The sandbox profile that exposes the store, the workspace, and a private temp root, and nothing else | §11 item 14 |
| [`nix-shell`](nix-shell/README.md) | The `ctx.shell` provider that runs every command inside the flake | §11 item 15 |
| [`nix-mandate`](nix-mandate/README.md) | The dependency rule in the system prompt and in each workspace `AGENTS.md`, for every harness | §11 item 16 |

Four invariants decide what may exist in this group. R-6 and R-7 leave exactly two channels between agents — tmux for the real time and git for the durable record — and allow only call-return semantics, so no package here delivers a message into another agent's context, continuable children and `send_message` are gone, and no fallback mailbox replaces them. R-2 makes a task's acceptance criteria machine-decidable data that only narrows as it travels, which `task-spec` carries. R-5 splits archival into one local commit per turn and an asynchronous push that retries until it succeeds, which `git-checkpoint` and `session-archive` implement. R-8 makes the flake the only dependency source, which `nix-sandbox`, `nix-shell`, and `nix-mandate` enforce in that order of strength; the prompt section states the rule and is not an enforcement boundary.

-----

<a id="related-documentation"></a>
## Related documentation

- [Fleet composition](../../docs/subsystems/fleet.md) — the subsystem page owning the two channels, the invariant each package enforces, and the removal set.
- [Fleet profile bundle](../bundle/fleet/README.md) — the two patch documents that mount these packages in a profile.
- [Fleet requirements](../../infra-requirements.dsh.md) — §11 the change list, §12 the removal list, and §13 the accepted trade-offs.
- [Package conventions](../AGENTS.md) — plugin export forms, configuration rules, and README contracts.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
