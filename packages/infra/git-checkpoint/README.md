---
description: "Two-phase git archival (ctx.gitCheckpoint) for fleet compositions and maintainers committing every turn locally without network access and pushing asynchronously behind a durable queue."
kind: "package-reference"
---

# @dsh-fleet/git-checkpoint

English | [中文](README.zh.md)

## Summary

Use `dsh-git-checkpoint` to make every turn durable in git without ever putting a network round-trip inside the turn. Mount it in the fleet composition; `agent/turn-stopping` stages the turn's workspace and commits it locally, once per turn, recording the commit as a durable `git/checkpoint` session event. Pushing is a separate phase: `ctx.gitCheckpoint.enqueuePush(ref)` writes a durable queue entry and returns, `drain()` retries queued refs with bounded exponential backoff, and `finalPush(ref)` blocks until the remote has the ref. Choose it so a remote outage reaches only the final push, not the turn loop (§7.1). It is host-only and has no model-visible effect.

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

Mount the service once per process, with a repository and a queue file the deployment owns:

```yaml
- id: fleet-git-checkpoint
  name: '@dsh-fleet/git-checkpoint'
  config:
    repositoryRoot: /srv/fleet/team-state
    remote: origin
    backoffBaseMs: 2000
    backoffMaxMs: 300000
    maxAttempts: 0
    queueFile: /srv/fleet/state/push-queue/pending.tsv
```

### When to choose it

Mount it on every machine that runs turns. Omission is correct only for a composition whose turns produce nothing worth keeping: without it, a turn's work exists solely in the working tree, and a crash or a swept checkout loses it.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `repositoryRoot` | the stopping turn's workspace | Absolute repository every checkpoint commits; omission uses `session.header.cwd` |
| `remote` | `origin` | Remote the asynchronous push targets |
| `commitMessageTemplate` | `dsh checkpoint: session {session} turn {turn}` | Commit message template; `{session}`, `{turn}`, `{branch}` are replaced |
| `backoffBaseMs` | `2000` | First retry delay, doubling per attempt |
| `backoffMaxMs` | `300000` | Ceiling on one retry delay |
| `maxAttempts` | `0` | Push attempts per ref before it stays queued; `0` retries forever |
| `queueFile` | `<DSH_HOME>/push-queue/pending.tsv` | Absolute path of the durable push queue |
| `enabled` | `true` | Whether `agent/turn-stopping` checkpoints a turn |

The template must contain `{session}` and `{turn}`: a checkpoint whose history cannot name the session and turn it belongs to is a load failure, not a silently anonymous commit. `backoffMaxMs` must be at least `backoffBaseMs`.

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc.

### What you get

- Phase 1: a local commit per stopping turn, recorded as a `git/checkpoint` session event carrying `turn`, `commit`, `repository`, and — on a branch — `branch` and the queued `ref`. A turn whose workspace is unchanged creates no commit and no record.
- Phase 2: `enqueuePush(ref, repository?)` appends one durable queue line and returns; `drain(signal?)` retries every queued ref and reports `{ pushed, failed }`; `finalPush(ref, repository?)` pushes that ref, blocking until the remote has it.
- `queueFile` and `remote` getters, so an operator surface can name where phase 2 state lives without re-reading configuration.

### The queue file

The queue is the file `infra/scripts/push-queue.sh` maintains: one `<repository>\t<remote>\t<ref>` line per entry, appended and synced before `enqueuePush` returns, and dropped only after that ref's push reached the remote. The shell tool and this service therefore drain each other's work instead of keeping two queues; the plugin does not replace the script, it exposes the same two phases to the harness.

A complete line that is not a queue entry refuses the whole read (`PushQueueError` names the file and line). A final line without its newline is a write still in flight and is not yet an entry, so a reader running beside a writer never fails on a torn append.

### Failure and recovery

A turn never fails because of archival. A push is never attempted on the turn path, and a local git failure is reported through `ctx.logger.warn` and leaves the turn to continue: the commit it could not make is simply carried by the next checkpoint. A push that fails is reported the same way and stays queued — `drain()` returns it in `failed`, and the next drain retries it. `finalPush` is the only path that turns a remote failure into a thrown `GitPushError`, and it throws only when a finite `maxAttempts` budget runs out or the plugin was disposed mid-push.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains where the two phases come from; the observable contract lives in [Use this package](#use-this-package).

### Design concept

- **One commit per turn, decided in the turn.** `agent/turn-stopping` runs before an otherwise completed turn closes, so the commit happens inside the turn that produced the work. The service remembers which `(session, turn)` pairs it already committed, so a repeated stopping event — a steered turn continues and stops again — never commits twice.
- **No empty commits.** Staging always happens, but the commit is skipped when `git diff --cached --quiet` reports no difference, so history records work rather than wall-clock time.
- **The network is a separate phase.** Nothing on the turn path contacts a remote. The queue is the only state phase 2 needs, and it is on disk before `enqueuePush` returns, so a process that dies between the two phases loses nothing.
- **Reporting is not failing.** Both phases report through `ctx.logger` and the `drain` report; neither throws into the agent loop, because a remote fault is not a turn fault.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, configuration validation, turn checkpointing, backoff policy, final push |
| [`src/git.ts`](src/git.ts) | The git primitive: one subcommand through the subprocess seam, plus its typed failure |
| [`src/queue.ts`](src/queue.ts) | The durable queue file: line format, append with sync, drop-on-success |
| [`src/types.ts`](src/types.ts) | Queue entry, drain report, checkpoint record, and the `git/checkpoint` event declaration |

### Phase 1

`agent/turn-stopping` resolves the repository — the configured `repositoryRoot`, else the session's own workspace — runs `git add --all`, and asks `git diff --cached --quiet` whether anything is staged. Exit code 0 means nothing to commit; 1 means commit; anything else is a real failure and surfaces as `GitCommandError`. The commit message is rendered from the template, then `git rev-parse HEAD` and `git symbolic-ref --short HEAD` supply the commit id and branch. A detached HEAD commits and records but queues nothing, because a detached checkout has no branch ref to publish.

### Phase 2

`drain` reads the queue and attempts each entry with `git push --quiet <remote> <ref>`, doubling the delay from `backoffBaseMs` to `backoffMaxMs` after every failure. Entries are removed from the file only after their push succeeded, and the file is re-read before that rewrite, so an entry enqueued while a drain was running survives it. `finalPush` runs the same policy for one ref and throws `GitPushError` when a finite budget runs out.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [infra-requirements.dsh.md](../../../infra-requirements.dsh.md) — §7.1 (two-phase archival), §11 item 6 (this package), and §10 (the `agent/turn-stopping` landing point).
- [push-queue.sh](../../../infra/scripts/push-queue.sh) — the shell implementation of the same two phases and the same queue file.
- [`@dsh-fleet/session-archive`](../session-archive/README.md) — the per-turn session archiver whose refs this queue pushes.

-----

<a id="model-experience"></a>
## Model Experience

### Turn checkpointing

#### What the model sees

Nothing. The service registers no tools and injects no prompt. The `git/checkpoint` session event is log-only: a durable record, not a model-visible surface, so no request carries a commit id, a queue entry, or a push failure.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: no request prefix changes when a turn is committed, queued, drained, or pushed.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what two-phase archival cannot do. They are current package constraints, not a task backlog.

- **Git identity is the deployment's.** The commit runs through the deployment's own git, so `user.name` and `user.email` must be configured for the process (repository or global config); without them the checkpoint is reported and skipped rather than invented. No identity is hardcoded here.
- **Phase 2 has no timer.** Nothing in this package schedules a drain: a caller (a scheduled follow-up, the final push path, or an operator command) drives it. An interval would be a tunable this package has no evidence to choose.
- **Duplicate suppression is advisory.** Two processes may append the same queue entry concurrently; pushing one ref twice is harmless, which is why the queue does not lock.
- **`finalPush` pushes one ref.** The rest of the queue stays phase 2's work, so the blocking path cannot be held open by an unrelated ref. Run `drain()` when everything must be up.
- **Per-process turn memory.** The `(session, turn)` record lives in the process; a restarting process may re-attempt a turn that was already committed, which commits the remaining difference or nothing at all.
- **`DSH_HOME` decides the queue's location.** With `DSH_HOME` unset the shell tool defaults to `$PWD/.dsh` while this plugin uses the harness home `~/.dsh`; set `DSH_HOME`, or configure `queueFile` explicitly, for the two to share one queue.
- **The `git/checkpoint` event must be registered in the generated catalog.** `packages/core/session/src/known-event-types.ts` is generated from the repository's `SessionEventMap`; until `pnpm run gen-persistence-catalog` includes this event, a cold read of a log containing it refuses the log. Writes are unaffected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Why the queue file is shared with the shell script** — the two implementations must agree on one durable state, or a fleet that mixes them drops entries when the other side rewrites the file.
- **Why a failed checkpoint may be retried but a committed turn never is** — the failure marker is released so a genuine transient (an index lock) can recover on the next stopping event, while success is final because a second commit for one turn would split that turn's work across two commits.

</details>

**Runtime invariant:** No companion is published. The service owns one queue file and one per-turn record, and a check of either would restate service presence rather than compare two independent observations.
