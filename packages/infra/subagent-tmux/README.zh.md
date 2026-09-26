---
description: "fleet 唯一的委派提供方：把每个子 agent 作为 tmux pane 内的 dsh 进程运行，按任务 key 选择 fresh 或 resident，并以子会话的 idle 状态判定一次运行完成。"
kind: "package-reference"
---

# @dsh-fleet/subagent-tmux

[English](README.md) | 中文

## 概述

`@dsh-fleet/subagent-tmux` 让每个被委派的子 agent 成为 tmux pane 里完整的 `dsh --profile sdk` 进程，它是 fleet 唯一的委派提供方。`fresh` 开始为一次调用新起 pane 与子会话，运行结束后回收；`resident` 开始为同一个任务 key 复用两者，因此纠偏轮次继续同一段对话，而不是重开一段。运行在子会话报告 idle 时完成，而不是在 prompt 的响应上完成，后者只表示已入队。该提供方只声明子路由这一项能力。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本行挂在 [`@dsh-fleet/tmux`](../tmux/README.zh.md) 旁边，并让委派工具指向它的 provider 名；此后每次 `agent()` 调用都会把子 agent 作为独立 harness 进程运行在自己的 pane 里。

### 何时选用

这是 fleet 唯一的委派提供方：进程内的 `spawn` 与 `fork` 提供方，以及四个 stdio 提供方，都在 fleet profile 里被关闭（§12），因为不是 pane 的子进程无法经由 fleet 唯一承认的通道触达（不变量 R-6）。凡是需要把工作委派给一个能比单次调用活得更久、能在工作时被观察、也能被中断的 agent，就选用它；当调用方会带着整改意见回到同一个 agent 时选用 `resident`，这正是纠偏回环能够收敛的原因（不变量 R-4）。在自身进程内完成委派的组合应保留基础提供方，因为一个 pane 的代价是一个进程、一份帧日志和一条启动命令。

### 最小配置

```yaml
- id: fleet-subagent-tmux
  name: '@dsh-fleet/subagent-tmux'
  config:
    providerName: tmux
    sessionMode: resident
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `tmux` | 在 `ctx.subagents` 上的注册名，也是每个委派工具解析的名字 |
| `sessionMode` | `fresh` | 一次开始的会话语义：`fresh` 新起子 agent，`resident` 续接该 key 的既有子 agent |
| `paneKeyPrefix` | `worker` | 本提供方派生的 pane key 前缀；必须是 tmux 安全名 |
| `cwd` | 委派会话的工作区 | pane 及其内部子会话的工作目录 |
| `provider` | `deepseek-official` | 子运行时初始化使用的路由，可按次开始覆盖 |
| `model` | `deepseek-v4-flash` | 子运行时初始化使用的模型，可按次开始覆盖 |
| `reasoningEffort` | 未设置 | 子路由由适配器拥有的推理强度 |
| `maxTokens` | 未设置 | 子运行时的输出 token 上限 |
| `env` | `{}` | 在通道白名单之上叠加、交给 pane 的额外环境变量 |
| `startTimeoutMs` | `120000` | pane 启动与 `initialize` 握手的上界（毫秒） |
| `turnTimeoutMs` | `0` | 单个子轮次的上界（毫秒）；`0` 表示无限等待 |
| `disposeGraceMs` | `5000` | 加载时校验；目前没有任何销毁路径读取它 |

生成的[配置目录](../../../docs/config-catalog.zh.md#dsh-fleetsubagent-tmux)是字段的完整清单，并带有其源码声明。以下情况会让加载失败：非正数的 `startTimeoutMs` 或 `disposeGraceMs`、负数的 `turnTimeoutMs`、空的或非 tmux 安全的 `paneKeyPrefix`；而相对路径或不可进入的 `cwd` 会在第一次开始时失败。

以本提供方为目标的委派工具必须把递归预算交给它：该提供方不声明 `depthLimit`，因此当某个 `tool-subagent` 行的深度解析为数字时，它会拒绝挂载并报出 `tool-subagent: provider "tmux" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`。

### fresh 与 resident

`fresh` 开始会放置自己的 pane，并只为这次运行创建子会话；运行被销毁时 pane 被释放，子 agent 不会留下任何东西。`resident` 开始根据委派会话 id 与任务 key（`request.label`，缺省时是父会话 id）派生同一个 pane key 与同一个子会话 id，因此同一对值的第二次开始会把 prompt 写进同一段对话，worker 保留此前轮次的上下文。常驻 pane 在空闲时能存活过销毁，这正是 R-4 得以成立的原因；运行被销毁时轮次仍未完成的常驻 pane 会收到 `INT` 中断，结果记录在委派会话上。

### 结果与失败

运行的输出是子 agent 最后一条非空 assistant 消息，若没有这样的消息则是它流式写出的文本。它的停止原因来自子 agent 自己的 `turn/end`：`completed`、`max-tokens`、`aborted`、`blocked` 记为 `refusal`、`error`，以及其他任何变体都记为 `error`。在运行发布之前失败的开始会释放 pane 并抛出，因此第一次尝试失败不会留下半放置的通道。发布之后的失败会让运行以 `stopReason: 'error'` 和一个诊断结束——`the tmux child did not finish its turn: <channel message>`，或者子 agent 报告了一个它并未完成的轮次时的 `the tmux child ended its turn without completing the work`——委派工具会把它渲染给调用方。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计理念

本提供方是两个 seam 之间的薄翻译层：`ctx.tmux` 拥有 pane、帧与放置记录，`ctx.subagents` 拥有开始请求、能力校验与已发布的运行。提供方补充的全部内容就是两者之间的映射——由委派身份派生的 pane key、对常驻 key 稳定的子会话 id、把路由交给子 agent 的 `initialize` 握手，以及折叠子 agent `session.event` 通知的 fold。运行句柄、取消接线与结果展平都来自 subagent seam 自带的辅助函数，因此本包不会另造一套生命周期。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`、加载期校验、提供方注册、开始、`initialize` 握手、子会话键控、销毁 |

### 一次开始的逐帧过程

提供方放置 pane，订阅该 key 的帧，并发送带有子 agent 的 cwd、provider、model 以及可选推理强度与 token 上限的 `initialize`；响应证明子运行时正在服务。随后它发送带有调用方内容块的 `session/prompt`，并等待该子会话的 idle 状态，其间折叠通道交付的每一条 `session.event` 通知。它观察到的最后一个 `turn/end` 原因成为运行的停止原因。销毁先退订，然后要么释放 `fresh` pane，要么让空闲的 `resident` pane 留在原地。

### 路由处理

`agentOptions` 是本提供方声明的唯一能力：新放置的 pane 可以用一条路由初始化，因此 `provider`、`model`、`reasoningEffort` 与 `maxTokens` 会按次开始覆盖配置默认值。被复用的常驻 pane 已经初始化过，所以第二次开始不得改变路由：不一致时开始会失败并报出 `subagent-tmux: resident pane <key> already runs <provider>/<model>; this start asked for <provider>/<model>`，因为在对话中途换模型等于报告一条子 agent 并未在运行的路由。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Fleet 需求](../../../infra-requirements.dsh.md)——§3 说明本提供方在拓扑中的位置，§4 说明不变量 R-4，§5.3 说明通道，§5.4 说明完成判定。
- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——本行实现的提供方契约、能力标志与运行句柄。
- [`@dsh-fleet/tmux`](../tmux/README.zh.md)——拥有放置、帧化与中断路径的通道。
- [生成的配置目录](../../../docs/config-catalog.zh.md#dsh-fleetsubagent-tmux)——每个可用配置字段及其源码声明。
- [架构](../../../docs/architecture.zh.md)——本行遵循的插件模型。

-----

<a id="model-experience"></a>
## 模型体验

### 被委派的子运行

#### 模型看到的内容

委派方的模型看到一个 `subagent` 工具结果：子 agent 的最终 assistant 输出，或者 seam 的失败行加上 `Diagnostic: <text>` 与运行结束前保留下来的部分输出。工具描述遵循本提供方的 `inheritsParentContext: false`，因此它告诉模型：子 agent "does not share this conversation's context, so include everything it needs"。子 agent 的模型只看到调用方传入的内容块以及它自己的组合，因为 pane 是独立进程，父历史不会被注入。模型可能读到的提供方自撰文本是 `the tmux child did not finish its turn: <channel message>` 与 `the tmux child ended its turn without completing the work`。

#### Token 影响

一次委派的每个 token 都计入拥有它的两个会话：prompt 内容块成为子 agent 的用户消息，子 agent 的最终 assistant 消息成为调用方的工具结果。提供方自身不增加提示词段落、工具 schema 或任何消息。

#### KV Cache 影响

在常驻对话内只追加：每一轮都把 prompt 追加到同一个子会话，因此子 agent 的提供方会复用它已经缓存的前缀，而 `fresh` 开始会开启一个新前缀。委派会话自身的前缀除了收到工具结果之外不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下是本提供方当前受到的约束及其背后的决定，不是待办清单。

- **pane 是拥有自身组合的独立进程**——本提供方无法注入父历史、过滤子 agent 的工具、设置子 persona，或在子进程内强制深度预算。它只声明 `agentOptions`，seam 会在开始之前拒绝任何其他被请求的能力，并报出 `subagent provider "tmux" does not support the "<capability>" capability`。
- **常驻 pane 不能改变路由**——握手对每个 pane 只执行一次，因此要求不同 provider 或 model 的常驻开始会失败，而不是在对话中途切换模型。
- **常驻是按 key 决定的，不是按调用选择的**——pane key 与子会话 id 由委派会话 id 与 `request.label ?? parent session id` 派生。共享这两者的两次开始共享同一个子 agent 与同一段对话，而只有 prompt 不同的两次开始仍会续接同一个子 agent；不同的任务需要不同的 label。
- **完成判定依赖子 agent 发布 idle**——`session/prompt` 返回的是入队回执，运行等待的是该子会话的 `session.status` idle 帧。在默认的 `turnTimeoutMs: 0` 下，停止发布通知的子 agent 会让运行无限期等待。
- **pane 消失时调用失败且不补投**——通道的消息会成为运行的诊断（`the tmux child did not finish its turn: pane for <key> disappeared during session/prompt`），重试由调用方的纠偏回环负责，因为 fleet 没有兜底邮箱（§5.3）。
- **完成的运行可能携带空输出**——fold 报告子 agent 最后一条非空 assistant 消息，或它流式写出的文本，因此只调用过工具或什么都没写的子 agent 会以没有输出块、也没有诊断的方式完成。
- **`disposeGraceMs` 没有读取方**——该选项在加载时被接受并校验，而销毁要么释放 `fresh` pane，要么立即中断 `resident` pane，因此配置的宽限目前不产生任何影响。
- **常驻只在一个 harness 进程内成立**——harness 重启后运行的纠偏轮次无法重新接上还活着的 pane，因为通道同一时刻只允许一个进程拥有某个 key；确定的子会话 id 因此只在该进程存活期间有用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与尚未确定的方向。它明确不具备权威性——已发布的行为与限制以上文各节和包内代码为准。

- **路由映射从不清理。** 每次 `initialize` 都会加入一个 key 条目，而 `fresh` pane 被释放时不会移除任何条目；增长量以进程一生中放置过的不同 key 数为界。
- **多条路径没有测试。** 测试覆盖了 fresh 运行、静默子 agent 与常驻复用；路由不一致、中止路径、初始化失败时的释放，以及 seam 的能力拒绝都没有测试验证。
- **子会话 id 在这里铸出，而不是由子 agent 铸出。** 常驻 id 是委派会话 id 与任务 key 的 SHA-256 的前 32 个十六进制位；pane 自己的会话 id 留在子进程内部，因此这两个 id 空间不会相遇。
- **prompt 不携带来源标记。** 被移除的 agent-message 来源类型（§11 第 5 项）意味着子 agent 无法只凭帧区分 leader 的指令与人的指令；`@dsh-fleet/prompt-source` 是拥有该区分的那一行。

</details>

**运行时不变式：** 不发布伴生模块。本提供方自身没有 durable 关系：pane 映射与帧日志属于 [`@dsh-fleet/tmux`](../tmux/README.zh.md)，子对话属于子进程，而输出 fold 与观察到的轮次结束只存在于创建它们的那次运行。
