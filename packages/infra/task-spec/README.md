---
description: "The machine-decidable acceptance criteria a fleet task carries, their durable session records, and the failed-item report a layer sends back up."
kind: "package-reference"
---

# @dsh-fleet/task-spec

English | [中文](README.zh.md)

## Summary

`@dsh-fleet/task-spec` gives every task an acceptance contract the moment it is created: criteria a machine decides, recorded on the task's session instead of written into a prompt. The §2.4 Nix template is built in, so every generated set requires `nix flake check`, `nix build .#default`, and `nix develop -c <project test command>`; a project without a flake fails with no subjective judgement. Mount it where a layer creates, delegates, or judges tasks, and where a layer re-runs acceptance without trusting the layer below. It decides `command`, `schema`, and `diff` criteria against a workspace and reports failed items, not prose.

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

Mount the service in the composition that creates, delegates, and judges tasks. It reads `ctx.shell` for command criteria and `ctx.subprocess` for the git binary a diff criterion runs, and it registers `ctx.taskSpec`.

### When to choose it

Choose this package when a task must be judged without a reviewer's opinion and every layer must be able to re-run the same acceptance rather than trust the layer below. It is the only owner of the criterion vocabulary: a layer that records a task, a layer that executes acceptance, and a layer that reports failed items all speak these three criterion kinds. Layers that need different criteria should extend the vocabulary here rather than add a parallel one, and a task whose outcome a machine cannot decide does not belong in this tree at all — no criterion is accepted for it.

### Minimal configuration

```yaml
- id: task-spec
  name: '@dsh-fleet/task-spec'
  config:
    defaultTestCommand: pnpm test
    defaultTimeoutMs: 600000
    maxCriteria: 64
    workspaceRoot: !!js process.cwd()
```

| Field | Default | Meaning |
|---|---|---|
| `defaultTestCommand` | none | Project test command the `nix develop -c` criterion runs when a caller passes none |
| `defaultTimeoutMs` | `600000` | Deadline for one criterion, and for the git invocation a `diff` criterion runs |
| `maxCriteria` | `64` | Bound on how many criteria one spec may carry |
| `workspaceRoot` | harness launch directory | Absolute root a `schema` target must stay inside; a relative value resolves against the launch directory once, at load, and must exist there |

### The Nix acceptance template

`nixAcceptance(testCommand?)` returns the §2.4 template in this fixed order, and every generated acceptance set carries it:

```ts
{ kind: 'command', run: 'nix flake check',                   expect: { exitCode: 0 } }
{ kind: 'command', run: 'nix build .#default',               expect: { exitCode: 0 } }
{ kind: 'command', run: 'nix develop -c <project test cmd>', expect: { exitCode: 0 } }
```

Nix is the dependency decision a machine can always make, so "the project must use Nix" is not a prompt instruction here — it is an acceptance item every task carries. A project without a flake fails `nix flake check` and the task is rejected with no judgement call.

### The three consequences this vocabulary exists for

1. **Every layer can re-run acceptance without trusting the layer below.** The criteria are recorded as durable data on the task's session, not as prompt text that a model reinterprets, so a re-run is deterministic and the layer above can check the same items itself.
2. **Reporting is a list of failed items, not prose.** `AcceptanceResult[]` is the reportable unit; the steady-state `TaskReport` carries the failed ones back up.
3. **A correction instruction is failed items plus direction.** Because the failed list is machine-produced and identical at every layer, a rework round needs no natural-language evaluation to be actionable.

### What the service does

| Method | Effect |
|---|---|
| `nixAcceptance(testCommand?)` | Returns the three §2.4 criteria in order |
| `validate(spec)` | Refuses a spec a machine could not decide, naming the offending field |
| `run(criteria, context)` | Executes every criterion against `context.workspace`, records each result on `context.recordTo`, and returns one `AcceptanceResult` per criterion in order |
| `attach(session, spec)` | Validates and records the spec, so the criteria and task-tree path reach the child session as durable data |
| `report(session, report)` | Records the task's status, failed items, and cost |

A refusal is never a thrown run. A command that exits nonzero is a `failed` item carrying the observed exit status; a missing or invalid schema target is `failed`; a criterion that cannot be attempted at all — a target outside the workspace root, a capture cap that cut the evidence short, a workspace that is not a git repository — is an `error` item. The caller keeps one result per criterion, and every one of them is in the log.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Sources

| File | Owns |
|---|---|
| `src/index.ts` | The service, configuration resolution, and per-criterion execution through the shell and subprocess seams |
| `src/criteria.ts` | The §2.4 template, the decidability gate, and workspace path containment |
| `src/git.ts` | The `git` subprocess call and the changed-line total |
| `src/types.ts` | Criterion, result, and report vocabulary plus the durable `task/*` session events |

### How criteria and results reach the durable log

Three log-only session events carry the contract and its outcomes. `attach` appends `task/spec` once per task with the title, the task-tree path, the acceptance criteria, and the round limits. `run` appends one `task/criterion` per criterion as it is decided, carrying the task id, the criterion's index, the criterion itself, the status, and the evidence detail. `report` appends `task/report` with the status, the failed items, and the cost when the caller knows it.

Replay reconstructs the same list `run` returned: the `task/criterion` records of one task id, folded in log order, are the `AcceptanceResult[]` verbatim, because each record copies the criterion and the decision rather than pointing at either. The suite asserts that equality against a real run.

Command criteria run through `ctx.shell` with the criterion's own `expect.timeoutMs`, so the deployment's executor keeps its timeout ceiling. Diff criteria run `git diff --numstat --no-renames HEAD -- <scope>` through `ctx.subprocess` as an argv, never through a shell, so a scope cannot become a second command. Schema criteria read the target file and validate the parsed JSON against the criterion's schema with the repository's enforced JSON Schema subset.

### Deciding a criterion

`command` compares the observed exit status with `expect.exitCode` and, when `expect.stdoutMatches` is present, tests that regular expression against captured stdout. `schema` resolves the target inside the workspace root — an absolute path or one that escapes the root is refused before any read — parses it, and reports the first violations. `diff` totals the added and deleted lines git reports for the scope and fails when the total is over `maxLines`.

Every executed criterion produces one record whether it passed, failed, or could not be attempted, so a layer reading only the log sees the same acceptance history the executor saw.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Task contracts and acceptance](../../../infra-requirements.dsh.md) — §2.4 (Nix acceptance), §6.1 (acceptance criteria), §6.2 (reporting), §11 items 11 and 17
- [`@deepseek-ai/dsh-session`](../../core/session/README.md) — the append-only log these events are recorded in
- [`@deepseek-ai/dsh-tools`](../../core/tools/README.md) — the enforced JSON Schema subset a `schema` criterion is expressed in
- [`@deepseek-ai/dsh-shell`](../../shell/shell/README.md) — the command seam and its timeout ceiling

-----

<a id="model-experience"></a>
## Model Experience

### Child-session task bootstrap

#### What the model sees

This package registers no prompt section, tool, or tool schema of its own. It records the acceptance contract on the task's session, and a delegation consumer that opens the child session renders the recorded `task/spec` payload — title, task-tree path, and criteria — into that child's bootstrap context. The child model reads the criteria as data it must satisfy, and the same durable payload is what the layer above re-reads when it re-runs acceptance.

#### Token effect

No tokens by itself: nothing here enters a request. A consumer that renders the spec pays for the rendered title, path, and criteria in the child's first request, and for each `task/criterion` or `task/report` item it chooses to show; the records stay in the session log either way.

#### KV Cache effect

Append-only and prefix-preserving for the consumer: a bootstrap rendering is fixed when the child session opens, and later acceptance records reach the parent's context at the end of its history rather than rewriting an earlier prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints, not a task backlog.

- **The diff criterion measures the uncommitted working tree.** It totals `git diff --numstat HEAD -- <scope>`, so work that the fleet's per-turn commit already recorded reports zero, and untracked files are not counted at all. Bounding a committed candidate's change needs a base revision the criterion does not carry; add that field to the criterion rather than guessing a base here.
- **Nothing in this package renders a bootstrap prompt.** `attach` records; the delegation consumer owns the rendered text and therefore owns the session event that makes it model-visible. Until that consumer lands, the recorded contract is durable but not yet in any model's context.
- **Truncated evidence is an error item, never a pass.** Command stdout over the executor's capture cap, and git output over the 64 KiB numstat cap, make a criterion undecidable and are reported as `error`; a caller that lowers those caps trades silent wrong verdicts for visible ones.
- **`run` needs a session.** `TaskRunContext.recordTo` is required, so acceptance cannot execute without a durable record; a caller that wants a throwaway check should not use this seam.
- **No `./invariant` companion.** The only relation this package owns is the service registration, which cordis already pairs with the mounting fiber, and the durable records, whose consistency is asserted by the suite against a real run. A companion would check service presence or fixed examples, which the package invariant rules reject.
- **The generated catalogs follow this package.** Declaring the `task/*` events makes `packages/core/session/src/known-event-types.ts`, `docs/persistence-catalog.md`, and `docs/config-catalog.md` stale until `pnpm run gen-persistence-catalog` and the config-catalog generator run; they are regenerated by the owning scripts, not by hand.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Where the criterion `base` belongs.** A `diff` criterion that bounds a committed candidate needs a comparison revision. The candidate shape (a fixed base ref, a base recorded at attach time, or a criterion-level `since`) is undecided; the criterion vocabulary is the place to decide it.
- **Who renders the bootstrap.** The consumer that opens a child session owns that rendering, because it also owns the prompt sections around it. Keeping the renderer out of this package is deliberate: the service stays free of prompt text and of any assumption about which consumer delegates.
- **`error` versus `failed` for infrastructure faults.** A criterion that cannot run at all — no repository, a git failure, an unreadable file — is `error`; a criterion that ran and did not meet its standard is `failed`. The distinction is what lets a correction instruction separate "your work is wrong" from "the workspace could not be judged".

</details>

**Runtime invariant:** No companion is published. Every criterion that runs lands one `task/criterion` record before the next one starts, so a replayed log folds to the same result list the caller received.
