# Fleet Composition

English | [中文](fleet.zh.md)

The fleet composition is the profile layer that [`packages/infra/`](../../packages/infra/README.md) and its [`@dsh-fleet/bundle`](../../packages/bundle/fleet/README.md) add to a dsh profile: agents run as tmux panes on machines the deployment controls, delegation keeps call-return semantics, and every dependency comes from one Nix flake. [infra-requirements.dsh.md](../../infra-requirements.dsh.md) owns the requirement and its invariants R-0 to R-8; each package README owns that package's configuration, service contract, and limitations. This page records the composition's two channels, the invariant each package enforces, the patch documents that compose it, and what it deliberately leaves out.

## Channels

R-6 admits exactly two channels between agents, and their duties do not overlap. tmux carries everything real time — work assignments, corrections, progress, and completion notices — as newline-delimited JSON-RPC frames written into a pane's stdin and read back from its `pipe-pane` log. git carries everything durable — tasks, results, artifacts, and session archives — as commits pushed under per-machine refs. No third channel exists, and no harness-private channel between agents exists either.

| Channel | Carries | Mechanism | Owning package |
|---|---|---|---|
| tmux | Assignments, corrections, progress, completion notices | NDJSON frames in through `send-keys -l`, out through `pipe-pane` | [`@dsh-fleet/tmux`](../../packages/infra/tmux/README.md), [`@dsh-fleet/subagent-tmux`](../../packages/infra/subagent-tmux/README.md) |
| git | Tasks, results, artifacts, session archives | Commit per stopping turn, push retried to success, per-machine ref namespaces | [`@dsh-fleet/git-checkpoint`](../../packages/infra/git-checkpoint/README.md), [`@dsh-fleet/session-archive`](../../packages/infra/session-archive/README.md) |

R-7 restricts what may travel over either channel. One agent calls another, waits, and receives a structured return value; asynchronous delivery that publishes into another agent's context without that agent asking is message passing and is not part of the composition. A member is a resident `dsh --profile sdk` process in a pane, so a caller that wants the same conversation again calls the same pane key rather than resuming a child. Because `session/prompt` acknowledges enqueue rather than completion, a caller learns that a run finished from the child's own event stream.

Neither channel retries a delivery. When a pane is gone the call fails, and the caller runs its correction loop; there is no message store and no fallback mailbox to deliver from.

## Invariants

Each invariant below is enforced by the packages named beside it, or, where no package can enforce it, by the part of the fleet that does.

| Invariant | What the composition requires | Where it is enforced |
|---|---|---|
| R-0 | Customizations exist only as new packages and profile patch rows; no upstream file is edited | The two patch documents in [`@dsh-fleet/bundle`](../../packages/bundle/fleet/README.md) |
| R-1 | Every layer reports what it finished, where the evidence is, and what it needs | [`@dsh-fleet/task-spec`](../../packages/infra/task-spec/README.md) turns acceptance into a failed-item list; the layer's own report carries the rest |
| R-2 | Acceptance criteria are machine-decidable, travel with the task as durable data, and narrow rather than change | [`@dsh-fleet/task-spec`](../../packages/infra/task-spec/README.md) |
| R-3 | `Ln` judges `Ln+1`, so the root understands only its direct children | No package: the delegation tree and the task tree carry it |
| R-4 | A correction wakes the original agent instead of starting a new one | [`@dsh-fleet/tmux`](../../packages/infra/tmux/README.md) placement and [`@dsh-fleet/subagent-tmux`](../../packages/infra/subagent-tmux/README.md) resident sessions |
| R-5 | Every turn commits locally without network access; pushes retry asynchronously until one final push blocks | [`@dsh-fleet/git-checkpoint`](../../packages/infra/git-checkpoint/README.md), [`@dsh-fleet/session-archive`](../../packages/infra/session-archive/README.md) |
| R-6 | Only tmux and git carry anything between agents | [`@dsh-fleet/tmux`](../../packages/infra/tmux/README.md), [`@dsh-fleet/git-checkpoint`](../../packages/infra/git-checkpoint/README.md), [`@dsh-fleet/session-archive`](../../packages/infra/session-archive/README.md) |
| R-7 | Only call-return semantics; no delivery into another agent's context | [`@dsh-fleet/subagent-tmux`](../../packages/infra/subagent-tmux/README.md) and the removal layer |
| R-8 | Dependencies come only from the flake, outputs are discardable, and no machine state is required | [`@dsh-fleet/nix-shell`](../../packages/infra/nix-shell/README.md) and [`@dsh-fleet/nix-mandate`](../../packages/infra/nix-mandate/README.md); the confinement is [`@dsh-fleet/nix-sandbox`](../../packages/infra/nix-sandbox/README.md), mounted in place of the base sandbox row |

The remaining packages record facts the invariants need: [`@dsh-fleet/machine-registry`](../../packages/infra/machine-registry/README.md) supplies the identity that per-machine refs and placement records are keyed by, [`@dsh-fleet/config-generation`](../../packages/infra/config-generation/README.md) supplies the flake fingerprint an execution is explained by, [`@dsh-fleet/prompt-source`](../../packages/infra/prompt-source/README.md) keeps a leader's instruction distinguishable from a human's message in the session log, [`@dsh-fleet/worktree`](../../packages/infra/worktree/README.md) isolates the N candidates of one task, and [`@dsh-fleet/ledger`](../../packages/infra/ledger/README.md) holds the record the next assignment draws on.

## Composition layers

The composition is two patch documents, and the order between them is part of the contract. [`no-messaging.cordis.patch.yml`](../../packages/bundle/fleet/no-messaging.cordis.patch.yml) applies first: it switches off the rows that deliver a message into another agent's context and repoints the delegation tools at the tmux provider. [`cordis.patch.yml`](../../packages/bundle/fleet/cordis.patch.yml) applies second: it inserts the fleet rows and changes two entries the base composition already mounts.

Those two changes are substitutions, not additions. `sandbox-policy` receives `profile: nix-only`, and `bash-sandbox` is disabled so that the inserted `nix-shell` row becomes the only `ctx.shell` provider; a composition holds one shell executor, and the fleet's executor is the one that runs every command inside the flake. The confinement those commands run under comes from [`@dsh-fleet/nix-sandbox`](../../packages/infra/nix-sandbox/README.md), which registers `ctx.sandbox` in place of the base `sandbox` row; mounting it is a deployment edit, and this composition layer does not perform it. A later bundle layer, the profile's own patch, or a launcher `--patch` overlay outranks both documents per row id.

## Deliberate removals

The removal layer is where R-7 becomes a set of rows rather than a rule, and everything it removes stays removed: this composition never mounts a provider that drives a child over a pipe or inside the current process, and it mounts no tool that delivers into a child's inbox. The concrete consequences are:

- **Message delivery is absent.** `send_message` and `interrupt_agent` are not mounted, because both publish into a child's inbox without that child asking. Interrupting still exists as a signal to the pane the caller itself opened.
- **Continuable subagents are absent.** A child is not resumed through a delivery; the caller calls the resident pane again, and `list_agents` is not mounted because the list it renders is empty without continuable children.
- **The agent-team plugin is absent.** Its roster, task board, and mailbox are dsh-internal messaging, so the composition does not mount it.
- **No fallback mailbox replaces any of them.** Nothing stores an undelivered message, and no call is replayed later; a caller whose pane is gone observes the failure and runs its correction loop.

The delivery primitives themselves stay in the harness: `agent.followup()`, `steer()`, and the inbox serve the Web UI and `session/prompt`, so a human still sends messages to an agent. What the composition removes is the path from one agent to another.

## Where the rows come from

Every row in both documents names a package under [`packages/infra/`](../../packages/infra/README.md), and the fifteen packages cover the seventeen items of the change list in §11 of the requirement. [`infra/fleet.manifest.json`](../../infra/fleet.manifest.json) holds that mapping; `infra/nix/fleet.nix` refuses a manifest that names a package the tree does not contain, so the inventory cannot drift from the packages this page describes.
