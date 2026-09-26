---
description: "The fleet profile bundle: the tmux-only composition layer and the message-passing removal layer that a fleet profile mounts on top of dsh-base."
kind: "package-bundle"
---

# @dsh-fleet/bundle

English | [中文](README.zh.md)

## Summary

A fleet profile gains one thing from this bundle: a composition in which every delegated agent is a tmux pane and no row delivers a message into another agent's context. Its substance is two patch documents — `no-messaging.cordis.patch.yml` switches the message-passing rows off, and `cordis.patch.yml` inserts the fleet rows and replaces the shell executor. The deployment ships both through the fleet runtime tree rather than a registry. Read the layer semantics below before editing either document; the [fleet subsystem page](../../../docs/subsystems/fleet.md) owns the channels and invariants they implement.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Where the layers come from

The package declares both documents in `dsh.bundle.patch`, in this order: the removal layer first, then the composition layer. A bundle layer concatenates its patch lists in that order, so the removals are in force before the fleet rows are inserted; a later bundle layer, the profile's own `cordis.patch.yml`, or a `dsh --patch <path>` overlay still outranks both per row id.

[`infra/nix/fleet.nix`](../../../infra/nix/fleet.nix) is how a machine receives them: it installs every `.yml` beside this README into `$out/share/dsh-fleet/profiles/` and composes a fleet launch as base plus fleet. The package is private and carries no published version, so `dsh plugin --profile <name> add @dsh-fleet/bundle` is not an install path for it. Dropping the bundle from a profile drops the fleet rows with it and returns the removed rows to the composition.

### What you get

The composition layer inserts thirteen rows: `fleet-config-generation`, `fleet-machine-registry`, `fleet-task-spec`, `fleet-tmux`, `fleet-subagent-tmux`, `fleet-tmux-gateway`, `fleet-worker-template`, `fleet-session-archive`, `fleet-git-checkpoint`, `fleet-worktree`, `fleet-ledger`, `fleet-prompt-source`, and `fleet-nix-mandate`. Each row's package owns what that row contributes; the [infra group map](../../infra/README.md) maps them to the requirement items.

Two further entries change rows the base composition already mounts instead of adding any: `sandbox-policy` is parameterized with `profile: nix-only`, and `bash-sandbox` is disabled so that the inserted `fleet-nix-shell` row is the only `ctx.shell` provider — a configuration may hold one shell executor, and that executor must be the one that runs commands inside the flake.

The removal layer disables nine rows, repoints four delegation rows at the tmux provider, and adds nothing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### The removal layer

Every row below is switched off rather than deleted upstream, which is what R-0 isolation means in practice: the fleet never edits a base composition.

| Row | Disabled because |
|---|---|
| `subagent-spawn-in-process`, `subagent-fork-in-process` | Same-process children are not tmux panes. |
| `subagent-codex`, `subagent-claude-code`, `subagent-acp`, `subagent-dsh-sdk` | Each drives a child over a stdio pipe; a pipe is not a tmux pane. |
| `tool-subagent-control` | `send_message` and `interrupt_agent` publish into a child's inbox without that child asking. |
| `tool-subagent-list-agents` | It lists continuable children, which the removals leave empty. |
| `agent-team` | Roster, task board, and mailbox are dsh-internal messaging. |

The layer lists provider rows a given base-backed profile may not mount. A patch entry that matches no row prints a warning and is skipped, so the removals stay listed and hold for every base-backed fleet profile.

### The repointed rows

`tool-subagent`, `tool-subagent-fork`, `workflow-ptc`, and `tool-ralph` stay mounted and receive the tmux provider in their configuration. The delegation tools keep call-return semantics — a caller starts a child and receives its result — but the only provider they can resolve is the one whose children are panes. `tool-subagent` and `tool-subagent-fork` also carry `backgroundMode: one-shot`, because a continuable child continues through an inbox delivery while a fleet worker continues by being called again on its resident pane.

### The composition layer

The insert list is grouped by what each row belongs to: identity and the execution fingerprint first, then the task contract, then the real-time channel, the durable channel, the audit gap, and the Nix enforcement rows. Load order inside the document is the order the rows appear.

The two substitutions are the only edits this bundle makes to a row it does not own, and each has one reason. The sandbox row parameterizes the profile the base's confinement rows enforce; the bash executor row is disabled because the fleet replaces that single `ctx.shell` provider, not because sandboxed execution is unwanted.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The composition layer: inserted rows, the sandbox profile value, and the shell executor substitution, with per-row rationale inline |
| [`no-messaging.cordis.patch.yml`](no-messaging.cordis.patch.yml) | The removal layer: disabled rows and the delegation rows repointed at tmux |
| [`src/index.ts`](src/index.ts) | Package entry; carries no runtime API |
| [`package.json`](package.json) | Declares `dsh.bundle.patch`, whose order fixes the layer order |

No invariant companion is published: the package is a static patch-list carrier, and each inserted row's package owns that row's invariants.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fleet composition](../../../docs/subsystems/fleet.md) — the two channels, the invariant each row enforces, and what the composition deliberately omits.
- [Infra group map](../../infra/README.md) — the packages these rows mount.
- [Bundle package map](../README.md) — the other installable profile layers.
- [app-boot profile section](../../boot/app-boot/README.md) — how a profile composes bundles, its own patch, and launcher overlays.
- [Fleet requirements](../../../infra-requirements.dsh.md) — §11 the change list and §12 the removal list this bundle implements.

-----

<a id="model-experience"></a>
## Model Experience

### Fleet tool set

#### What the model sees

A model in a fleet profile sees the delegation tools `subagent`, `subagent_fork`, `workflow`, and `ralph` resolving to the tmux provider, and sees no `send_message`, `interrupt_agent`, or `list_agents` tool at all. The `nix-mandate` rule reaches it as a system-prompt section at order 700, and its shell commands run through the `nix develop -c` executor. Each row's package owns the text, schema, and result it contributes; this bundle only decides which rows exist.

#### Token effect

The bundle contributes no prompt text and no tool schema of its own. The tokens a fleet profile sends differ from a base-only profile exactly by the rows: the removed tools release their schemas and usage text, and the inserted rows add theirs, with `nix-mandate` adding one fixed section to every request.

#### KV Cache effect

Append-only and stable within one composition: the row set is fixed at load, so the reusable prefix does not change between requests or sessions. Changing the bundle list, or adding a patch that mounts or unmounts one of these rows, changes the tool block and invalidates cache reuse from that position.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current constraints of the two documents, not a task backlog.

- **Both layers apply together** — `dsh.bundle.patch` names the removal layer and the composition layer as one ordered list, so a profile cannot take the fleet rows while keeping message passing. A patch that re-enables a removed row must set `disabled: false` in a later layer and accept the semantics R-7 forbids.
- **A removal that matches no row warns and is skipped** — a base-backed profile that does not mount one of the nine rows prints a launcher warning per unmatched entry. The entry stays listed so the same removals hold for every base-backed fleet profile.
- **A continuable child cannot be resumed** — `backgroundMode: one-shot` on the delegation tools is deliberate. Reworking a worker means calling it again on its resident pane, and the call fails if that pane is gone.
- **The removal layer carries nine rows, not the settlement notification** — automatic settlement delivery has no row of its own in a base composition, so no patch entry can switch it off; the delegation tools run one-shot, and no continuable child is announced for it to settle.
- **There is no install path through a registry** — the package is private and unpublishable, so a profile receives it from the fleet runtime tree or from a checkout, never through `dsh plugin add`.
- **The nix-only sandbox backend is not one of the inserted rows** — `@dsh-fleet/nix-sandbox` registers `ctx.sandbox` by replacing the base `sandbox` row, which this bundle does not do, so a profile that only adds this layer keeps `dsh-sandbox-local` as its confinement backend. The `sandbox-policy` row this layer does change declares `mode` and `workspaceRoot` only, so setting `profile: nix-only` there also replaces the base's `DSH_PERMISSION_MODE` default with the schema default `read-only`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
