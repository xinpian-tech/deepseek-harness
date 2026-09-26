---
description: "The fleet's real-time agent channel: place one tmux pane per member key, record the placement durably, frame NDJSON in and out, and complete a call on the child session's idle status."
kind: "package-reference"
---

# @dsh-fleet/tmux

English | [中文](README.zh.md)

## Summary

`@dsh-fleet/tmux` gives a process one channel to an agent in a tmux pane: place a pane under a key, write JSON-RPC frames into its stdin, and read the frames it writes back. Each placement is also durable data on the delegating session, so a crashed machine's pane map stays explainable. A call completes on its response frame, or, under `completion: 'session-idle'`, only when the child session reports idle, because the prompt response acknowledges enqueue alone. A pane that is gone fails the call naming its key: there is no mailbox and no redelivery.

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

Mount one row per machine, beside the delegation provider that drives it; every fleet pane is placed through `ctx.tmux`, and this row is where a deployment states which harness a pane runs and where its frames are written.

### When to choose it

Choose this row when another agent must run as a process you can reach, observe, and interrupt after the call that started it: a correction round has to wake the same worker instead of starting a new one (invariant R-4), and a pane is the only real-time channel the fleet admits (invariant R-6). Skip it in a composition that delegates inside its own process, the way the base `spawn` and `fork` providers do, because those need no pane, no frame log, and no placement record. The fleet mounts the row once and reaches it through [`@dsh-fleet/subagent-tmux`](../subagent-tmux/README.md).

### Minimal configuration

```yaml
- id: fleet-tmux
  name: '@dsh-fleet/tmux'
  config:
    dshHome: /var/lib/dsh-fleet/home
    machineId: !!js process.env.DSH_FLEET_MACHINE_ID
```

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | required | Absolute harness home, handed to every pane as `DSH_HOME` |
| `machineId` | required | Machine that owns every placement this process creates |
| `sessionPrefix` | `dsh-fleet` | tmux session every fleet pane lives in |
| `dshBin` | `dsh` | Harness executable a pane runs |
| `profile` | `sdk` | Profile the pane's harness loads |
| `patches` | `[]` | Absolute profile patch files handed to the pane, in order |
| `frameRoot` | `<dshHome>/fleet/frames` | Directory holding one `out.ndjson` frame log per key |
| `credentialEnv` | the eight provider keys this repository knows | Credential-shaped variables copied into a pane when this process holds them |
| `pollIntervalMs` | `40` | Interval (ms) between frame-log polls |
| `startTimeoutMs` | `15000` | Bound (ms) on pane creation, including the harness's own startup |
| `graceMs` | `2000` | Termination grace (ms) for tmux client processes |
| `tmuxBin` | `tmux` | tmux executable this row runs |

The generated [configuration catalog](../../../docs/config-catalog.md#dsh-fleettmux) is the exhaustive field list with its source declaration. The load fails on a relative `dshHome`, an empty `machineId`, a relative patch, or a bound that is not a positive integer; a placement key outside the accepted alphabet is rejected when it is placed.

### What you get

- `place(key, { cwd, mode, env?, recordTo? })` creates or reuses the key's pane and returns its placement. `resident` reuses the pane this process already placed when tmux still reports it; `fresh` replaces it. The caller's session receives the `tmux/placement` record.
- `request(key, method, params, { completion, sessionId, timeoutMs, signal })` writes one JSON-RPC request, waits for its completion signal, and returns the response's `result`.
- `send(key, frame)` writes one frame without waiting; `observe(key, listener)` and `frameLog(key)` expose the frames read back from the pane.
- `interrupt(key, signal, recordTo?)` delivers `INT`, `TERM`, or `KILL` and returns whether it reached a live pane. The parent session receives the `tmux/interrupt` record when one is given.
- `release(key)` destroys the pane and forgets the key; releasing an unplaced key succeeds. `alive(key)`, `placement(key)`, `placementsList()`, and `machine` report the pane state this process owns.

### The completion rule

A JSON-RPC response frame carries an id and no method, so a request is answered by the frame whose id matches it; an echoed request frame carries both and is never accepted as an answer. Under the default `completion: 'response'` that frame is the completion signal. Under `completion: 'session-idle'` the response only proves the prompt was enqueued, and the call continues until a `session.status` notification reports `status: 'idle'` for the caller's `sessionId`; that is the rule the fleet's worker model requires (§5.4). A `timeoutMs` that is absent or not positive waits without a bound, and an abort signal ends the wait with `tmux call <method> was aborted`.

### Failures and recovery

Every failure is a `TmuxChannelError` naming the key: a key that was never placed, a pane that disappeared while a call waited, a JSON-RPC error from the child, or a timeout. Nothing is queued for a later attempt — when a pane is gone the call fails and the caller runs its correction loop, which is what a fleet with no fallback mailbox requires (§5.3). Placement fails loud as well: a pane whose harness does not take over the foreground within `startTimeoutMs` is reported with the command tmux still shows.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One service owns the three things the rest of the fleet would otherwise re-implement: placement, framing, and the interrupt path. Placement decides a pane's name from the caller's key (`<sessionPrefix>:w-<key>`), hands tmux the harness command as the window's command rather than typing it into an interactive shell, pipes the pane's output into `<frameRoot>/<key>/out.ndjson`, and waits until tmux reports a non-shell foreground command. Framing reads that file incrementally. Nothing here stores messages: the durable `tmux/placement` and `tmux/interrupt` records are history, not a queue.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service entry: `Config`, load-time validation, placement, request polling, interrupt, release, observers |
| [`src/panes.ts`](src/panes.ts) | `runTmux` (argv passed without a shell) and `FrameLog` (incremental NDJSON reader) |
| [`src/types.ts`](src/types.ts) | Placement, frame, signal, and the two durable session events, as types only |

### Framing rules

A frame is one complete line. `FrameLog` keeps a byte offset and a partial trailing line, so a poll landing in the middle of a write delivers nothing for that frame and the whole frame on a later poll; a log that shrank was replaced, and reading resumes from its start. A line that is not a JSON-RPC object is reported as `malformed` rather than thrown, because a tty artefact must not kill the channel, and the service drops those lines from the frame stream it dispatches. The reader polls only while a call is waiting, so `observe()` listeners see the frames of a key while some `request` on that key is in progress.

### Frames in

`send-keys -l` writes the frame as literal text and a separate `send-keys Enter` submits it, so frame content is never looked up as a tmux key name. The pane's command begins with `stty -echo -icanon`: a tty echoes what is written to it, and an echoed request frame is itself valid JSON, which a later reader would mistake for an answer (§5.3).

### Interrupt delivery

`INT` writes `C-c` into the pane's tty, which delivers SIGINT to the foreground process group; `TERM` signals the pane's process group directly and falls back to the pane's top pid; `KILL` destroys the window. Each outcome is recorded on the caller's session as `tmux/interrupt` with `delivered` and, when the member could not be reached, a `reason`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fleet requirements](../../../infra-requirements.dsh.md) — §5.3 for the channel, §5.4 for the completion rule, and §11 items 1, 2, 4, and 13 for the rows built on it.
- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the delegation seam whose provider drives this channel.
- [`@dsh-fleet/subagent-tmux`](../subagent-tmux/README.md) — the provider that turns placement, frames, and the idle rule into one delegation call.
- [`@dsh-fleet/tmux-gateway`](../tmux-gateway/README.md) — the TCP bridge that makes a pane on another machine reachable.
- [Generated configuration catalog](../../../docs/config-catalog.md#dsh-fleettmux) — every accepted config field and its source declaration.
- [Generated persistence catalog](../../../docs/persistence-catalog.md) — the recorded payload of `tmux/placement` and `tmux/interrupt`.

-----

<a id="model-experience"></a>
## Model Experience

### Delegation channel

#### What the model sees

Nothing of this service's own reaches a request: it registers no tool schema and no prompt section, and `tmux/placement` and `tmux/interrupt` are log-only records. What a model sees of a delegation is the `subagent` tool result that [`@dsh-fleet/subagent-tmux`](../subagent-tmux/README.md) renders from frames this channel carried; a channel failure reaches that model only as the provider's diagnostic text.

#### Token effect

Zero direct tokens on every request. The frames themselves belong to the two sessions that exchange them: the prompt a caller writes into a pane is counted in the child's request, and the child's final message is counted in the caller's tool result.

#### KV Cache effect

Independent of live requests: placing, releasing, or interrupting a pane changes no request prefix, so no cached entry is invalidated.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current constraints of the channel and the decisions behind them, not a task backlog.

- **No mailbox and no redelivery** — a call whose pane disappeared fails with `pane for <key> disappeared during <method>`, and no frame is held for a later attempt. That absence is deliberate (§5.3): the caller observes the failure and runs its correction loop.
- **One process owns a key at a time** — placements live in this process's map, and a second process that places a key whose window name already exists creates a second window with that name and then fails at `tmux could not pipe pane <session>:<window>: can't find window: <window>`, because tmux resolves `session:window` by name and the name is no longer unique. A restarted process cannot adopt or drive the panes it placed earlier, even though their `tmux/placement` records are in its session log.
- **Completion depends on the child's status notification** — `completion: 'session-idle'` needs a frame carrying the caller's `sessionId` and `status: 'idle'`. A child runtime that does not publish that notification leaves the call waiting until `timeoutMs`, or forever when no bound is set.
- **The frame log only grows** — `pipe-pane` appends to `<frameRoot>/<key>/out.ndjson` for the pane's whole life; nothing truncates, rotates, or bounds that file, so a resident worker accumulates every frame it ever wrote.
- **Echo suppression belongs to this row's launch line** — `stty -echo -icanon` runs in the panes this service creates. A pane placed by another process, or by hand, echoes what is written into it, and an echoed request frame is itself valid JSON.
- **Readiness is inferred from the reported foreground command** — placement waits until `#{pane_current_command}` is neither empty nor one of `sh`, `bash`, `dash`, `zsh`, `fish`, `ksh`, or `tmux`. A pane whose foreground command stays one of those fails placement after `startTimeoutMs` instead of waiting longer.
- **Interrupts are durable only when a session is given** — `interrupt(key, signal, recordTo?)` appends `tmux/interrupt` only for a caller that passes its session; the reasons it records are `pane is not present`, `tmux refused the interrupt key`, and `pane process group is gone`.
- **tmux is a host dependency** — every call spawns `tmuxBin` from the deployment's PATH, and the row runs no in-process fallback. A machine without tmux fails placement and polling rather than degrading to another transport.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **The interrupt path has no spec.** Nothing in `tests/tmux.spec.ts` calls `interrupt()`; the provider's teardown reaches it only when a turn is unfinished, so a regression in `INT` or `TERM` delivery would not fail a test today.
- **`observe()` has no poller of its own.** Listeners are driven by an in-flight `request` on the same key; a background reader would need its own timer and its own offset discipline.
- **Placement is not rehydrated.** The `tmux/placement` records are enough to rebuild a pane map, and nothing replays them: every process starts with an empty map, which is why the second-process case in the limitations fails rather than reconnecting.
- **Windows are named, not indexed.** Recording the tmux window index beside the name would make `pipe-pane` and `kill-window` unambiguous across processes; the placement carries the name only.
- **Readiness is a heuristic.** `#{pane_current_command}` distinguishes a shell from a harness, but it cannot tell a harness that is still starting from one that is serving; the `initialize` handshake in the provider is what proves the latter.

</details>

**Runtime invariant:** No companion is published. The placement map, the frame-log readers, and the observers are each a single copy held by this process, and the durable `tmux/placement` record is written from the same value that populates the map, so no two observations inside the process can diverge.
