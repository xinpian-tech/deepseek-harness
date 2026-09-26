---
description: "Worktree isolation for the fleet's best-of-N candidate evaluation: one git worktree and branch per candidate, swept-out candidates kept as evidence, and a durable candidate set per task."
kind: "package-reference"
---

# @dsh-fleet/worktree

English | [中文](README.zh.md)

## Summary

`@dsh-fleet/worktree` registers `ctx.worktrees`, which turns "N candidates for one task" into N git worktrees on N branches. Each candidate gets its own checkout, so two workers never share a tree. Branch names tell a candidate apart from the commit the main agent accepted. A swept-out candidate's commit and branch stay as evaluation evidence unless the deployment turns that off. Every create, select, and prune outcome is recorded in the caller's session log, and the candidate set of a task is durable state under the worktree root, so a later process reads it back rather than trusting its creator.

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

Mount this package beside the subprocess seam it runs git through, and give it the repository the task group works in. The main agent then creates one candidate per index it wants to evaluate, selects the one it accepts, and decides separately whether the swept-out candidates are pruned.

```yaml
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@dsh-fleet/worktree'
  config:
    repositoryRoot: /srv/team/state/repository
    worktreeRoot: /srv/team/worktrees
    maxCandidates: 4
    keepLosers: true
```

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `repositoryRoot` | harness process cwd | Absolute path of the repository candidates are worktrees of; the plugin resolves git's canonical top level at load |
| `worktreeRoot` | `<repositoryRoot>/.dsh-fleet/worktrees` | Absolute root holding each task's candidate worktrees and its state file |
| `branchPrefix` | `fleet/candidate` | Branch namespace candidates are created under |
| `keepLosers` | `true` | Whether a swept-out candidate's worktree and branch are kept |
| `maxCandidates` | required | Ceiling on live candidates per task; a new candidate beyond it refuses |
| `gitBin` | `git` | git executable |
| `graceMs` | `2000` | Termination grace for git processes |

### What you get

| Call | Result |
|---|---|
| `createCandidate(taskId, index, options?)` | The candidate's worktree, created or reused; recorded durably before it is returned |
| `list(taskId)` | The live candidates of one task, read back from durable state |
| `select(taskId, index, options?)` | Publishes the accepted candidate's commit on the task's selected branch and records the selection |
| `prune(taskId, options?)` | Removes swept-out worktrees and branches when `keepLosers` is false; returns the branches removed, or `[]` when it is a no-op |

`options.recordTo` names the session that receives the durable `worktree/candidate`, `worktree/select`, and `worktree/prune` records. The caller's own session is the right owner, so the candidate set of a task reconstructs from that session's log.

### Branch naming

One candidate is one branch: `fleet/candidate/<taskId>/c<index>`. The accepted commit is additionally published as `fleet/selected/<taskId>`, which is the prefix's last segment replaced by `selected`, so a branch name alone says whether a commit was accepted or swept out (§5.5). The accepted candidate keeps its own candidate branch too; selection never deletes another candidate's worktree or branch.

### Failure and recovery

- `TypeError` refuses a task id or index that cannot name a worktree directory and branch, and names the invalid value.
- `WorktreeError` refuses a candidate beyond `maxCandidates`, a recorded worktree that git reports on another branch, a selection of an index the task does not hold, and a prune of a task with no selected candidate.
- `GitCommandError` reports a failed git command with its argv, exit code, and stderr; `WorktreeStateError` reports a durable state file that is unreadable or of an unexpected version.
- Load fails loud when a configured path is relative, `maxCandidates` is not a positive integer, the branch prefix is unusable, or `repositoryRoot` is not a git working tree.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **One candidate, one worktree, one branch.** Isolation is the point: two candidates of one task never share a working tree, and a sweeper that selects one leaves the others intact.
- **Durable state is the authority for `list`.** The task's state file, not an in-memory map, answers which candidates exist; a process that never created a candidate still reports it.
- **git runs through the subprocess seam.** Every command is an argv array passed to the process seam, never a shell string, so a task id, branch name, or path cannot change which command runs.
- **The plan is data, the score is not.** The service records which candidate exists and which one was accepted. Which candidate is *best* is the main agent's judgement, made from the evidence the candidates and the red team produced.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, `ctx.worktrees`, candidate lifecycle, branch naming |
| [`src/git.ts`](src/git.ts) | The git primitive: argv-only invocation, `GitCommandError`, `git worktree list` parsing |
| [`src/store.ts`](src/store.ts) | Durable task state: atomic replacement and validation of a decoded document |
| [`src/types.ts`](src/types.ts) | `Worktree`, record options, and the `SessionEventMap` declaration of every outcome |

### Durable state

Each task owns `<worktreeRoot>/<taskId>/`: its candidate worktrees as `c<index>` directories, and `state.json` holding the candidate list, the branch prefix they were created under, and the selection. A recorded branch prefix that no longer matches the configuration refuses, because it would otherwise address different branches than the recorded candidates.

### Git operations

Creating a candidate resolves the repository `HEAD` as the base commit, attaches an existing branch when one is already there (so commits a candidate already made stay reachable), and otherwise creates the branch at that base. Selecting resolves the candidate branch's commit and points the selected branch at it with `git update-ref`. Pruning removes each swept-out worktree before deleting its branch, so git never sees the branch as checked out.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fleet requirements](../../../infra-requirements.dsh.md) — §11 items 8 and 9, §5.5 (keeping swept-out candidates), §12 (worktree isolation).
- [Ledger sibling](../ledger/README.md) — the durable performance record that later dispatch decisions read.
- [Subprocess seam](../../subprocess/subprocess/README.md) — the argv-only process contract git commands run through.
- [Architecture](../../../docs/architecture.md) — where capability seams, plugins, and durable state belong.

-----

<a id="model-experience"></a>
## Model Experience

### Worktree bookkeeping

#### What the model sees

Nothing by itself: the service registers no tool, contributes no prompt section, and writes no message. A caller's session receives a log-only `worktree/candidate`, `worktree/select`, or `worktree/prune` record when that caller passes `recordTo`, which is how a later evaluation round reconstructs the candidate set without touching git.

#### Token effect

Zero direct tokens on every request. A tool that later reports candidate paths and branch names to the main agent owns whatever enters the request.

#### KV Cache effect

Independent of live requests: the service never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this package is a poor fit. They are current package constraints, not a task backlog.

- **Local repositories only** — candidates are worktrees of a repository on the machine that runs the service; a task group spanning machines needs one worktree service per machine.
- **The service does not own commits** — it creates and names branches, and the workers commit into their own candidate worktrees. Nothing here decides what a candidate changed.
- **Pruning is destructive by configuration** — with `keepLosers: false`, `prune` deletes swept-out branches after it removes their worktrees; a deployment that might need that evidence later must keep the default.
- **Worktrees are not workspace entities** — a candidate stays a path owned by this package rather than a `dsh-workspace` record, because these worktrees are evaluation scratch space, not user workspaces; a UI that should offer one to a human would need that registration.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above and in the package code.

- **Concurrency** — writes of one task's state file are serialized per service instance. Two processes creating candidates for the same task are not coordinated; a fleet that needs that would put one owner in front of the state file or move it onto the storage seam.
- **Reuse versus re-creation** — a recorded worktree that git still reports on its branch is returned unchanged; a recorded worktree whose directory is gone is re-added on its recorded branch. The middle case, a path registered on a different branch, refuses rather than guessing.

</details>

**Runtime invariant:** No companion is published. The candidate list is read back from the durable per-task state rather than an in-memory map, so two service instances over one repository report the same candidate set.
