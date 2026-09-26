---
description: "The Nix-only dependency rule kept in front of dsh models as a permanent prompt section and in each workspace AGENTS.md for Codex, Kimi, and Claude."
kind: "package-reference"
---

# @dsh-fleet/nix-mandate

English | [中文](README.zh.md)

## Summary

`@dsh-fleet/nix-mandate` keeps one rule in front of every agent working in a workspace: dependencies come only from `flake.nix` and `flake.lock`, commands run inside `nix develop -c`, and build outputs are discardable. It registers that rule as a dsh system-prompt section at order 700 and writes the identical text into the workspace's `AGENTS.md`, which Codex, Kimi, and Claude read. Mount it once per deployment: each session start creates or refreshes the block. The rule is declarative, not an enforcement boundary — the sandbox profile and the `nix develop -c` shell provider carry the force.

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

Mount one row in the composition that every fleet agent runs; dsh agents then carry the rule in their system prompt, and every workspace they open carries it in `AGENTS.md` for the non-dsh harnesses.

### When to choose it

Choose this row when a deployment requires every dependency to come from the flake and every command to run inside `nix develop`, and when agents of more than one harness work in the same workspaces — only the `AGENTS.md` half reaches Codex, Kimi, and Claude. Skip it when the workspace has no flake, because the rule then only tells the model that no task can pass, and skip it when a deployment already maintains its own instruction file, because two owners of one file will keep overwriting each other. The enforcement that makes the rule true rather than advisory lives in the sandbox and shell providers, not here.

### Minimal configuration

```yaml
- id: nix-mandate
  name: '@dsh-fleet/nix-mandate'
  config:
    order: 700
```

| Field | Default | Meaning |
|---|---|---|
| `order` | `700` | Prompt-section position; the range 600–800 is otherwise unoccupied |
| `workspaceRoot` | each session's own working directory | Absolute workspace root to maintain instead |
| `agentsFile` | `AGENTS.md` | Instruction file name inside the workspace root |
| `enabled` | `true` | Register the section, the `nixMandate` API, and the session listener |

The `Config` schema in [`src/index.ts`](src/index.ts) is the exhaustive list of accepted fields; a relative `workspaceRoot`, an empty `agentsFile`, a name that escapes the workspace root, or a non-finite `order` fails the load rather than the first session.

### Why the order is a number

The upstream `SECTION_ORDERS` registry in `dsh-system-prompt` allocates a name per repository section, from `TEAM_POLICY` at 600 to `PTC_ONLY` at 800. Naming a new fleet position there means editing an upstream file, which the fleet's R-0 isolation forbids, so this row takes the numeric gap instead: 700 places the rule after team policy and before PTC-only guidance, and `order` remains a config field for a deployment that wants another position.

### What the file write does

`ensureAgentsFile` owns one delimited region of the instruction file, between `<!-- BEGIN dsh-fleet nix mandate -->` and `<!-- END dsh-fleet nix mandate -->`. A file without those delimiters receives the block after one blank line; a file with them has exactly that region replaced. Nothing outside the region is ever written, and a call that would produce the current text returns `unchanged` without opening the file. Both delimiters carry the harness and the rule name so a reader who finds the region knows which row owns it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One text, two carriers. `renderAgentsBlock()` wraps the constant `NIX_MANDATE` in the file's delimiters and heading, and the prompt section registers that same constant, so the dsh prompt and the shared instruction file cannot disagree about the rule. The row is a function plugin with no default export, which is what lets the Loader keep its `name`, `inject`, and `Config`; it publishes `ctx.nixMandate` through `ctx.provide` so another row can render the rule or refresh a workspace file without re-implementing either.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, load-time validation, section registration, `nixMandate` API, session listener |
| [`src/mandate.ts`](src/mandate.ts) | The rule text, the delimiters, and the instruction-file block built from them |
| [`src/agents-file.ts`](src/agents-file.ts) | Delimited-region discovery, replacement, append, and the read-before-write check |

### Session flow

`session/created` resolves the workspace from `workspaceRoot` when configured and from `session.header.cwd` otherwise, then starts the write. The write runs after the listener returns, so a session is never vetoed by a filesystem failure; a failure is a warning that names the session and the file. The listener is fiber-owned, so disposal detaches it together with the section and the API.

### Region semantics

Delimiter discovery rejects a file with a duplicated or unbalanced pair. That is deliberate: the alternative — guessing which of two regions is the owned one — would overwrite text this row does not own, and a loud failure on a hand-edited file is recoverable while a silent overwrite is not.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [System prompt subsystem](../../../docs/subsystems/system-prompt.md) — sections, assembly, and the ordered registry this row registers into.
- [Workspace instructions](../../context/agent-instructions/README.md) — how the harness reads `AGENTS.md` and renders it into a session.
- [Fleet requirements](../../../infra-requirements.dsh.md) — §2.3 for the prompt landing and §11 item 16 for this row.
- [Architecture](../../../docs/architecture.md) — the plugin model this row follows.
- [Package conventions](../../AGENTS.md) — plugin export forms, config rules, and README contracts.

-----

<a id="model-experience"></a>
## Model Experience

### Nix rule system prompt section

#### What the model sees

Every request from an agent whose composition mounts this row carries the rule as one section, positioned after the team-policy section and before PTC-only guidance. The text is fixed for a given configuration and names the dependency source, the command wrapper, the forbidden installers, and the acceptance commands.

##### Rule section text

```markdown
Every dependency of this workspace comes from `flake.nix` and `flake.lock`, and every command runs inside `nix develop -c <command>`.

Do not run `npm install`, `pip install`, `apt install`, `cargo install`, `go install`, or `curl … | sh`, and do not call a tool the flake does not provide: a tool that happens to exist on this machine is not a dependency of this workspace.

Build outputs in the workspace are discardable. Delete them, rebuild them from the flake, and the rebuild produces the same result.

Three commands are machine-checked acceptance items for every task here, and each must exit 0: `nix flake check`, `nix build .#default`, and `nix develop -c <project test command>`. A workspace without a flake fails all three, so no task in such a workspace passes.
```

#### Token effect

The section adds its fixed text to every request of every mounted agent, in the reusable prefix rather than in retained history, and it is present from the first request of a session. Disabling the row removes those tokens.

#### KV Cache effect

Append-only and stable: the section text does not vary per request, per session, or per workspace, so it extends the reusable prefix without invalidating any cache entry. Changing `order` or `enabled` moves or removes the section and invalidates reuse from that position.

### Workspace instruction block

#### What the model sees

Agents of every harness that reads workspace instructions receive the same rule from the workspace's `AGENTS.md`, under a heading and between the row's delimiters. `dsh-agent-instructions` surfaces that file to dsh agents as its own sourced message; Codex, Kimi, and Claude read the file through their own mechanisms.

##### Instruction file block

```markdown
<!-- BEGIN dsh-fleet nix mandate -->
## Nix is the only dependency source

Every dependency of this workspace comes from `flake.nix` and `flake.lock`, and every command runs inside `nix develop -c <command>`.

Do not run `npm install`, `pip install`, `apt install`, `cargo install`, `go install`, or `curl … | sh`, and do not call a tool the flake does not provide: a tool that happens to exist on this machine is not a dependency of this workspace.

Build outputs in the workspace are discardable. Delete them, rebuild them from the flake, and the rebuild produces the same result.

Three commands are machine-checked acceptance items for every task here, and each must exit 0: `nix flake check`, `nix build .#default`, and `nix develop -c <project test command>`. A workspace without a flake fails all three, so no task in such a workspace passes.

<!-- END dsh-fleet nix mandate -->
```

#### Token effect

For a dsh agent, the block reaches the model inside the workspace-instruction message that `dsh-agent-instructions` already sends, so this row adds no message of its own; the added tokens are the block's bytes. For a non-dsh harness, the effect is that harness's own instruction loading, and the block is the only part of the rule that reaches it.

#### KV Cache effect

Append-only. The block is written before the first request of a session and does not change afterwards, so it stays inside whatever prefix the reading harness already reuses. Rewriting the region between two sessions changes the file, and the reading harness then invalidates reuse from the position where it renders that file.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current constraints of the row and the decisions behind them, not a task backlog.

- **The rule is advisory, not enforced** — this row only tells a model what the deployment requires. A caller that ignores it, or a path that never reads the prompt, is unaffected; the sandbox profile and the `nix develop -c` shell provider own the force.
- **`AGENTS.md` ownership is exclusive** — the row writes only its delimited region, but a file whose delimiters are duplicated or unbalanced aborts the write instead of guessing. Two rows maintaining the same file, or a human who deletes one delimiter, leave the file untouched and log the reason.
- **The generated catalogs do not list this row yet** — `pnpm run gen-cordis-catalog` and `pnpm run gen-persistence-catalog` produce `docs/config-catalog.md` and `packages/core/session/src/known-event-types.ts` from the package tree, and this change may not regenerate upstream files under R-0. The `Config` schema in [`src/index.ts`](src/index.ts) is therefore the exhaustive field list for now.
- **No durable session event records the write** — a `SessionEventMap` member would make the event unknown to this build's `KNOWN_SESSION_EVENT_TYPES`, and a `Session.append` caller cannot mark its own event `ignorable`; the persistence read path would then refuse every session that mounted this row. The outcome is logged instead, and the model-visible consequence is already reconstructable because the reading plugin logs the instruction message it renders.
- **No invariant companion is published** — the row owns no cross-observation relation: the section text and the file block are the same constant, and nothing else in the process can diverge from it.
- **Not registered in an aggregate tsconfig** — this row's `tsconfig.json` is a leaf, so `pnpm run typecheck` does not reach it and `tsc -b packages/infra/nix-mandate` is the check that covers it until the fleet patch adds the reference.
- **Concurrent writers in another process are not serialized** — two dsh processes maintaining the same workspace file at the same moment can both append; the content is identical, so the file converges, but both may report `created`.
- **No Loader-booted composition test** — the shipped pattern for injecting the Loader's module map needs an `as unknown` assertion that `verify-no-unknown-casts` forbids, and building the Node internal loader interface in full is not proportionate. The tests mount the real `SystemPrompt` and `SessionStore` services and drive a real `Session` instead of booting `cordis.yml`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior and limits live in the sections above and in the package code.

- **Order 700 is a gap, not an allocation.** The fleet patch keeps upstream files untouched, so the row cannot claim a `SECTION_ORDERS` name. If upstream ever publishes a fleet section position, this row should take the name and keep 700 as its default.
- **The block heading and markers are part of the file format.** A reader that strips the markers loses the region's ownership; the constants in [`src/mandate.ts`](src/mandate.ts) are the one home for both.

</details>

**Runtime invariant:** No companion is published. The section text and the `AGENTS.md` block are rendered from one constant, so the two places a model or another harness reads cannot disagree.
