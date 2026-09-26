# Fleet 组合

[English](fleet.md) | 中文

fleet 组合是 [`packages/infra/`](../../packages/infra/README.zh.md) 及其 [`@dsh-fleet/bundle`](../../packages/bundle/fleet/README.zh.md) 加在 dsh profile 上的部署层：agent 以 tmux pane 的形式运行在部署方控制的机器上，委派保持调用-返回语义，全部依赖来自同一个 Nix flake。[infra-requirements.dsh.md](../../infra-requirements.dsh.md) 拥有需求本身及其不变量 R-0 至 R-8；每个包的 README 拥有该包的配置、服务契约与已知限制。本页记录该组合的两条通道、每个包强制的不变量、组合它的 patch 文档，以及它刻意留下的缺口。

## 通道

R-6 在 agent 之间只承认两条通道，二者职责不重叠。tmux 承载全部实时内容——派活、纠偏、进度与完成通知——以换行定界的 JSON-RPC 帧写入 pane 的 stdin，并从它的 `pipe-pane` 日志读回。git 承载全部持久内容——任务、结果、产物与 session 归档——以按机器分片的 ref 推送 commit。不存在第三条通道，也不存在 agent 之间私有的 harness 通道。

| Channel | Carries | Mechanism | Owning package |
|---|---|---|---|
| tmux | 派活、纠偏、进度、完成通知 | 经 `send-keys -l` 写入、经 `pipe-pane` 读出的 NDJSON 帧 | [`@dsh-fleet/tmux`](../../packages/infra/tmux/README.zh.md)、[`@dsh-fleet/subagent-tmux`](../../packages/infra/subagent-tmux/README.zh.md) |
| git | 任务、结果、产物、session 归档 | 每个停止的 turn 一次 commit、重试到成功的 push、按机器分片的 ref 命名空间 | [`@dsh-fleet/git-checkpoint`](../../packages/infra/git-checkpoint/README.zh.md)、[`@dsh-fleet/session-archive`](../../packages/infra/session-archive/README.zh.md) |

R-7 限制两条通道上允许流动的东西。一方发起调用、等待、拿回结构化返回值；在对方未发起的情况下把内容异步投递进它的上下文，就是消息传递，不属于本组合。成员是 pane 里常驻的 `dsh --profile sdk` 进程，因此想继续同一段对话的调用方会用同一个 pane key 再次调用，而不是去续接一个子 agent。因为 `session/prompt` 确认的是入队而不是完成，调用方从子 agent 自己的事件流得知一次运行已经结束。

两条通道都不重投。pane 消失时调用失败，调用方走自己的纠偏回环；这里没有消息存储，也没有可投递的兜底邮箱。

## 不变量

下列每条不变量由它旁边列出的包强制；没有任何包能强制的部分，由 fleet 中承担该职责的环节负责。

| Invariant | What the composition requires | Where it is enforced |
|---|---|---|
| R-0 | 自定义只以新包与 profile patch 行的形式存在；不修改任何上游文件 | [`@dsh-fleet/bundle`](../../packages/bundle/fleet/README.zh.md) 中的两份 patch 文档 |
| R-1 | 每层上报它完成了什么、证据在哪、需要什么 | [`@dsh-fleet/task-spec`](../../packages/infra/task-spec/README.zh.md) 把验收变成未通过项列表；其余由该层自己的上报承载 |
| R-2 | 验收标准机器可判、作为 durable 数据随任务下传、只能细化不能改写 | [`@dsh-fleet/task-spec`](../../packages/infra/task-spec/README.zh.md) |
| R-3 | `Ln` 判 `Ln+1`，因此根只理解它的直接子层 | 没有包：由委派树与任务树承载 |
| R-4 | 纠偏唤醒原 agent，而不是重开一个 | [`@dsh-fleet/tmux`](../../packages/infra/tmux/README.zh.md) 的 placement 与 [`@dsh-fleet/subagent-tmux`](../../packages/infra/subagent-tmux/README.zh.md) 的常驻会话 |
| R-5 | 每个 turn 在无网络访问下本地 commit；push 异步重试，直到一次最终 push 阻塞等待 | [`@dsh-fleet/git-checkpoint`](../../packages/infra/git-checkpoint/README.zh.md)、[`@dsh-fleet/session-archive`](../../packages/infra/session-archive/README.zh.md) |
| R-6 | 只有 tmux 与 git 在 agent 之间承载内容 | [`@dsh-fleet/tmux`](../../packages/infra/tmux/README.zh.md)、[`@dsh-fleet/git-checkpoint`](../../packages/infra/git-checkpoint/README.zh.md)、[`@dsh-fleet/session-archive`](../../packages/infra/session-archive/README.zh.md) |
| R-7 | 只有调用-返回语义；不向另一个 agent 的上下文投递 | [`@dsh-fleet/subagent-tmux`](../../packages/infra/subagent-tmux/README.zh.md) 与移除层 |
| R-8 | 依赖只来自 flake、产物可丢弃、不依赖任何机器状态 | [`@dsh-fleet/nix-shell`](../../packages/infra/nix-shell/README.zh.md) 与 [`@dsh-fleet/nix-mandate`](../../packages/infra/nix-mandate/README.zh.md)；confinement 由 [`@dsh-fleet/nix-sandbox`](../../packages/infra/nix-sandbox/README.zh.md) 提供，它以替换 base 沙箱行的方式挂载 |

其余各包记录不变量所需的事实：[`@dsh-fleet/machine-registry`](../../packages/infra/machine-registry/README.zh.md) 提供按机器分片的 ref 与 placement 记录所依据的身份，[`@dsh-fleet/config-generation`](../../packages/infra/config-generation/README.zh.md) 提供解释一次执行的 flake 指纹，[`@dsh-fleet/prompt-source`](../../packages/infra/prompt-source/README.zh.md) 让 leader 的指令在 session 日志里仍能与人的消息区分，[`@dsh-fleet/worktree`](../../packages/infra/worktree/README.zh.md) 隔离一个任务的 N 个候选，[`@dsh-fleet/ledger`](../../packages/infra/ledger/README.zh.md) 保存下次派活所依据的记录。

## 组合层

组合由两份 patch 文档构成，二者之间的顺序是契约的一部分。[`no-messaging.cordis.patch.yml`](../../packages/bundle/fleet/no-messaging.cordis.patch.yml) 先应用：它关闭把消息投递进另一个 agent 上下文的行，并把委派工具重新指向 tmux provider。[`cordis.patch.yml`](../../packages/bundle/fleet/cordis.patch.yml) 随后应用：它插入 fleet 各行，并改动 base 组合已经挂载的两个条目。

这两处改动是替换，不是新增。`sandbox-policy` 接收 `profile: nix-only`，`bash-sandbox` 被禁用，使插入的 `nix-shell` 行成为唯一的 `ctx.shell` provider；一个组合只持有一个 shell executor，而 fleet 的 executor 就是在 flake 内运行每条命令的那个。这些命令所受的 confinement 来自 [`@dsh-fleet/nix-sandbox`](../../packages/infra/nix-sandbox/README.zh.md)：它替换 base 的 `sandbox` 行来注册 `ctx.sandbox`；挂载它是部署方的改动，本组合层并不执行。更晚的组合包层、profile 自己的 patch，或启动器 `--patch` 覆盖层，按行 id 压过这两份文档。

## 刻意移除

移除层是 R-7 从一条规则变成一组行的地方，被它移除的东西不会回来：本组合从不挂载经管道或在当前进程内驱动子 agent 的 provider，也不挂载任何向子 agent 的 inbox 投递的工具。具体后果是：

- **消息投递不存在。** `send_message` 与 `interrupt_agent` 未挂载，因为二者都在子 agent 未发起的情况下投递进它的 inbox。中断仍然存在，形式是向调用方自己打开的那个 pane 发信号。
- **continuable 子 agent 不存在。** 子 agent 不靠投递续接；调用方在常驻 pane 上再次调用它，而 `list_agents` 未挂载，因为没有 continuable 子 agent 时它渲染的列表为空。
- **agent-team 插件不存在。** 它的 roster、task board 与 mailbox 都是 dsh 内部的消息传递，因此本组合不挂载它。
- **没有任何兜底邮箱接替它们。** 没有东西保存未投递的消息，也没有调用会在之后被重放；pane 消失的调用方观察到失败并走自己的纠偏回环。

投递原语本身留在 harness 里：`agent.followup()`、`steer()` 与 inbox 服务于 Web UI 和 `session/prompt`，因此人仍然能给 agent 发消息。本组合移除的是从一个 agent 到另一个 agent 的路径。

## 各行的来源

两份文档中的每一行都指向 [`packages/infra/`](../../packages/infra/README.zh.md) 下的一个包，十五个包覆盖需求 §11 改造清单的十七个条目。[`infra/fleet.manifest.json`](../../infra/fleet.manifest.json) 保存这份对应关系；`infra/nix/fleet.nix` 会拒绝指向目录树中不存在包的清单，因此清单不会与本页描述的包发生漂移。
