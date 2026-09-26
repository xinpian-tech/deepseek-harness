---
description: "The fleet's only delegation provider: run each child as a dsh process inside a tmux pane, fresh or resident per task key, and complete the run on the child session's idle status."
kind: "package-reference"
---

# @dsh-fleet/subagent-tmux

English | [中文](README.zh.md)

## Summary

`@dsh-fleet/subagent-tmux` makes every delegated child a complete `dsh --profile sdk` process in a tmux pane, and it is the fleet's only delegation provider. A `fresh` start gets a new pane and child session, reclaimed when its run settles; a `resident` start reuses both for one task key, so a correction round continues the same conversation instead of restarting it. The run completes when the child session reports idle, never on the prompt response, which only acknowledges enqueue. The provider claims the child route capability alone.

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

Mount this row beside [`@dsh-fleet/tmux`](../tmux/README.md) and point the delegation tools at its provider name; from then on every `agent()` call runs its child as a separate harness process in its own pane.

### When to choose it

This is the fleet's only delegation provider: the in-process `spawn` and `fork` providers and the four stdio providers are all disabled in the fleet profile (§12), because a child that is not a pane is not reachable over the channel the fleet admits (invariant R-6). Choose it wherever work must be delegated to an agent that can outlive one call, be observed while it works, and be interrupted; choose `resident` when the caller will come back with corrections to the same agent, which is what keeps a correction loop convergent (invariant R-4). A composition that delegates within its own process should keep the base providers instead, because a pane costs a process, a frame log, and a launch line.

### Minimal configuration

```yaml
- id: fleet-subagent-tmux
  name: '@dsh-fleet/subagent-tmux'
  config:
    providerName: tmux
    sessionMode: resident
```

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `tmux` | Registry name on `ctx.subagents`, and the name every delegation tool resolves |
| `sessionMode` | `fresh` | Session semantics for a start: `fresh` starts a new child, `resident` continues the keyed one |
| `paneKeyPrefix` | `worker` | Prefix of the pane key this provider derives; must be a tmux-safe name |
| `cwd` | the delegating session's workspace | Working directory of the pane and of the child session inside it |
| `provider` | `deepseek-official` | Route the child runtime initializes with, overridable per start |
| `model` | `deepseek-v4-flash` | Model the child runtime initializes with, overridable per start |
| `reasoningEffort` | unset | Adapter-owned reasoning effort for the child route |
| `maxTokens` | unset | Output-token cap for the child runtime |
| `env` | `{}` | Extra environment entries handed to the pane, layered over the channel's allowlist |
| `startTimeoutMs` | `120000` | Bound (ms) on pane startup and the `initialize` handshake |
| `turnTimeoutMs` | `0` | Bound (ms) on one child turn; `0` waits without a bound |
| `disposeGraceMs` | `5000` | Validated at load; no disposal path reads it today |

The generated [configuration catalog](../../../docs/config-catalog.md#dsh-fleetsubagent-tmux) is the exhaustive field list with its source declaration. The load fails on a non-positive `startTimeoutMs` or `disposeGraceMs`, a negative `turnTimeoutMs`, an empty or tmux-unsafe `paneKeyPrefix`, and the first start fails on a relative or unenterable `cwd`.

A delegation tool that names this provider must leave the recursion budget to it: the provider claims no `depthLimit`, so a `tool-subagent` row whose depth resolves to a number refuses to mount with `tool-subagent: provider "tmux" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`.

### Fresh and resident

A `fresh` start places its own pane and creates a child session for that run alone; the pane is released when the run is disposed, so nothing of the child survives the call. A `resident` start derives one pane key and one child session id from the delegating session id and the task key (`request.label`, or the parent session id when the label is absent), so a second start with the same pair writes its prompt into the same conversation and the worker keeps the context of its earlier rounds. A resident pane survives disposal while it is idle, which is what makes R-4 possible; a resident pane whose turn is still unfinished when the run is disposed is interrupted with `INT` and the outcome is recorded on the delegating session.

### Results and failures

The run's output is the child's last non-empty assistant message, or the text it streamed when no such message was recorded. Its stop reason comes from the child's own `turn/end`: `completed`, `max-tokens`, `aborted`, `blocked` as `refusal`, `error`, and every other variant as `error`. A start that fails before the run is published releases the pane and throws, so a failed first attempt leaves no half-placed channel behind. A failure after publication resolves the run with `stopReason: 'error'` and a diagnostic — `the tmux child did not finish its turn: <channel message>`, or `the tmux child ended its turn without completing the work` when the child reported a turn it did not complete — which the delegation tool renders to the caller.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The provider is a thin translation between two seams: `ctx.tmux` owns panes, frames, and placement records, while `ctx.subagents` owns the start request, the capability check, and the published run. Everything the provider adds is the mapping between them — a pane key derived from the delegation identity, a child session id that is stable for a resident key, the `initialize` handshake that gives the child its route, and a fold over the child's `session.event` notifications. The run handle, the cancellation wiring, and the result flattening come from the subagent seam's own helpers, so this package never invents a second lifecycle.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`, load-time validation, provider registration, start, initialize handshake, child-session keying, teardown |

### One start, frame by frame

The provider places the pane, subscribes to the key's frames, and sends `initialize` with the child's cwd, provider, model, and optional effort and token cap; the response proves the child runtime is serving. It then sends `session/prompt` with the caller's content blocks and waits for that child session's idle status, folding every `session.event` notification the channel delivers in the meantime. The last `turn/end` reason it observed becomes the run's stop reason. Disposal unsubscribes, and then either releases a fresh pane or leaves an idle resident one in place.

### Route handling

`agentOptions` is the one capability this provider claims: a freshly placed pane can be initialized with a route, so `provider`, `model`, `reasoningEffort`, and `maxTokens` are honored per start over the configured defaults. A reused resident pane has already initialized, so the second start may not change the route: a mismatch fails the start with `subagent-tmux: resident pane <key> already runs <provider>/<model>; this start asked for <provider>/<model>`, because switching models mid-conversation would report a route the child is not running.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fleet requirements](../../../infra-requirements.dsh.md) — §3 for the provider's place in the topology, §4 for invariant R-4, §5.3 for the channel, and §5.4 for the completion rule.
- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the provider contract, capability flags, and run handle this row implements.
- [`@dsh-fleet/tmux`](../tmux/README.md) — the channel that owns placement, framing, and the interrupt path.
- [Generated configuration catalog](../../../docs/config-catalog.md#dsh-fleetsubagent-tmux) — every accepted config field and its source declaration.
- [Architecture](../../../docs/architecture.md) — the plugin model this row follows.

-----

<a id="model-experience"></a>
## Model Experience

### Delegated child runs

#### What the model sees

The delegating model sees one `subagent` tool result: the child's final assistant output, or the seam's failure line with `Diagnostic: <text>` and any partial output preserved before the run ended. The tool description follows this provider's `inheritsParentContext: false`, so it tells the model the child "does not share this conversation's context, so include everything it needs". The child model sees only the content blocks the caller passed plus its own composition, because a pane is a separate process and no parent history is seeded. Provider-authored text a model can read is `the tmux child did not finish its turn: <channel message>` and `the tmux child ended its turn without completing the work`.

#### Token effect

Every token of a delegation is charged to the two sessions that own it: the prompt blocks become the child's user message, and the child's final assistant message becomes the caller's tool result. The provider itself adds no prompt section, no tool schema, and no message of its own.

#### KV Cache effect

Append-only within a resident conversation: each round appends its prompt to the same child session, so the child's provider reuses the prefix it already cached, while a `fresh` start begins a new prefix. The delegating session's own prefix is unchanged by delegation except for the tool result it receives.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current constraints of the provider and the decisions behind them, not a task backlog.

- **A pane is a separate process with its own composition** — the provider cannot seed parent history, filter the child's tools, set a child persona, or enforce a depth budget inside the child. It claims `agentOptions` alone, and the seam rejects any other requested capability before the start with `subagent provider "tmux" does not support the "<capability>" capability`.
- **A resident pane cannot change its route** — the handshake runs once per pane, so a resident start asking for a different provider or model fails rather than switching the conversation's model mid-stream.
- **Residency is keyed, not chosen per call** — pane key and child session id derive from the delegating session id and `request.label ?? parent session id`. Two starts that share both share one child and one conversation, and starts that differ only in prompt still resume the same child; a distinct task needs a distinct label.
- **Completion depends on the child publishing idle** — `session/prompt` returns an enqueue receipt, and the run waits for that child session's `session.status` idle frame. With `turnTimeoutMs: 0`, the default, a child that stops publishing leaves the run waiting without a bound.
- **A disappeared pane fails the call with no redelivery** — the channel's message becomes the run's diagnostic (`the tmux child did not finish its turn: pane for <key> disappeared during session/prompt`), and the caller's correction loop owns the retry, because the fleet has no fallback mailbox (§5.3).
- **A completed run can carry empty output** — the fold reports the child's last non-empty assistant message or its streamed text, so a child that only called tools, or wrote nothing, completes with no output blocks and no diagnostic.
- **`disposeGraceMs` has no reader** — the option is accepted and validated at load, and teardown either releases a `fresh` pane or interrupts a `resident` one immediately, so the configured grace changes nothing today.
- **Residency holds only inside one harness process** — a correction round that runs after the harness restarted cannot reattach to the live pane, because the channel lets one process own a key at a time; the deterministic child session id is therefore only useful while that process lives.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **The route map is never pruned.** Every `initialize` adds a key entry, and nothing removes one when a `fresh` pane is released; the growth is bounded by the distinct keys a process places in its lifetime.
- **Several paths have no spec.** The specs cover a fresh run, a silent child, and resident reuse; the route mismatch, the abort path, the failed-initialize release, and the seam's capability rejection are unverified by tests.
- **The child session id is minted here, not by the child.** A resident id is the first 32 hex digits of a SHA-256 over the delegating session id and the task key; the pane's own session id stays private to the child process, so the two id spaces never meet.
- **The prompt carries no source marker.** The removed agent-message source kind (§11 item 5) means a child cannot tell a leader's instruction from a human's from the frame alone; `@dsh-fleet/prompt-source` is the row that owns that distinction.

</details>

**Runtime invariant:** No companion is published. The provider owns no durable relation of its own: the pane map and the frame logs belong to [`@dsh-fleet/tmux`](../tmux/README.md), the child conversation belongs to the child process, and the output fold and the observed turn ends live only for the run that created them.
