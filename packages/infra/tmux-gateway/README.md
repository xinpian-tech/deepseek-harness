---
description: "A TCP-to-unix-socket bridge that makes one machine's tmux server reachable from another, with a kernel-assigned port, and the plaintext, unauthenticated trust boundary that comes with it."
kind: "package-reference"
---

# @dsh-fleet/tmux-gateway

English | [中文](README.zh.md)

## Summary

`@dsh-fleet/tmux-gateway` makes one machine's tmux server reachable from another machine: `serve()` binds a TCP listener and forwards every accepted connection to the local tmux unix socket, and `dial()` connects to such a bridge elsewhere. The port defaults to `0`, so the kernel assigns a free one and `address()` publishes what was bound; `close()` stops serving and drops the live connections. The bridge is plaintext and unauthenticated by design, which is acceptable only inside the fleet's controlled boundary (§13) and must never be exposed outside it.

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

Mount this row on a machine whose tmux server other machines must reach, then serve the bridge and publish the address it bound; the peer dials that address and drives the remote tmux server over the returned socket.

### When to choose it

Choose it when the fleet spans machines and a pane on one of them must be reached from another, because tmux itself has no network transport: its server listens on a unix socket that only local clients can open (§5.3). It is not needed in a single-machine composition, where [`@dsh-fleet/tmux`](../tmux/README.md) spawns a local tmux client and no bridge takes part. The cost is explicit: the bridge carries tmux traffic in the clear and authenticates nobody (§13), so it belongs only on networks the fleet already controls end to end.

### Minimal configuration

```yaml
- id: fleet-tmux-gateway
  name: '@dsh-fleet/tmux-gateway'
  config:
    enabled: true
    socketPath: /tmp/tmux-1000/default
    host: 127.0.0.1
    port: 0
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Whether this machine serves a bridge at all; `serve()` refuses while it is false |
| `socketPath` | required | Absolute path of the tmux server socket this bridge forwards to |
| `host` | `127.0.0.1` | Interface to bind |
| `port` | `0` | TCP port to listen on; `0` asks the kernel for a free one |
| `connectTimeoutMs` | `5000` | Bound (ms) on `dial()`; only the dialing side reads it |
| `maxConnections` | `16` | Concurrent connections the listener accepts |

The generated [configuration catalog](../../../docs/config-catalog.md#dsh-fleettmux-gateway) is the exhaustive field list with its source declaration. A missing or relative `socketPath` fails the load.

### Serving and dialing

`serve()` binds the listener and returns the address it bound, so a deployment that configured `port: 0` learns the kernel-assigned port from the return value or from `address()`. The call is idempotent: serving twice returns the address already in use rather than binding a second listener. `connections()` reports how many connections the bridge currently carries, `close()` stops serving and destroys them, and disposing the plugin's fiber closes the bridge through the service's own effect.

### The trust boundary

The bridge is plaintext and unauthenticated: there is no TLS, no token, and no peer identity check, so anything that can open the TCP port reaches the tmux server behind it and can drive every session on that machine. The default `host` is loopback for that reason. Binding a routable interface is a deliberate deployment decision that must stay inside the fleet's controlled boundary; a machine reachable from outside it must not serve this bridge at all.

### Failures and recovery

A `serve()` that cannot bind rejects with the listener's own error, and a `dial()` that gets no answer within `connectTimeoutMs` rejects with `tmux-gateway: <host>:<port> did not answer in time`. When the upstream unix socket cannot be reached — tmux is not running, or `socketPath` names something else — the bridge logs `tmux-gateway: upstream <socketPath> failed: <message>` and closes both halves of the connection, so a caller observes a closed connection instead of a half-open one that never answers.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The bridge splices bytes rather than translating the protocol: a TCP listener accepts a connection, opens the configured unix socket, and pipes each direction into the other, so a remote tmux client speaks its own protocol unchanged and no tmux framing is parsed or validated here. That is what makes a remote pane indistinguishable from a local one at the socket level, and it is also why the trust boundary, not the code, keeps the bridge safe.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`, load-time validation, listener lifecycle, byte splice, `dial()`, fiber-owned shutdown |

### Listener lifecycle

The listener is created on `serve()`, never at mount, so a row that merely exists binds nothing. Its address is published only after `listening` fires, which is why `port: 0` is safe: the returned port is the one the kernel assigned, not the requested zero. A close destroys every live connection first and then closes the listener, and the same path runs when the mounting fiber is disposed.

### Connection handling

Each accepted connection is tracked until either side closes or errors; an upstream connect failure warns and drops both sockets, which is the only signal a caller gets for a wrong `socketPath`. The splice attaches no timeout to an established connection, and the upstream connect has no timer of its own: `connectTimeoutMs` bounds `dial()` alone.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fleet requirements](../../../infra-requirements.dsh.md) — §5.3 for cross-machine tmux, §11 item 3 for this row, and §13 for the accepted plaintext trade-off.
- [`@dsh-fleet/tmux`](../tmux/README.md) — the channel whose panes this bridge makes reachable.
- [Generated configuration catalog](../../../docs/config-catalog.md#dsh-fleettmux-gateway) — every accepted config field and its source declaration.
- [Architecture](../../../docs/architecture.md) — the plugin model this row follows.

-----

<a id="model-experience"></a>
## Model Experience

### Cross-machine bridge

#### What the model sees

Nothing directly: no tool schema, no prompt section, and no session event. The bridge carries a remote tmux server's bytes, and its failures reach a model only through the consumer that dialed it — today nothing in the fleet calls `ctx.tmuxGateway.dial()`, and [`@dsh-fleet/tmux`](../tmux/README.md) drives local panes, so no request text crosses this service.

#### Token effect

Zero direct tokens on every request. The frames the bridge carries belong to the sessions that send them, and the bridge neither reads nor rewrites either direction of the splice.

#### KV Cache effect

Independent of live requests: serving, dialing, or closing a bridge changes no request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current constraints of the bridge and the decisions behind them, not a task backlog.

- **Plaintext and unauthenticated** — there is no TLS, no credential, and no peer check, so anything that reaches the port can drive every tmux session on the machine. §13 accepts that inside the fleet's controlled boundary and forbids it outside; a deployment that exposes this bridge breaks the assumption §13 records.
- **The default bind is loopback** — a cross-machine deployment must set `host` to a routable interface deliberately, and nothing verifies that the chosen interface is inside the controlled boundary.
- **No shipped consumer dials a remote bridge yet** — the service exposes `serve()` and `dial()`, while `@dsh-fleet/tmux` spawns a local tmux client, so a pane on another machine is not reachable end to end through the fleet today.
- **The assigned port is published, not persisted** — with `port: 0` the kernel may assign a different port on every `serve()`, and `address()` is the only place the current one exists; whoever needs a peer to reach this bridge must record it.
- **One upstream socket per row** — the bridge forwards to exactly one `socketPath`, so reaching tmux servers on two machines needs one row and one listener per machine.
- **`connectTimeoutMs` bounds `dial()` alone** — the upstream connect a served bridge performs has no timer of its own, so that option does not bound it even though its declaration names the upstream connection.
- **`socketPath` is only checked for absoluteness** — the load rejects a missing or relative path, and a path that is not a tmux server socket is discovered only when a connection's upstream fails and the caller sees a closed connection.
- **Nothing bounds an established connection** — `maxConnections` caps how many the listener accepts and `connections()` counts them; there is no idle timeout, no per-connection identity, and no rate limit, so one open connection may hold the bridge as long as it likes.
- **Serving is always explicit** — mounting the row binds nothing, and `enabled: false` makes `serve()` throw `@dsh-fleet/tmux-gateway is disabled; set enabled: true to serve the bridge` rather than binding quietly.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **The remote-pane path is unfinished.** Wiring `ctx.tmux` to a bridge address — a remote placement, a remote frame log, or a per-machine channel — is the open part of §11 item 3; until it exists the gateway is a tested transport with no consumer.
- **An authenticated variant would change `dial()`.** A handshake before the splice, or a tunnel, would replace the plaintext stance rather than add to it; §13 records the stance as an accepted trade-off, so this is a deployment decision, not a defect.
- **The spec substitutes an echo socket for tmux.** The bridge is exercised against a unix socket that echoes every byte, so the splice, the dynamic port, and the teardown are verified without a tmux server; protocol behavior belongs to tmux.

</details>

**Runtime invariant:** No companion is published. The service owns one listener and one set of live connections, both created by `serve()` and dropped by `close()` or by the mounting fiber; no second observation of that state exists inside the process, so a companion would only restate service presence.
