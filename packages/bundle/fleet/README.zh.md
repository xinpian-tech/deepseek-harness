---
description: "fleet profile 组合包：tmux-only 组合层，以及在 dsh-base 之上挂载的消息传递移除层。"
kind: "package-bundle"
---

# @dsh-fleet/bundle

[English](README.md) | 中文

## 概述

fleet profile 从本组合包只得到一件事：一个每个被委派 agent 都是 tmux pane、且没有任何行把消息投递进另一个 agent 上下文的组合。它的实质是两份 patch 文档——`no-messaging.cordis.patch.yml` 关闭消息传递相关的行，`cordis.patch.yml` 插入 fleet 各行并替换 shell executor。部署通过 fleet runtime 目录树分发这两份文档，而不是通过 registry。改动任一份文档前先读下面的层语义；[fleet 子系统页](../../../docs/subsystems/fleet.zh.md) 拥有它们实现的通道与不变量。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Where the layers come from

本包在 `dsh.bundle.patch` 中按如下顺序声明两份文档：先移除层，后组合层。一个组合包层会按该顺序拼接自己的 patch 列表，因此移除在 fleet 各行插入之前已经生效；更晚的组合包层、profile 自己的 `cordis.patch.yml`，或 `dsh --patch <path>` 覆盖层，仍按行 id 压过这两份文档。

[`infra/nix/fleet.nix`](../../../infra/nix/fleet.nix) 是一台机器获得它们的方式：它把本 README 旁边的每个 `.yml` 安装到 `$out/share/dsh-fleet/profiles/`，并把 fleet 启动组合为 base 加 fleet。本包是私有的、没有已发布版本，因此 `dsh plugin --profile <name> add @dsh-fleet/bundle` 不是它的安装路径。把本组合包从 profile 移除会一并移除 fleet 各行，并让被移除的行回到组合中。

### What you get

组合层插入十三行：`fleet-config-generation`、`fleet-machine-registry`、`fleet-task-spec`、`fleet-tmux`、`fleet-subagent-tmux`、`fleet-tmux-gateway`、`fleet-worker-template`、`fleet-session-archive`、`fleet-git-checkpoint`、`fleet-worktree`、`fleet-ledger`、`fleet-prompt-source` 与 `fleet-nix-mandate`。每一行贡献什么由该行的包拥有；[infra 分组地图](../../infra/README.zh.md) 把它们对应到需求项。

另外两个条目改的是 base 组合已经挂载的行，而不是新增行：`sandbox-policy` 被参数化为 `profile: nix-only`，`bash-sandbox` 被禁用，于是插入的 `fleet-nix-shell` 行成为唯一的 `ctx.shell` provider——一个组合只能有一个 shell executor，而那个 executor 必须是在 flake 内运行命令的那个。

移除层禁用九行、把四个委派行重新指向 tmux provider，且不新增任何行。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现内部细节——点击展开</summary>

### The removal layer

下面每一行都是被关闭，而不是在上游删除，这正是 R-0 隔离的实际含义：fleet 从不修改 base 组合。

| Row | Disabled because |
|---|---|
| `subagent-spawn-in-process`、`subagent-fork-in-process` | 同进程子 agent 不是 tmux pane。 |
| `subagent-codex`、`subagent-claude-code`、`subagent-acp`、`subagent-dsh-sdk` | 每个都经 stdio 管道驱动子进程；管道不是 tmux pane。 |
| `tool-subagent-control` | `send_message` 与 `interrupt_agent` 在子 agent 未发起的情况下投递进它的 inbox。 |
| `tool-subagent-list-agents` | 它列出 continuable 子 agent，而移除之后这个列表为空。 |
| `agent-team` | roster、task board 与 mailbox 都是 dsh 内部的消息传递。 |

该层列出的 provider 行，某个基于 base 的 profile 可能并未挂载。匹配不到任何行的 patch 条目会打印警告并被跳过，因此这些移除条目始终保留，并对每个基于 base 的 fleet profile 生效。

### The repointed rows

`tool-subagent`、`tool-subagent-fork`、`workflow-ptc` 与 `tool-ralph` 保持挂载，并在配置中接收 tmux provider。委派工具保留调用-返回语义——调用方启动子 agent 并拿回结果——但它们唯一能解析到的 provider，是子 agent 位于 pane 中的那个。`tool-subagent` 与 `tool-subagent-fork` 另外带上 `backgroundMode: one-shot`，因为 continuable 子 agent 靠一次 inbox 投递续接，而 fleet worker 靠在自己的常驻 pane 上被再次调用来续接。

### The composition layer

插入列表按每一行所属的部分分组：先是身份与执行指纹，然后是任务契约，接着是实时通道、持久通道、审计缺口，最后是 Nix 强制相关的行。文档内的加载顺序就是各行出现的顺序。

这两处替换是本组合包对它并不拥有的行所做的唯一改动，各自只有一个原因。沙箱行参数化 base 的 confinement 各行所强制的 profile；bash executor 行被禁用，是因为 fleet 替换了那唯一的 `ctx.shell` provider，而不是因为不想要沙箱化的执行。

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 组合层：插入的行、sandbox profile 取值与 shell executor 替换，逐行理由以行内注释给出 |
| [`no-messaging.cordis.patch.yml`](no-messaging.cordis.patch.yml) | 移除层：被禁用的行，以及重新指向 tmux 的委派行 |
| [`src/index.ts`](src/index.ts) | 包入口；不承载运行时 API |
| [`package.json`](package.json) | 声明 `dsh.bundle.patch`，其顺序决定层的顺序 |

本包不发布不变式伴随包：它是静态的 patch 列表载体，每一行的不变式由该行的包拥有。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fleet composition](../../../docs/subsystems/fleet.zh.md) —— 两条通道、每一行强制的不变量，以及组合刻意省略的东西。
- [Infra group map](../../infra/README.zh.md) —— 这些行挂载的包。
- [Bundle package map](../README.zh.md) —— 其他可安装的 profile 层。
- [app-boot profile section](../../boot/app-boot/README.zh.md) —— profile 如何组合各 bundle、它自己的 patch 与启动器覆盖层。
- [Fleet requirements](../../../infra-requirements.dsh.md) —— 本组合包实现的 §11 改造清单与 §12 移除清单。

-----

<a id="model-experience"></a>
## 模型体验

### Fleet tool set

#### 模型看到的内容

fleet profile 中的模型看到委派工具 `subagent`、`subagent_fork`、`workflow` 与 `ralph` 解析到 tmux provider，并且完全看不到 `send_message`、`interrupt_agent` 或 `list_agents` 工具。`nix-mandate` 规则以 order 700 的 system prompt 段落到达模型，它的 shell 命令经 `nix develop -c` executor 执行。每一行贡献的文本、schema 与结果由该行的包拥有；本组合包只决定存在哪些行。

#### Token 影响

本组合包不贡献任何自己的提示词文本与工具 schema。fleet profile 发出的 token 与仅 base 的 profile 之间的差异恰好就是这些行：被移除的工具释放它们的 schema 与用法文本，被插入的行加入自己的部分，其中 `nix-mandate` 为每个请求加入一个固定段落。

#### KV Cache 影响

在同一个组合内是追加式且稳定的：行集合在加载时固定，因此可复用的前缀不随请求或会话变化。改变组合包列表，或增加一个挂载/卸载其中某一行的 patch，都会改变工具块，并使该位置之后的缓存复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下是这两份文档当前的约束，不是任务积压。

- **两层总是一起生效** —— `dsh.bundle.patch` 把移除层与组合层声明为一个有序列表，因此 profile 无法在保留消息传递的同时拿到 fleet 各行。要重新启用某个被移除的行，必须在更晚的层里设置 `disabled: false`，并接受 R-7 禁止的语义。
- **匹配不到行的移除会警告并被跳过** —— 未挂载这九行中某一行的基于 base 的 profile，会为每个未匹配条目打印一条启动器警告。条目保留在列表中，以便同样的移除对每个基于 base 的 fleet profile 生效。
- **continuable 子 agent 无法续接** —— 委派工具上的 `backgroundMode: one-shot` 是有意的。整改一个 worker 意味着在它的常驻 pane 上再次调用它；该 pane 消失时调用即失败。
- **移除层携带的是九行，而不是 settlement 通知** —— 自动 settlement 投递在 base 组合中没有属于自己的行，因此没有任何 patch 条目能关闭它；委派工具以 one-shot 运行，也不会有 continuable 子 agent 被登记以待结算。
- **不存在经 registry 的安装路径** —— 本包是私有的、不可发布，因此 profile 只能从 fleet runtime 目录树或从一份检出中获得它，永远不通过 `dsh plugin add`。
- **nix-only 沙箱后端不在插入的行里** —— `@dsh-fleet/nix-sandbox` 通过替换 base 的 `sandbox` 行来注册 `ctx.sandbox`，本组合包并不做这件事，因此只加这一层的 profile 仍以 `dsh-sandbox-local` 作为 confinement 后端。本层确实改动的 `sandbox-policy` 行只声明 `mode` 与 `workspaceRoot`，因此在它上面设置 `profile: nix-only` 也会把 base 的 `DSH_PERMISSION_MODE` 默认值替换成 schema 默认值 `read-only`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者使用的工作上下文——点击展开</summary>

无。

</details>
