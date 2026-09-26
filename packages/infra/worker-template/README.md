---
description: "The worker launch template for fleet compositions and operators: place a resident tmux pane, suppress its tty echo, exec the sdk-profile harness, and forward credential-shaped variables explicitly."
kind: "package-reference"
---

# @dsh-fleet/worker-template

English | [中文](README.zh.md)

## Summary

Use `dsh-worker-template` to start a worker the way §5.4 requires: a `dsh --profile sdk` process inside a tmux pane, resident for the whole task and never exiting, with the tty's echo suppressed and the model credentials handed to the pane explicitly. `launch()` composes on `ctx.tmux` for placement and the frame channel, returns the exact command line and the exact environment entries the pane received, and warns about every configured credential this process does not hold — before the pane starts, not after a nested harness returns 401. The peer is the shell contract in `infra/scripts/worker.sh`.

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

Mount it beside the tmux channel, with both rows configured from one source:

```yaml
- id: fleet-tmux
  name: '@dsh-fleet/tmux'
  config: { dshHome: /var/lib/dsh-fleet/home, machineId: !!js process.env.DSH_FLEET_MACHINE_ID }

- id: fleet-worker-template
  name: '@dsh-fleet/worker-template'
  config:
    dshHome: /var/lib/dsh-fleet/home
    profile: sdk
    patches: [/etc/dsh-fleet/no-messaging.cordis.patch.yml]
    credentialEnv: [DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL]
    extraEnv: { DSH_FLEET_ROLE: worker }
```

### When to use it

Mount it in every composition that starts a worker pane. A composition that places panes through `ctx.tmux.place` itself can omit it, but then it owns the launch sequence, the credential passthrough, and the diagnostics by hand — which is the duplication this package exists to prevent.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `profile` | `sdk` | Profile the worker harness runs |
| `patches` | `[]` | Absolute profile patch files, in order |
| `dshBin` | `dsh` | Harness executable the pane execs |
| `dshHome` | required | Absolute harness home; also the `DSH_HOME` the pane receives |
| `credentialEnv` | the eight provider keys this repository knows | Credential-shaped variables forwarded explicitly when the launching process holds them |
| `extraEnv` | `{}` | Explicit name/value pairs layered over the allowlist |
| `enableStty` | `true` | Whether the launch line carries the tty setup step; `false` is refused at load |
| `startTimeoutMs` | `15000` | Bound (ms) on confirming the placed pane |
| `confirmPollMs` | `50` | Interval (ms) between confirmation checks |

Every field fails the load when it is unusable: a relative `dshHome` or patch, an empty binary or profile, an environment name outside `^[A-Za-z_][A-Za-z0-9_]*$`, or a nonpositive bound throws during plugin construction.

### What you get

- `launch(key, { cwd, mode?, recordTo? })` — place or reuse the pane and return `{ key, placement, launchLine, env, reused }`. `mode` defaults to `resident`, because a worker is resident for the whole task; `recordTo` is the session that receives the durable `tmux/placement` record.
- `launchLine` — the exact command the pane runs, tty setup included: `stty -echo -icanon; exec '<dshBin>' --profile '<profile>' [--patch '<file>']…`, with every value quoted as one shell word.
- `env` — the exact environment entries handed to the pane: `DSH_HOME`, every configured credential this process holds, and `extraEnv`.
- `credentialReport()` — `{ name, present }` for each configured credential, deliberately without ever returning a value.

### Failures and recovery

A credential the launching process does not hold produces a `ctx.logger` warning at launch and is omitted from `env`: a worker may be started for a task that needs no model access, so this is not fatal, but it must be visible before the pane runs. A newly created pane that cannot be confirmed within `startTimeoutMs` is released and the launch throws `WorkerTemplateError` naming the launch line — a pane that never appears fails here rather than later as a dead channel. A relative `cwd` throws `TypeError`. Disposing the plugin's fiber removes `ctx.workerTemplate`; the panes it placed belong to the channel and are released through `ctx.tmux`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **Compose, never re-implement.** Placement, the pane's environment, the echo-suppression step, the frame log, and the wait until the harness owns the pane's foreground all belong to `@dsh-fleet/tmux`; this package computes the command and the environment, hands both to `place`, and reports them back.
- **Report what the pane received.** `launchLine` and `env` are values, not observations of a running pane, so a test or an operator asserts them directly.
- **Quote once, at construction.** Every path in the line passes through one exported helper, so a workspace directory containing a space, a quote, a `$`, or a newline cannot change the command.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, configuration validation, placement, confirmation, credential report |
| [`src/launch.ts`](src/launch.ts) | `shellQuote`, `buildLaunchLine`, and `resolvePaneEnv` — pure, exported, unit-tested |
| [`src/types.ts`](src/types.ts) | `WorkerLaunchRequest` and `WorkerHandle` |

### The launch sequence

`launch` assembles the pane environment, warns about absent credentials, calls `ctx.tmux.place` with the assembled environment, and — for a pane it created — waits until `ctx.tmux.alive` reports it. The command the channel gives tmux is the same string this package returns as `launchLine`; the spec asserts that by reading the argv the composed channel handed its tmux binary, so a divergence between the two rows fails a test instead of surfacing as a corrupt channel.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [infra-requirements.dsh.md](../../../infra-requirements.dsh.md) — §11 item 4 (this package), §5.3 (the channel and its echo rule), §5.4 (why the worker is resident), and §8.2 (credential passthrough to a nested harness).
- [`infra/scripts/worker.sh`](../../../infra/scripts/worker.sh) — the shell implementation of the same launch contract.
- [`@dsh-fleet/tmux`](../tmux/src/index.ts) — the channel that owns placement, the frame log, and the readiness wait.
- [`@dsh-fleet/subagent-tmux`](../subagent-tmux/src/index.ts) — the delegation provider that drives a launched pane.

-----

<a id="model-experience"></a>
## Model Experience

### Worker launch

#### What the model sees

Nothing. `ctx.workerTemplate` registers no tools and injects no prompt text; `launch()` starts a process and reports its command and environment to the launcher.

#### Token effect

Zero direct tokens on every request. The worker started in the pane runs its own harness and owns its own token use.

#### KV Cache effect

Independent of live requests: launching or reusing a pane changes no request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what this template cannot do. They are current constraints, not a task backlog.

- **The pane's effective environment can hold more than the reported `env`.** `@dsh-fleet/tmux` layers the entries this package passes over its own configured `credentialEnv` allowlist and its own `DSH_HOME`. The returned `env` is exactly what this template handed the placement; a deployment that configures the channel row differently adds entries this report does not list. Configure both rows from one source.
- **The two rows cannot be checked against each other.** `ctx.tmux` publishes no reader for its `dshBin`, `profile`, `patches`, or `dshHome`, so a template configured with a different profile than the channel launches a pane running the channel's line while reporting its own. The spec pins the pairing for identical configuration; a divergent deployment is undetectable here.
- **`enableStty: false` is unrepresentable.** The channel's pane command always carries `stty -echo -icanon`, so the option is refused at load rather than silently ignored. A deployment that genuinely needs a pane without echo suppression must place it outside this template.
- **Confirmation is a liveness check, not a handshake.** The template confirms that the placed pane exists through `ctx.tmux.alive`; the SDK `initialize` handshake that proves the harness is serving belongs to the caller (`@dsh-fleet/subagent-tmux` performs it).
- **A reused pane is not re-verified beyond the channel's own check.** `resident` reuse returns the pane the channel considered alive; the template does not additionally probe the worker's protocol endpoint.
- **`extraEnv` values are forwarded verbatim, including empty strings.** Only the credential allowlist omits an absent variable; an explicit pair is the caller's stated value, and dropping it would silently change what the deployment asked for.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Single configuration source** — the clean fix for the duplicated `profile`/`patches`/`dshBin`/`dshHome` values is a channel-side reader (or one shared config row) so the template can assert equality at load instead of documenting it.
- **Launch-line ownership** — the template mirrors the channel's pane command because the channel does not export its builder; exporting it from `@dsh-fleet/tmux` would remove the mirror and the spec's argv assertion could then compare two calls of one function.
- **Cross-machine panes** — the tmux gateway (§11 item 3) will decide whether a launch ever happens on another machine; this template currently assumes the pane is local.

</details>

**Runtime invariant:** No companion is published. The service owns one resolved configuration and one placement call; there is no relationship between independent observations that could diverge, so an invariant companion would only restate service presence.
