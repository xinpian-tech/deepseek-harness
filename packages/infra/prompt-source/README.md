---
description: "Prompt-source labelling for fleet compositions and auditors: bind a leader- or peer-issued prompt to its durable prompt/source record, and read that record back from stored session data."
kind: "package-reference"
---

# @dsh-fleet/prompt-source

English | [中文](README.zh.md)

## Summary

Use `dsh-prompt-source` when the session log must say whether a prompt came from a human or from a leader. The SDK JSON-RPC server labels every prompt it serves `source: { kind: 'user' }`, so once the fleet removes the message-passing source kinds a leader's instruction and a human's message look identical. It owns a request-scoped label registry plus a source-carrying prompt path, recording the resolved label as a log-only `prompt/source` session event that `kindOf` reads back from durable storage, not memory. It changes nothing a model request sees: the delivered message is the one the SDK server builds.

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

Mount the service in every composition whose prompts must be attributable — the worker pane and any process that delivers prompts into a worker session:

```yaml
- id: fleet-prompt-source
  name: '@dsh-fleet/prompt-source'
  config:
    defaultSource: user
    extraKinds: [curator]
    markTtlMs: 300000
```

### When to use it

Mount it wherever a prompt may come from more than one kind of caller. A composition in which every prompt is typed by a human can omit it, but then nothing distinguishes a later leader-issued prompt from a human one, which is the audit gap this package exists to close.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `extraKinds` | `[]` | Labels accepted on top of `user`, `leader`, and `peer`; each must match `^[a-z][a-z0-9-]{0,31}$` and may not repeat a built-in |
| `defaultSource` | `user` | Label a delivery under no pending mark resolves to; must be an accepted label |
| `markTtlMs` | `300000` | Bound (ms) an unclaimed mark stays valid |
| `maxPendingMarks` | `1024` | Most unclaimed marks held at once; exceeding it throws rather than dropping a mark |
| `readWindow` | `500` | Events requested per durable read while answering `kindOf` |

Every field fails the load when it is unusable: a malformed or duplicated extra label, a `defaultSource` outside the accepted set, or a nonpositive bound throws during plugin construction.

### What you get

- `markNext(requestId, source, sessionId?)` — reserve a label for the prompt delivered under that request id. A session-bound mark is visible only to a caller naming that session; a second call for the same request id replaces the first, which is what a caller retrying its own prompt needs.
- `take(requestId, sessionId?)` — consume the reservation once. After the first `take` the mark is gone, and an unclaimed mark expires after `markTtlMs`, so a label cannot reach a prompt it was not placed for.
- `prompt(target, { requestId, contentBlocks })` — the source-carrying path. It consumes the pending mark (or the default), builds the same user message the SDK server builds, hands it to `target.followup`, and appends `prompt/source` to `target.session`. A live `Agent` satisfies `PromptTarget` structurally, so the usual argument is `ctx.agents.get(id)`.
- `kindOf(sessionId, messageId)` — the audit answer, read from stored session events through `ctx.sessionPersistence` in `readWindow`-sized slices. A session this process never stored answers `undefined`; no in-memory state participates.
- A log-only `prompt/source` event carrying `{ sessionId, messageId, requestId, source }` as plain JSON, so the record replays with the rest of the log.

### Failures and recovery

`markNext` throws `TypeError` for a label outside the accepted set and `PromptSourceError` when `maxPendingMarks` is reached — a full registry is reported instead of silently discarding a reservation that a later audit would miss. `kindOf` throws `PromptSourceError` when no persistence service is mounted, and reports the store's own refusal when the stored log cannot be read. Label registration itself is an effect of the mounted fiber: disposing the plugin removes the service, its label set, and every pending mark.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **The binding is the request id, not the session.** A mark is keyed by the caller's correlation id and consumed once, so two prompts on one session cannot inherit each other's label; an optional session binding narrows it further.
- **The log is the answer.** `kindOf` never consults the registry: after a restart the registry is empty, and a guess derived from it would relabel a leader's instruction as a human message.
- **The message is untouched.** The delivered message is built exactly as `@deepseek-ai/dsh-sdk-jsonrpc-server` builds it — content plus `{ kind: 'user' }` — so no consumer of the LLM seam sees a source kind it did not declare, and no model request changes.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, label validation, the registry, the source-carrying prompt path, the durable read |
| [`src/types.ts`](src/types.ts) | `PromptSourceMark`, `PromptSourceRecord`, `PromptTarget`, and the `prompt/source` event declaration |

### The extension point this package uses

The SDK server plugin exposes none of what a source field would need: it creates its own `JsonRpcLineTransport` from its config, and `HarnessSdkJsonRpcServer.handleRequest` dispatches a closed method set (`initialize`, `session/prompt`, `shutdown`) before `prompt()` builds the user message with a hardcoded source. `JsonRpcLineTransport.onRequest` replaces whichever handler is installed, so a second plugin cannot add a method either. This package therefore uses the two extension points that do exist from outside: the **merge-extensible `SessionEventMap`** (the durable record) and the **`agents` seam plus `Append`-based session writes** (the delivery path). The README states the resulting gap precisely below.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [infra-requirements.dsh.md](../../../infra-requirements.dsh.md) — §11 item 5 (this package), the closing paragraph of §12 (the audit gap it closes), and §5.4 (why the worker is resident).
- [`packages/sdk/server/src/server.ts`](../../sdk/server/src/server.ts) — the hardcoded `source: { kind: 'user' }` this package works around.
- [`packages/sdk/protocol/src/transport.ts`](../../sdk/protocol/src/transport.ts) — the request/notification dispatch a plugin cannot extend.
- [`@dsh-fleet/tmux`](../tmux/src/index.ts) — the channel a leader uses today to reach a worker's `session/prompt`.

-----

<a id="model-experience"></a>
## Model Experience

### Prompt attribution

#### What the model sees

Nothing. The plugin registers no tools and injects no prompt text. The message it delivers is byte-identical to the one the SDK server builds for the same content, and `prompt/source` is a log-only event, so no request carries the label.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: neither marking a prompt nor recording its label changes any request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what this package cannot do. They are current constraints, not a task backlog.

- **The SDK server's own `session/prompt` path stays unlabelled.** The server hardcodes `source: { kind: 'user' }` in `HarnessSdkJsonRpcServer.prompt`, and it exposes neither its transport instance nor its method table nor a service a plugin could contribute to. A leader that sends `session/prompt` directly therefore still produces a message indistinguishable from a human one, with no `prompt/source` record. Only a delivery that goes through `ctx.promptSource.prompt` — or another path that appends the record itself — is attributable. The upstream change this item asks for (a `source` field on `session/prompt`, i.e. editing the SDK server) is out of scope for a new plugin under R-0.
- **An unrecognized `source` member on `session/prompt` params is silently ignored.** The server reads only `sessionId` and `contentBlocks`, so a deployment that adds its own `source` field today receives no record and no diagnostic; nothing in this package can observe the params to warn about it.
- **The delivered message still declares `{ kind: 'user' }`.** The label lives in the `prompt/source` record, joined to the prompt by `messageId`. A consumer that switches on `MessageSource.kind` alone sees no difference, which is deliberate: no consumer of the LLM seam should meet a source kind it did not declare.
- **The record's correlation is by request id and message id only.** A caller that delivers the same content twice under different request ids produces two records, and nothing checks that a `requestId` was unique across processes.
- **Marks are process-local and never durable.** A mark lost to a restart costs the next prompt its label — it falls back to `defaultSource` — and `kindOf` cannot recover it, because no record was written.
- **A cold read needs the event type in the generated persistence vocabulary.** `kindOf` reads stored events through `ctx.sessionPersistence`, whose reader refuses an event type this build does not know unless its writer marked it ignorable. `prompt/source` is an in-repo declared event, so it must appear in `packages/core/session/src/known-event-types.ts` (regenerate with `pnpm run gen-persistence-catalog`) before a stored log containing it is admitted; until that regeneration lands, a cold read fails closed with the store's refusal instead of mislabelling a prompt. The same regeneration covers the other fleet events (`tmux/placement`, `tmux/interrupt`, `machine/context`).
- **The cold-read spec runs only where the persistence backend can store a session.** The JSONL backend loads a prebuilt native system addon; a source-only checkout cannot create the fixture, so that one case is skipped there and the live-log case still runs.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Upstream fix** — the durable record becomes redundant once `session/prompt` accepts a `source` field; the right sequence is to add that field upstream, have this package's prompt path send it, and keep `kindOf` reading the same record.
- **Label vocabulary** — `extraKinds` exists so a fleet can distinguish issuers this package does not know; the alternative, one label per plugin, would put producer identity in the durable payload and force every reader to know every producer.
- **Delivery ownership** — this package deliberately does not create sessions or agents. If a future consumer needs the plugin itself to resolve a live agent, that lookup belongs in that consumer, not in the record path.

</details>

**Runtime invariant:** No companion is published. The service owns one label set, one in-memory registry, and one append path; there is no relationship between independent observations that could diverge, so an invariant companion would only restate service presence.
