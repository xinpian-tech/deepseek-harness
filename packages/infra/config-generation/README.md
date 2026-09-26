---
description: "The ConfigGeneration record (ctx.configGeneration) for fleet compositions and maintainers recording, digesting, or auditing the flake every execution ran under."
kind: "package-reference"
---

# @dsh-fleet/config-generation

English | [中文](README.zh.md)

## Summary

Use `dsh-config-generation` to record the exact inputs one harness process executed under: the flake it was launched from, the SHA-256 of that flake's `flake.lock`, the vendored `numtide/llm-agents.nix` revision and its nixpkgs revision, and the nix system. Mount it, read `ctx.configGeneration.current()` for the record, and let it append a durable `config/generation` session event whenever a session is announced. Choose it wherever a result must stay explainable after the fact: §8.1 makes one `flake.lock` the version fingerprint of the whole fleet. It is available only to host code and has no model-visible effect.

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

Mount the service once per process, in the fleet composition, before the first task can run:

```yaml
- id: fleet-config-generation
  name: '@dsh-fleet/config-generation'
  config:
    # All four fields are optional; a process launched from its own checkout
    # resolves the flake and both files without any configuration.
    harnessVersion: 0.1.7-rc.2
```

### When to use it

Mount it on every harness process of the fleet — control plane and worker alike — so every session log carries the revision it ran under. A composition that never needs to explain a past result can omit it, but then no record can distinguish a run of one flake revision from another.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `flakeUri` | launched flake | Flake reference the process reports; resolved from this field, then `DSH_FLEET_FLAKE_URI`, then the checkout this module lives in |
| `flakeLockPath` | `<flake root>/flake.lock` | Absolute path of the lock file whose bytes are hashed; a configured path must exist |
| `vendorRecordPath` | `<flake root>/infra/nix/vendor.json` | Absolute path of the vendored llm-agents record; a configured path must exist |
| `harnessVersion` | absent | Harness version this deployment pinned; recorded when set |
| `nixSystem` | host triple | Nix system this record describes, for a process recording a system other than its own |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc.

### Flake resolution

The default is the flake this process was launched from, obtained in this order:

1. `flakeUri` from this plugin's configuration.
2. `DSH_FLEET_FLAKE_URI` from the process environment — the launcher's statement of the same string `infra/nix/fleet.nix` computes as `configGeneration.flakeUri = "path:${fleetFlake.outPath}"`.
3. The nearest ancestor directory of this module that holds a `flake.nix`, reported as `path:<that directory>`. A harness run from source, and a package installed inside a checkout, both resolve to that checkout's root.

When none of the three exists the plugin refuses to load: it cannot name the flake, and a guessed URI would put a wrong revision into every record.

A `path:<absolute directory>` reference also anchors the other two paths. `flakeLockPath` defaults to `<that directory>/flake.lock`, and `vendorRecordPath` to `<that directory>/infra/nix/vendor.json`; each default applies only when the file exists, so a checkout without them yields a record with those fields absent rather than one pointing at nothing. A reference that names no local directory (an indirect or remote flake) leaves both unset.

### The record

`current()` returns plain JSON, frozen for the life of the process:

| Field | Source |
|---|---|
| `flakeUri` | Resolved flake reference (always present) |
| `flakeLockHash` | SHA-256 of the lock file's bytes, lowercase hex, computed once at load and memoized |
| `llmAgentsRev` | Vendored record `rev` |
| `llmAgentsNarHash` | Vendored record `narHash` |
| `nixpkgsRev` | Vendored record `nixpkgsRev` |
| `nixSystem` | `nixSystem` config, else the running host's triple in nix's spelling |
| `system` | The same triple under the name `infra/nix/fleet.nix` uses for `pkgs.stdenv.hostPlatform.system` |
| `harnessVersion` | `harnessVersion` config, when set |
| `recordedAt` | ISO-8601 timestamp of the load that resolved the record |

Every field except `flakeUri`, `nixSystem`, `system`, and `recordedAt` is omitted when this process cannot resolve it. A fingerprint with a placeholder component is worse than a missing one, and a lock file that is configured but missing is a load failure rather than an omitted field.

### Digest

`digest()` returns `sha256:` followed by the first 16 lowercase hex characters of the SHA-256 over the UTF-8 bytes of `JSON.stringify` applied to an object holding the resolved fields in this fixed order: `flakeUri`, `flakeLockHash`, `llmAgentsRev`, `llmAgentsNarHash`, `nixpkgsRev`, `nixSystem`, `system`, `harnessVersion` — with unresolved fields absent. `recordedAt` is deliberately excluded: it says when the record was read, not which environment it describes, so two runs of one revision digest equal and a task record can group them by attaching the digest.

### Session record

Every announced session receives one `config/generation` event carrying exactly `current()`, so a session's log quotes the flake revision it ran under without any consumer having to consult the runtime.

### Failures and recovery

Load fails on an empty configured `flakeUri`, `harnessVersion`, or `nixSystem`; on a relative configured path; on a configured lock or vendor path that does not exist; on a vendored record that does not parse, is not a JSON object, or carries a known field that is not a non-empty string; on a platform pair with no nix spelling; and when no flake URI can be resolved. After load the service performs no IO: `current()` and `digest()` cannot fail.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **One resolution, one timestamp.** Everything is resolved in the constructor, including the lock hash, so a lock that changes under a running process cannot retroactively relabel the executions that already ran under the old one.
- **Omission over invention.** Unresolvable components are absent from the record, never replaced by a placeholder or a substitute source.
- **The digest covers the environment, not the observation.** `recordedAt` is the only field outside the digest, which is what makes the digest usable as a grouping key for task records.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, flake and path resolution, lock hashing, vendored-record reading, digest |
| [`src/types.ts`](src/types.ts) | `ConfigGeneration`, the vendored-record type, and the `config/generation` event declaration |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [infra-requirements.dsh.md](../../../infra-requirements.dsh.md) — §11 item 12 (this package) and §8.1 (one `flake.lock` as the fingerprint, production pinning a release tag).
- [fleet.nix](../../../infra/nix/fleet.nix) — the `configGeneration` attrset whose fields this record reproduces at runtime.
- [vendor.json](../../../infra/nix/vendor.json) — the vendored llm-agents record this package reads.

-----

<a id="model-experience"></a>
## Model Experience

### Version-fingerprint registration

#### What the model sees

Nothing. The service registers no tools and injects no prompts. The `config/generation` session event is log-only: it is a durable record, not a model-visible surface, so no request ever carries the flake URI or lock hash.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: no request prefix changes when the record is resolved or logged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the record cannot do. They are current package constraints, not a task backlog.

- **A harness whose code lives outside a flake checkout must state its flake** — the module-anchored default finds nothing in a store path with no `flake.nix` above it, so such a deployment sets `flakeUri` or `DSH_FLEET_FLAKE_URI`; the shipped fleet composition mounts this row without configuration.
- **The lock hash is a snapshot of load time** — a process that outlives a lock change keeps reporting the hash it started with; that is deliberate, and a re-read would have to be a new record rather than a mutation of this one.
- **The vendored record is only as good as the file** — the package reads `rev`, `narHash`, and `nixpkgsRev` and never validates them against the vendored flake's own lock (the assertion `infra/nix/fleet.nix` makes at build time).
- **The host triple is derived independently of the machine registry** — `nixSystemFor()` here and `@dsh-fleet/machine-registry`'s `nixSystemFor()` share the table but not the code, because fleet packages cannot share a helper without a repository-wide alias entry (invariant R-0) or a workspace install that links one fleet package into another.
- **`recordedAt` is a wall-clock timestamp** — it is observation metadata, not part of the fingerprint, and clocks across the fleet are not synchronized.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Shared nix-system derivation** — a `@dsh-fleet/fleet-platform` helper, or a `paths` entry for fleet packages, would remove the duplicated table.
- **Reading the flake's own store path** — a launcher that exports `DSH_FLEET_FLAKE_URI` makes the environment source authoritative in production, which is the intended deployment once the runtime exports it.

</details>

**Runtime invariant:** No companion is published. The service owns one immutable record plus one listener; no independently observed relationship could diverge, so an invariant companion would only restate service presence.
