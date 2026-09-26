---
description: "The fleet's nix-only sandbox backend for users and maintainers composing, configuring, or debugging a workspace where only the flake store, the session workspace, and a private temp root are visible."
kind: "package-reference"
---

# @dsh-fleet/nix-sandbox

English | [中文](README.zh.md)

## Summary

Mount this package where commands must run inside a nix-only world: a read-only `/nix/store`, the session workspace, and a private temp root, with a PATH rebuilt from store directories and no network unless the deployment opts in. As a backend of the process-sandbox seam, it gives a confined bash call a process that cannot reach anything else on the host. `ctx.fleetSandbox` reports the effective profile as plain data, which is what a task's acceptance evidence quotes. Linux with bubblewrap is required, and the harness executable must come from the flake store; any other host fails closed with `SANDBOX_UNAVAILABLE`.

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

Mount this provider wherever the composition would mount `sandbox-local`: it registers as `ctx.sandbox`, so the existing bash and filesystem consumers keep working and every confined call gains a visibility decision they never express themselves.

### When to choose it

Choose it for a fleet worker that must depend on nothing but the flake ([`infra-requirements.dsh.md`](../../../infra-requirements.dsh.md) §2.2 layer one): the store is the only dependency source, the workspace is the only durable writable place, and a package manager installed on the host is not merely discouraged but absent. Choose `dsh-sandbox-local` instead when the host is macOS or Windows, when commands must reach host paths outside the workspace, or when the deployment has no flake to derive a PATH from — this backend refuses those hosts rather than approximating them.

### Minimal configuration

Replace the composition's sandbox row; the seam allows one provider per context, so mounting this package beside `dsh-sandbox-local` fails at load instead of silently choosing one.

```yaml
- id: sandbox
  name: '@dsh-fleet/nix-sandbox'
  config:
    storePath: /nix/store
    writableRoots: []
    network: false
    allowPackages: []
```

| Field | Default | Meaning |
|---|---|---|
| `profileName` | `nix-only` | Name carried by the resolved profile and quoted by acceptance evidence |
| `storePath` | `/nix/store` | Absolute store path, bound read-only; must exist at load |
| `writableRoots` | `[]` | Extra absolute writable roots granted to every call; the session workspace is added per call and does not belong here |
| `network` | `false` | Share the host network namespace; the explicit opt-in for a call that must fetch a flake input |
| `allowPackages` | `[]` | Package-manager names opted back onto the confined PATH; a deliberate weakening, recorded on the profile |

The plugin exports this schema as `Config`, and [`src/index.ts`](src/index.ts) is its exhaustive declaration; there is no generated catalog entry for a fleet package.

### What the confined process sees

The confined command runs in its own mount, PID, and (by default) network namespace. Inside it exist exactly the paths the profile lists: the store read-only, the calling session's workspace, the deployment's writable roots, and a private empty tmpfs at the host temp root that nothing else can see into. The PATH is rebuilt from the directories of the harness's own PATH that live under the store, with the temp root exported as `TMPDIR`. A store directory that provides a package manager is left off that PATH whole; `allowPackages` names the managers a deployment deliberately restores.

### Reading the effective profile

`ctx.fleetSandbox.profile()` returns the deployment's profile, and `profile({ workspaceRoot, mode })` returns what one call actually receives — the same derivation `confine()` uses, as data a task can quote:

```ts
ctx.fleetSandbox.profile({ workspaceRoot: '/srv/ws/task-7', mode: 'workspace-write' })
```

### Failures and recovery

A host that cannot run the profile — not Linux, no bubblewrap, or a harness executable outside the store — fails the first `confine()` with the seam's `SANDBOX_UNAVAILABLE` error, so the consumer reports an unusable sandbox rather than an unconfined command. A malformed configuration fails earlier, at plugin load: a relative or missing `storePath`, a relative, missing, or store-overlapping writable root, an empty profile name, an `allowPackages` entry that names no manager this profile blocks, and a PATH with no flake-provided tool directory all stop the composition before any command runs. A write denied inside the namespace surfaces through the backend's denial dialect, and a bubblewrap refusal before the command starts surfaces as a runner-failure signature.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the extension point and the derivation behind the profile; the observable behavior is fully covered in [Use this package](#use-this-package).

### The extension point, and the part the seam cannot express

The seam's contract is `SandboxProvider.confine(argv, policy)`: a backend returns the argv to spawn instead of the caller's own, plus the enforcement completeness, denial signatures, and runner-failure rules that describe how it governs the policy's file effects. The three modes (`read-only`, `workspace-write`, `danger-full-access`) decide write permission only, and no part of `SandboxPolicy` carries a visible path, a PATH, or a network state. So the visibility decision lives where the seam does allow one — in this provider's wrap. The profile is therefore additive to the seam rather than expressible in it: `ctx.sandbox` still answers "may this call write here?", and `ctx.fleetSandbox` answers "what can this call reach?".

Nothing in the seam forces a consumer through this backend either. A composition that resolves `danger-full-access` never calls `confine()` at all, and a second provider cannot coexist with this one. The nix-only world holds exactly where the deployment mounts this package and keeps its policy confined; no part of this package can make that choice for the composition.

### Profile derivation

`resolveProfile` reads the configuration plus three host facts — the process environment, `os.tmpdir()`, and an existence probe — and produces the profile as data; it runs once, at load. The PATH derivation keeps the ambient order, discards entries outside the store and relative entries, and drops a directory when it provides a blocked manager that `allowPackages` does not name. `effectiveProfile` then adds the calling session's workspace after the store and narrows every grant to `read-only` when the call's mode is `read-only`, leaving the store read-only in both cases.

### Runner argv

`confine()` expresses the effective profile in bubblewrap's dialect: `--die-with-parent`, a private PID namespace with fresh `/dev` and `/proc`, one `--ro-bind` or `--bind` per visible path, `--tmpfs` (plus `--remount-ro` under a read-only call) at the temp root, `--unshare-net` unless the deployment opted in, and `--setenv` for the confined PATH and `TMPDIR`. The temp tmpfs is mounted before every bind, so a workspace or writable root that happens to live under the host temp root is not shadowed by it.

### Availability probe

Availability is decided once per provider lifetime by running the real profile around `process.execPath` with an empty program. That single probe answers three questions at once: the kernel accepts the mounts, the confined PATH can execute the harness, and the harness executable is inside the store. A false verdict is cached, and every later call fails closed.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, load-time resolution, both service registrations |
| [`src/profile.ts`](src/profile.ts) | Profile resolution, validation, PATH derivation, per-call narrowing |
| [`src/provider.ts`](src/provider.ts) | The `ctx.sandbox` backend: probe, wrap, enforcement, denial and runner-failure facts |
| [`src/service.ts`](src/service.ts) | The `ctx.fleetSandbox` read-only profile query |
| [`src/types.ts`](src/types.ts) | The profile vocabulary as types only |
| — | No runtime invariant companion is published; this package owns no event stream or mutable relation, and its registrations are removed with the fiber that created them. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Start with the seam this backend implements, then the sibling backend it replaces and the consumers that render its facts.

- [Process sandbox subsystem](../../../docs/subsystems/sandbox.md) — modes, per-call policy, denial dialects, and fail-closed errors.
- [Sandbox seam package](../../sandbox/sandbox/README.md) — the service contract and provider role implemented here.
- [Local sandbox backends](../../sandbox/sandbox-local/README.md) — the per-platform provider this package replaces in a fleet composition.
- [Sandbox policy package](../../sandbox/sandbox-policy/README.md) — where the per-call mode and workspace root come from.
- [Bash sandbox executor](../../shell/bash-sandbox/README.md) — the confined consumer whose results render this backend's facts.
- [Fleet requirements](../../../infra-requirements.dsh.md) — §2.2 layer one and §11 item 14, the profile this package realizes.

-----

<a id="model-experience"></a>
## Model Experience

### Confinement outcome, indirectly

#### What the model sees

Through [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.md) and [`dsh-tool-bash`](../../shell/tool-bash/README.md), a confined call that this backend cannot enforce renders the [`dsh-sandbox`](../../sandbox/sandbox/README.md) seam's `SANDBOX_UNAVAILABLE` error, and a call whose file effect was denied renders this backend's denial dialect (`read-only file system`, `permission denied`) as the seam's denial marker. A command that fails because a path does not exist inside the namespace reads as an ordinary failure: visibility denials carry no marker of their own. This package contributes no prompt section, tool, or result text.

#### Token effect

Only the failing call's error or denial marker becomes visible, retained in history until compaction. The profile this backend enforces adds no tokens.

#### KV Cache effect

Append-only; refusal and denial text follows the retained prefix and does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this backend is a poor fit or needs special operational care. They are current package constraints, not a general sandbox comparison or a task backlog.

- **The seam still cannot express visibility.** `SandboxPolicy` carries a mode, a workspace root, and a session id; the profile, the PATH, and the network state live in this package's configuration and in `ctx.fleetSandbox`. A consumer that never calls `confine()` — anything resolving `danger-full-access` — is outside this backend entirely.
- **One provider per context.** Mounting this package next to `dsh-sandbox-local` fails at load with the seam's registration error; the fleet replaces that row rather than layering on it.
- **PATH filtering is directory-granular.** A store directory is kept or dropped as a whole, so a directory that ships both a toolchain and its package manager takes both or neither. On nixpkgs, `node` and `npm` share a store directory, so a deployment that wants `node` on the confined PATH must name `npm` in `allowPackages` and accept that the manager is reachable. Filtering individual executables needs a link farm mounted into the namespace; that is deferred.
- **The environment is inherited, not scrubbed.** The profile decides which paths exist, not which variables the command sees; `HOME`, `DSH_*`, and credential-shaped variables still reach the confined process. A caller that needs a minimal environment must supply one itself.
- **bubblewrap's own mounts are structural.** A fresh `/dev` and a private `/proc` exist in every confined run, so "nothing else" means nothing else of the host's filesystem, not an empty namespace.
- **Visibility denials read as missing files.** This backend's denial dialect excludes `no such file or directory`, because a genuinely absent file produces the same text; a model cannot tell a denied path from a typo.
- **Linux with bubblewrap only.** The profile is expressed in bubblewrap's mount and namespace dialect and probed by executing it, so macOS and Windows hosts fail closed, and a harness executable outside the store fails the probe even where bubblewrap works.
- **The store must exist and the PATH must come from it.** A load with no store-provided tool directory is rejected outright, which is the intended failure for a harness started outside `nix develop`, but it also means a partially populated environment cannot start the plugin at all.
- **`network: true` shares the whole host network namespace.** There is no per-host or per-command allow-list, so the opt-in is deployment-wide for the mounted profile, not scoped to the flake fetch that needed it.
- **Nothing verifies a command ran under the profile.** The profile is what `confine()` returns and what `ctx.fleetSandbox` reports; attestation of the running process is not attempted.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above and in the package code.

- **Executable-level PATH filtering.** A link farm in the private temp root, mounted into the namespace, would keep `node` while removing `npm` from the same store directory. Not decided; it costs a directory listing and a mount per call.
- **Attestation.** Recording the profile each confined call ran under (as a session event) would let a reviewer reconstruct visibility from the log rather than from the configuration. The seam's "model-visible ⟺ logged" rule does not currently reach the profile, because the profile is not model-visible.
- **Layer two.** Executing every shell command inside `nix develop -c` is a separate change (a `ctx.shell` provider or a bash wrapper); this package only decides what such a command can see.

</details>
