---
description: "The machine registry (ctx.machines) for fleet compositions and maintainers resolving, recording, or auditing which host a durable record belongs to."
kind: "package-reference"
---

# @dsh-fleet/machine-registry

English | [中文](README.zh.md)

## Summary

Use `dsh-machine-registry` to give every process on a fleet host one stable machine identity. Mount it, read `ctx.machines.current()` for the hostid, alias, and nix system of the machine this process runs on, and let it record that identity as a durable `machine/context` session event whenever a session is announced. Choose it before any plugin that writes a per-machine durable record: §7.2 shards session archive refs, placement records, and the performance ledger by this id, so an unresolvable or unstable id silently corrupts every one of them. It is available only to host code and has no model-visible effect.

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

Mount the service once per process, in the fleet composition, before anything that records durable state:

```yaml
- id: fleet-machine-registry
  name: '@dsh-fleet/machine-registry'
  config:
    registryFile: /var/lib/dsh-fleet/machines.json
    alias: worker-07
```

### When to use it

Mount it on every machine of the fleet. A composition that writes no per-machine durable record can omit it, but any plugin that needs a sharding id then has to resolve one itself, which is the duplication this package exists to prevent.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `machineId` | resolved (see below) | Explicit machine id; wins over every other source |
| `alias` | absent | Human-readable label reported by `current()` |
| `registryFile` | absent | Absolute path of the durable JSON registry `list()` reads through |
| `nixSystem` | platform triple | Nix system override for a host the platform table cannot spell |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc.

### Machine id resolution

The order matches `infra/scripts/machine-id.sh` exactly, so the plugin and the fleet's shell tooling always agree on one host:

1. `machineId` from this plugin's configuration.
2. `DSH_FLEET_MACHINE_ID` from the process environment.
3. `/etc/machine-id`, then `/var/lib/dbus/machine-id` — the systemd hostids, read in that order.
4. The hostname, for hosts without systemd.

Whitespace is stripped from every candidate, an empty candidate falls through to the next source, and the result must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` — the id becomes a git ref path segment (`refs/dsh/machines/<id>/…`) and a registry key, so an id that cannot name one is a load failure rather than a silent rewrite.

### Nix system resolution

`nixSystem` from configuration wins. Without it the triple is derived from `process.platform` and `process.arch` in nix's own spelling: `linux-x64` → `x86_64-linux`, `linux-arm64` → `aarch64-linux`, `linux-arm` → `armv7l-linux`, `darwin-x64` → `x86_64-darwin`, `darwin-arm64` → `aarch64-darwin`. Any other pair throws at load: a host that cannot spell its own nix system cannot build the flake it would run, and a guessed triple would be written into every durable record of that machine.

### What you get

- `current(): MachineContext` — `{ id, alias?, nixSystem, hostname }` as plain JSON, frozen, resolved once at load. `hostname` is the observed hostname and is diagnostic context only; it is never an identity input.
- `list(): readonly MachineContext[]` — the entries of the configured registry file, read through on every call. Nothing is derived, cached, or added, so the machine this process runs on appears only if the file lists it. Without a configured `registryFile` the call throws instead of implying an empty fleet.
- A durable `machine/context` session event on every session announcement, carrying exactly `current()`.

### Registry file

`registryFile` is a JSON object; `machines` lists the fleet's machines in file order:

```json
{
  "machines": [
    { "id": "3f2a1c…", "alias": "worker-07", "nixSystem": "x86_64-linux", "hostname": "worker-07" }
  ]
}
```

`id`, `nixSystem`, and `hostname` are required non-empty strings, `alias` is optional, and one id may appear only once. A relative path, an unreadable file, malformed JSON, a malformed entry, or a duplicated id is a load failure; a file that becomes malformed while the process runs fails the `list()` call that reads it.

### Failures and recovery

Load fails on a relative or unreadable `registryFile`, an unknown platform triple, an empty configured `alias`/`nixSystem`, or a resolved id that cannot name a ref segment. Every one of those is a self-contained configuration error, so the process refuses to start rather than recording a wrong or missing sharding id. Once loaded, the service performs no IO of its own: `current()` cannot fail, and only `list()` touches the registry file again.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **One identity per host, resolved once.** The id and nix system are resolved in the constructor and frozen, so no later call can depend on a mutable environment or cwd.
- **Durable record at the announcement.** The identity is appended to each session's log when the session is announced, before any turn can produce a record that needs the sharding id.
- **The registry is an observation surface.** Entries come from the file and nowhere else; `current()` never consults it, so a fleet's registry and a host's own identity cannot drift into each other.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, id and nix-system resolution, registry validation, session recording |
| [`src/types.ts`](src/types.ts) | `MachineContext`, the registry file type, and the `machine/context` event declaration |

### Identity resolution

`resolveMachineId()` takes its sources as an argument, so the resolution order is exercised without touching `/etc` and the shell resolver's behavior is reproducible in tests. `readRegistry()` is the only reader of the durable file; it validates shape, required fields, and duplicate ids on every call.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [infra-requirements.dsh.md](../../../infra-requirements.dsh.md) — §11 item 10 (this package), §7.2 (refs sharded by machine id), and §10 (`MachineId = hostid`).
- [machine-id.sh](../../../infra/scripts/machine-id.sh) — the shell resolver whose order this package matches.
- [fleet.nix](../../../infra/nix/fleet.nix) — the `configGeneration` record and the fleet runtime this composition ships in.

-----

<a id="model-experience"></a>
## Model Experience

### Machine identity registration

#### What the model sees

Nothing. The service registers no tools and injects no prompts. The `machine/context` session event is log-only: it is a durable record, not a model-visible surface, so no request ever carries the machine id.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: no request prefix changes when a machine identity is resolved or recorded.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the registry cannot do. They are current package constraints, not a task backlog.

- **Sessions announced before this plugin mounts carry no `machine/context` event** — the recorder is a `session/created` listener, so a session already in the store when the plugin loads keeps whatever machine record it had.
- **`list()` reads the file per call** — the registry is durable state another process may rewrite; there is no cache and no change notification, and a malformed rewrite fails the next `list()`.
- **No cross-machine verification** — nothing checks that two hosts do not resolve the same id; `DSH_FLEET_MACHINE_ID` is the fleet operator's contract for making ids unique, as in the shell resolver.
- **The nix system table covers the systems this repository builds for** (Linux x86_64/aarch64/armv7l, macOS x86_64/aarch64). Another host must state `nixSystem` explicitly or fail at load.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Registry writes** — nothing in this package writes the registry file; the fleet's provisioning or a later ledger package owns that write path.
- **Alias source** — the alias is configuration, not a registry lookup, so a host that is renamed in the registry keeps reporting its configured alias.

</details>

**Runtime invariant:** No companion is published. The service owns one immutable identity plus one listener; there is no relationship between independent observations that could diverge, so an invariant companion would only restate service presence.
