---
description: "The ctx.shell provider that runs every shell command inside a flake environment instead of on the host, for fleet compositions whose commands must not mutate the machine."
kind: "package-reference"
---

# @dsh-fleet/nix-shell

English | [中文](README.zh.md)

## Summary

Mount this provider to make `nix develop <flakeRef> -c bash -lc <command>` the only way a shell command runs. A command that installs a package installs it into a throwaway flake environment or fails there, so no command can change the machine it runs on, and every command's tools come from the flake rather than from the harness process. Mount it in place of `@deepseek-ai/dsh-bash-sandbox`, which the same composition disables, because a composition may hold exactly one `ctx.shell` implementation.

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

Mount the provider in the fleet composition after disabling the base profile's executor:

```yaml
- id: bash-sandbox
  disabled: true

- insert:
    - id: fleet-nix-shell
      name: '@dsh-fleet/nix-shell'
      config:
        timeoutMs: 60000
```

### When to use it

Choose it when commands must not be able to mutate the host: a `pip install`, a global `pnpm add -g`, or an edit under `/etc` then either lands in the flake's disposable environment or fails there. Choose `@deepseek-ai/dsh-bash-sandbox` instead when commands must run on the host under a file policy — this provider does not offer a host path, and its `flakeRef` is a load-time constant, so a composition that needs host commands and flake commands at once needs two processes, not two rows.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `flakeRef` | `.` | Flake the environment comes from; resolved against the harness launch directory at load |
| `nixBin` | `nix` | nix executable, resolved on `PATH` or as a path at load |
| `developTimeoutMs` | `300000` | Milliseconds added to every command deadline for realising the flake environment |
| `mode` | `develop` | `develop` (`nix develop`) or `shell` (`nix shell`) |
| `extraArgs` | `[]` | Extra nix arguments inserted between the flake reference and `-c` |
| `timeoutMs` | `120000` | Default per-command deadline, before the preparation budget is added |
| `maxTimeoutMs` | `600000` | Upper bound for a caller's own `timeoutMs` |
| `maxOutputBytes`, `maxSpillBytes`, `graceMs`, `cwd` | see the catalog | The inherited local executor's output, spill, kill-grace, and working-directory budgets |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc.

`extraArgs` carries deployment-varying nix flags such as `--no-write-lock-file`; the default is empty, so a deployment opts in explicitly. `developTimeoutMs` is separate from `timeoutMs` because `nix develop` may fetch or build the development environment before the command starts: the resolved deadline is the command budget plus the preparation budget, capped at the largest schedulable timer, and that sum is what `ShellRunResult.timeoutMs` reports.

### What a command sees

Three consequences follow from running commands in the flake rather than on the host, and each one is worth stating on its own:

- **A command that installs a package cannot change the machine.** The installation goes into the flake's environment, which is discarded at the end of the command, or it fails because that environment is read-only and unprivileged. There is no allowlist and no command blacklist here: the environment, not a pattern match, is what makes the command harmless.
- **Commands are reproducible from the flake.** The tools a command resolves come from the pinned flake the composition names, so the same command run on two machines of the fleet resolves the same programs instead of whatever each host happened to install.
- **The host PATH is not what a command sees.** `nix develop` exports the flake's development environment over the launching one, so `PATH` and the programs behind it are the flake's. Variables the harness process set that the flake does not mention stay visible, because `nix develop` is impure by default; `IN_NIX_SHELL` is `impure` inside the environment, which is the one marker a command can use to tell where it ran.

### Failures and recovery

A load failure is a configuration error and stops the process before any command runs: an unresolvable `nixBin`, a path `flakeRef` that is not a directory containing `flake.nix`, a nonpositive `developTimeoutMs` or `timeoutMs`, or an empty `extraArgs` entry. Once loaded, a command's nonzero exit, deadline kill, and abort kill are ordinary results; a spawn that never produced a process rejects `result()`. The flake itself is resolved per command, so an unreachable flake input makes every command fail with nix's own diagnostic on stderr rather than at load.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **Subclass the sandbox-consuming executor.** `NixShellExecutor` extends `@deepseek-ai/dsh-bash-sandbox`, so the deployment's sandbox policy still confines the process, one `ctx.shell` implementation still exists, and process plumbing stays in one place.
- **Rewrite the argv, not the policy.** The only behavioral change is which argv is spawned; output capture, deadlines, cancellation, write-path detection, and enforcement facts are the base implementation's.
- **Resolve paths once, at load.** The nix executable, the flake path, and the budgets are fixed when the plugin loads, so no later call depends on a mutable `PATH` or working directory.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service class, config schema, load-time resolution and validation |
| [`src/command.ts`](src/command.ts) | The pure invocation helpers: argv construction and shell-word quoting |

### Command rewriting

`nixShellArgv()` returns the exact argv one command runs as:

```
[nixBin, 'develop' | 'shell', flakeRef, ...extraArgs, '-c', 'bash', '-lc', command]
```

`nix <mode> -c <argv…>` execs the remaining argv inside the environment, so the caller's command text is one argv element and `ls`, a pipeline, and a heredoc all reach the shell exactly as written. Nothing in the command is parsed by nix.

The shell seam's own `bash -c` layer sits outside that argv, and `shellCommandLine()` renders it: every element becomes one single-quoted word, so a command containing spaces, quotes, or `$` survives as the same element instead of being re-split or expanded. That shell line is the only shell string this package builds, and no part of it is interpolated unquoted.

The rewrite happens in `execute()`, not in `resolve()`, because `execute()` is the method a caller cannot bypass: a spec a plugin built by hand still runs inside the flake, while a spec obtained from `resolve()` keeps the caller's own command text for display and job labels.

### What the base executor still owns

`resolve()` delegates to the sandbox-consuming base and adds only the preparation budget; `execute()` delegates everything after replacing the command. The base, in turn, inherits from the local executor: the spawn through `ctx.subprocess`, stdout/stderr capture with spill files, the fused deadline, abort classification, SIGTERM-to-SIGKILL escalation, background reads, and teardown of running processes at composition disposal. Sandbox mode, enforcement, and denial facts are stamped by the base from `ctx.sandbox`'s answer for the argv this package handed it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [infra-requirements.dsh.md](../../../infra-requirements.dsh.md) — §2.2 layer two, the structural enforcement this package implements.
- [bash-sandbox](../../shell/bash-sandbox/README.md) — the executor this class extends and the sandbox consumer it stays.
- [shell](../../shell/shell/README.md) — the `ctx.shell` service definition, its request/spec split, and the lifecycle every executor must honor.
- [flake.nix](../../../flake.nix) — the development environment a fleet command runs in.

-----

<a id="model-experience"></a>
## Model Experience

### Bash tool calls

#### What the model sees

The `bash` tool call it wrote, unchanged, and that command's own stdout, stderr, and exit code. Nothing in the transcript says the command ran inside a flake: there is no prompt section, no tool-schema field, and no rewritten command echoed back. A model that assumes the host environment still sees ordinary command failures, with nix's evaluation and build diagnostics on stderr when the flake cannot be realised.

#### Token effect

Zero direct tokens: no schema field, no `ctx.shell` prompt section, no extra message. The only token effect is data-dependent — nix's own diagnostics when a flake is unrealisable, which arrive as ordinary command output.

#### KV Cache effect

None. The tool schema and the request prefix are unchanged, so mounting this provider does not invalidate any cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this executor is a poor fit. They are current package constraints, not a task backlog.

- **No host execution path** — a command that must act on the host has no supported route through this provider, and a composition can hold only one `ctx.shell`, so mixing host and flake commands means separate processes rather than separate rows.
- **One flake per executor, fixed at load** — `flakeRef` is resolved when the plugin loads, so a workspace whose flake lives elsewhere needs its own composition or a reload; per-command flake selection is deferred.
- **Every command pays flake resolution** — `nix develop` resolves the flake for each command, so an unreachable flake input or a cold environment fails or delays every command, not just the first.
- **`nix shell` exports no environment** — `mode: shell` only puts the installable's `bin` on `PATH`; a command that needs the development environment's variables must use the default `develop`.
- **The flake is not locked by this package** — writing or forbidding `flake.lock` updates is the flake's and the deployment's decision, so `--no-write-lock-file` and its relatives belong in `extraArgs`.
- **`--impure` is not forced** — `nix develop` leaves variables the harness process set in place; a deployment that requires a clean environment must clear them in the composition, since this package does not scrub them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Per-command flakes** — a workspace that carries several flakes would need a request field the shell seam does not have today; the seam owns request vocabulary, so this waits on it rather than on a wrapper.
- **Lock-file policy** — pinning or freezing `flake.lock` is a fleet-level decision; `extraArgs` is the current carrier, and a dedicated field would need the deployment's evidence for one spelling.
- **Preparation accounting** — the preparation budget is charged to the same deadline as the command, so an unusually slow realisation shortens the command's own window by an amount the caller cannot see separately.

</details>

**Runtime invariant:** No companion is published. The executor owns one resolved configuration plus the base class's per-process state; nothing here observes an independent relationship that could diverge, so an invariant companion would only restate service presence.
