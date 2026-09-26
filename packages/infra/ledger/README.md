---
description: "The fleet's durable performance ledger: outcome entries the main agent records, aggregates derived from them, and peer/red-team scoring inputs kept structurally separate from any score."
kind: "package-reference"
---

# @dsh-fleet/ledger

English | [中文](README.zh.md)

## Summary

`@dsh-fleet/ledger` registers `ctx.ledger`, the durable record of how each member performed. It stores two kinds of data, never mixed: outcome entries, the main agent's own decisions about a member's contribution, and scoring inputs, raw peer signals and the red team's defect counts. Counters and rankings are derived from the entries on every read, so an aggregate never disagrees with the outcomes it summarizes. Scoring authority stays with the main agent: no method accepts a score, a weight, or a peer vote, so no peer can assign one. It is durable at a configured file or on the storage seam.

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

Mount this package where dispatch decisions are made: it is the record a later round reads to decide how many candidates N to run and which candidate to pick (§6.4). Choose the medium first — either a file path, which needs no other package, or the storage seam, which needs a storage hub and a backend mounted before this row.

```yaml
- name: '@dsh-fleet/ledger'
  config:
    ledgerFile: /srv/team/state/ledger.json
    maxEntries: 200
```

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
  config: { root: /srv/team/state }
- name: '@dsh-fleet/ledger'
  config:
    storageKey: fleet/ledger
    storageBackend: json
```

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `storageKey` | `fleet/ledger` | Record key holding the ledger document in the storage seam |
| `ledgerFile` | unset | Absolute ledger file path; when set, the ledger is durable there and the storage seam is not used |
| `storageBackend` | `json` | Registered backend serving the ledger unit when no file is configured |
| `maxEntries` | `200` | Bound on retained outcome entries and scoring inputs per member; the newest are kept |

### What you get

| Call | Result |
|---|---|
| `record(entry)` | Appends one outcome the main agent decided: member, task, role, outcome, rounds, optional cost |
| `recordInput(input)` | Appends raw peer signals and red-team defect counts about one member |
| `recordOf(memberId)` | The member's aggregate, derived from its retained entries, or `undefined` when nothing is recorded |
| `ranking()` | Every member's aggregate in ranking order |
| `inputs(memberId)` | The scoring inputs recorded for one member, exactly as recorded |

The aggregate is `{ memberId, entries, accepted, reworked, failed, meanRounds }`. `ranking()` orders aggregates deterministically: more `accepted` first, then lower `meanRounds`, then fewer `failed`, then `memberId` by code unit, so a dispatch decision never depends on scan order.

### Scoring authority

The main agent alone decides what a member's record means. A peer signal and a red-team defect count are evidence: recording them changes no counter and no rank. There is no write path for a score, a weight, or a vote — not as a policy, but because the service and its data model have no such field — so the convergence bias of in-group peer scoring cannot enter the ledger.

### Failure and recovery

- `TypeError` refuses an unknown role or outcome, a negative or fractional round count, an empty member id or task id, an unusable cost or timestamp, and a malformed peer signal or defect count; the message names the field.
- `LedgerError` with code `storage-unavailable` reports that neither `ledgerFile` nor a storage service is available, and `malformed-ledger` or `unsupported-version` reports a durable document this build cannot read.
- Load fails loud on a relative `ledgerFile`, an empty `storageKey`, a non-positive `maxEntries`, or a stored document that does not decode.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **Entries are the one authoritative source.** The aggregate is computed from the retained entries at read time; nothing stores `accepted`, `meanRounds`, or a rank beside them, so the two cannot drift.
- **Inputs are evidence, not verdicts.** Peer signals and defect counts live next to the entries and are read back unchanged. They have no field a score could occupy.
- **One document, two media.** The file medium and the storage seam hold the same JSON document, so choosing `ledgerFile` changes where the ledger is durable and nothing else.
- **Commit before publishing.** The in-memory document is replaced only after the medium reports the write durable, so an observed entry is always a stored one.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, `ctx.ledger`, the record/read API |
| [`src/types.ts`](src/types.ts) | `LedgerEntry`, `MemberRecord`, `ScoringInput`, and the durable document |
| [`src/validate.ts`](src/validate.ts) | One field-check set for both directions: writes raise `TypeError`, reads raise `LedgerError` |
| [`src/derive.ts`](src/derive.ts) | Aggregation from entries and the documented ranking comparison |
| [`src/store.ts`](src/store.ts) | The file and storage-seam media, plus opening the KV unit |
| [`src/errors.ts`](src/errors.ts) | `LedgerError` and its codes |

### Durable document

```json
{
  "version": 1,
  "members": {
    "worker-a": {
      "entries": [{ "memberId": "worker-a", "taskId": "task-1", "role": "worker", "outcome": "accepted", "rounds": 2, "recordedAt": 1700000000000 }],
      "inputs": [{ "memberId": "worker-a", "taskId": "task-1", "peerSignals": [], "defects": [{ "severity": "major", "count": 2 }], "recordedAt": 1700000000000 }]
    }
  }
}
```

### Load order

A deployment without `ledgerFile` must mount the storage hub and its backend before this package, because the unit is opened once at load and a missing medium is a load failure rather than a silent in-memory ledger.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fleet requirements](../../../infra-requirements.dsh.md) — §6.4 (performance ledger), §11 item 9, §6.2 (what the main agent reports and decides).
- [Worktree sibling](../worktree/README.md) — the candidate isolation whose selection this ledger's records inform.
- [Storage hub](../../storage/storage/README.md) — the backend registry and the KV unit contract the ledger opens.
- [Storage JSON backend](../../storage/storage-json/README.md) — the shipped backend used by the example above.

-----

<a id="model-experience"></a>
## Model Experience

### Ledger bookkeeping

#### What the model sees

Nothing by itself: the service registers no tool, injects no prompt section, and writes no session event. A caller that wants the ledger to reach a model reads `ranking()`, `recordOf()`, or `inputs()` and decides what to report; that caller owns the model-visible text.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the ledger never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this package is a poor fit. They are current package constraints, not a task backlog.

- **Retention drops the oldest records** — once a member exceeds `maxEntries`, the oldest entries no longer contribute to its aggregate; a deployment that must keep full history raises the bound or archives the document.
- **The document is owned by one service instance** — a second instance pointed at the same file reads at load and then writes whole documents, so concurrent writers would overwrite each other's members. One ledger owner per medium.
- **No cross-member comparison beyond the counters** — the ranking compares accepted counts, mean rounds, and failures. Cost is recorded but not ranked, because what a cost is worth is the main agent's judgement, not the ledger's.
- **Team State Repo retention is the deployment's job** — the ledger makes the record durable; committing that file into the Team State Repo, and archiving it, belongs to the git checkpoint and archiver packages (§7).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above and in the package code.

- **Why a whole-document medium** — a per-member record layout would let one write touch less of the medium, but the ledger's write rate is one entry per task outcome, and a whole document keeps the file and storage media identical.
- **What a score would need** — the enforcement is structural, so adding peer scoring later means adding a field to the data model and a method to the service, which is a visible contract change rather than a configuration flip. That is the intended cost.
- **Next dispatch inputs** — how many candidates N to run and which candidate to pick are decisions the main agent makes from `ranking()` plus the current task's evidence; the ledger deliberately computes neither.

</details>

**Runtime invariant:** No companion is published. The ledger's aggregates are derived from its entries on every read, and the entries are the only stored document, so a second reader of the same file cannot observe a different ranking than the writer did.
