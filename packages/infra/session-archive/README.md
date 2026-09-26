---
description: "The per-turn session archiver (ctx.sessionArchive) for fleet compositions and maintainers copying durable session logs into per-machine git refs without touching the persistence provider."
kind: "package-reference"
---

# @dsh-fleet/session-archive

English | [中文](README.zh.md)

## Summary

Use `dsh-session-archive` to keep every session's durable log in git: on each stopping turn it copies the session's JSONL into the archive tree, commits it with git plumbing, and publishes the commit under `refs/dsh/machines/<machine-id>/sessions/<session-id>`. Each machine owns its own ref namespace, so no push is serialized across the fleet, and `family(sessionId)` answers the parent/child tree from archived headers rather than from the ref layout (§7.2).

It is a **bypass archiver, not a `SessionPersistence` backend**: it reads the log the JSONL provider already persisted and never writes it, so archival stays off the model's hot path (§7.3).

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

Mount the service once per machine, with the team state repository and this machine's id:

```yaml
- id: fleet-session-archive
  name: '@dsh-fleet/session-archive'
  config:
    repositoryRoot: /srv/fleet/team-state
    machineId: !!js process.env.DSH_FLEET_MACHINE_ID
    archiveRoot: /srv/fleet/team-state/sessions
```

### When to choose it

Mount it on every machine that runs sessions. A composition without it has durable sessions only on the machine that wrote them: the team state repository would carry tasks and results but no session history, and a machine that dies would take its sessions' explainability with it.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `repositoryRoot` | required | Absolute repository archives are committed into |
| `machineId` | required | MachineId this process archives under; the ref namespace shard and the archive tree shard |
| `refPrefix` | `refs/dsh/machines` | Ref namespace archives are published under |
| `archiveRoot` | required | Absolute archive tree; it must be inside `repositoryRoot` |
| `enabled` | `true` | Whether `agent/turn-stopping` archives a session |

`repositoryRoot` must exist and be a git working tree, `archiveRoot` must be a directory inside it (the committed path is derived from it), and `machineId` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` because it becomes both a directory name and a git ref path segment. Every one of those is a load failure, not a first-turn failure.

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc.

### What you get

- A per-turn archive: one `<archiveRoot>/<machineId>/<session-id>.jsonl` copy of the session's durable log, committed, and published under `refs/dsh/machines/<machineId>/sessions/<session-id>`. The archived copy keeps the same JSONL shape the provider writes — a header line, then one line per durable event — so an archived log reads like a live one.
- `archiveSession(session): Promise<{ ref, commit }>` — archive one session now and return where it landed.
- `refs(machineId): Promise<readonly string[]>` — read-only listing of one machine's shard.
- `family(sessionId): Promise<SessionFamily | undefined>` — the parent/child tree, with the root, the queried node, and its archived ancestors.

### Why the refs are sharded

A git ref has one writer. With every machine publishing session archives, one shared ref would put the whole fleet on one lock; a per-machine namespace gives each machine a namespace only it writes (§7.2). Grouping is therefore **not** the ref structure: a `parentSession` link routinely points at a session archived under another machine's prefix, which is why `family()` reads headers.

### Failure and recovery

A turn is never failed by archival: a failure is reported through `ctx.logger.warn` and the turn continues. The durable log is untouched and complete, so the next stopping turn archives the whole prefix again — every archive is a complete copy, never an increment.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how an archive is produced; the observable contract lives in [Use this package](#use-this-package).

### Design concept

- **Bypass, not replacement.** The log is read through `ctx.sessionPersistence`'s read path. The archiver holds no write handle, never appends, and never flushes anyone else's buffer.
- **Content, not refs.** The archived header carries `parentSession`; the grouping view is built from headers alone.
- **Objects, not a checkout.** The commit is built with `hash-object`, `ls-tree`, `mktree`, `commit-tree`, and `update-ref`. Checking the archive out would need a writable tree per machine, would race the turn's own `git add --all` checkpoint on the shared index, and would materialize gigabytes nothing reads from the filesystem. Building the tree from objects keeps an archive a pure object-store write, so it and a turn checkpoint can land in either order.
- **A complete copy each turn.** Every archive holds the full durable prefix. That is what makes a skipped or failed archive harmless: the next one carries everything.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, configuration validation, per-turn trigger, ref derivation |
| [`src/plumbing.ts`](src/plumbing.ts) | Tree building, commit creation, and ref updates over git plumbing |
| [`src/git.ts`](src/git.ts) | One git command through the subprocess seam, with its typed failure |
| [`src/archive.ts`](src/archive.ts) | Segment encoding, the archived JSONL format, header parsing, and family reconstruction |
| [`src/types.ts`](src/types.ts) | Archived ref, archived session node, and family vocabulary |

### Archive flow

`archiveSession` opens the session's stored log, reads its header and its durable events, and refuses when the log holds no event. The content becomes one JSONL artifact written atomically into the machine's shard directory. The blob is hashed into the object store, the parent commit's tree is re-read along the archive path and rebuilt with that one entry replaced, and `commit-tree` writes the commit; the parent is the session's own previous archive when one exists and `HEAD` otherwise, so a session ref advances along its own history while the first archive carries the repository state it was built on. `update-ref` publishes it.

### Session ids in paths and refs

A session id is an opaque string that becomes a directory entry, a file name, and a git ref component. Every unit outside `[A-Za-z0-9-]` is escaped as `_XXXX`, which keeps the result inside git's ref alphabet (`~`, `.lock`, and a leading dot are all refused by git) and prevents any id from traversing out of the archive tree.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [infra-requirements.dsh.md](../../../infra-requirements.dsh.md) — §7.2 (machine-sharded refs), §7.3 (bypass archiver), §11 item 7 (this package), and §18 (session retention).
- [`@deepseek-ai/dsh-session-persistence-jsonl`](../../session/session-persistence-jsonl/README.md) — the only persistence provider, and the log this package reads.
- [`@dsh-fleet/git-checkpoint`](../git-checkpoint/README.md) — the two-phase commit and push queue that publishes what this package commits.

-----

<a id="model-experience"></a>
## Model Experience

### Session archival

#### What the model sees

Nothing. `ctx.sessionArchive` registers no tools and injects no prompt; it does not append a session event, because a record of the archive written into the log being archived would change the artifact it just committed. No request carries an archive ref, a commit id, or an archival failure.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: no request prefix changes when a session is archived, and the archiver never writes to the log a replay or a resume reads.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what this archiver cannot do. They are current package constraints, not a task backlog.

- **An archive is the durable prefix, not a live snapshot.** The JSONL backend buffers routed live events for up to its write-batch window (200 ms) before they reach disk. A turn that finishes inside that window is archived by the next turn, which carries the complete prefix; a session that ends there keeps its last events unarchived until something archives it again.
- **`family()` reads one checkout.** It scans the archive tree in this repository. Sessions archived by another machine appear only once their files exist here, so fetching and merging the refs stays the caller's step.
- **A session ref is not a complete archive snapshot.** Its first commit descends from `HEAD` and later ones from that session's previous archive, so the tree carries that session's log plus the repository state the chain started from. Read an archive by path (`<ref>:<archive path>`), not as a whole-tree export.
- **Archive files also land in the branch.** `archiveRoot` is inside the repository, so a turn checkpoint's `git add --all` commits them onto the working branch as well; the per-session ref is what makes them fetchable without the branch.
- **Archival needs the persistence provider.** The plugin injects `sessionPersistence`; without a mounted backend it never loads, by design — an archiver with no durable log to read has nothing to archive.
- **Every turn re-commits the whole log.** Storage growth is accepted (§13): a long session's archive grows with its log rather than sending deltas.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **No interval trigger.** §7.3 requires per-turn granularity, and a timer would archive a session mid-turn while the provider is writing it; the `agent/turn-stopping` trigger is the whole schedule. Revisit only with evidence that a turn can end without a stopping event.
- **Nothing archives at session disposal.** A session whose final events land after its last stopping turn keeps them unarchived in this checkout; a disposal-time archive is the obvious next step if that gap matters.

</details>

**Runtime invariant:** No companion is published. The service owns no long-lived in-process relation: an archive is one write into git, and the grouping view is derived per call from files another process may have written.
