---
description: "fleet 的实时 agent 通道：按成员 key 放置一个 tmux pane，把放置持久化记录，双向传输 NDJSON 帧，并以子会话的 idle 状态判定一次调用完成。"
kind: "package-reference"
---

# @dsh-fleet/tmux

[English](README.md) | 中文

## 概述

`@dsh-fleet/tmux` 让一个进程获得通往 tmux pane 中 agent 的通道：按 key 放置一个 pane，把 JSON-RPC 帧写进它的 stdin，并读回它写出的帧。每次放置同时也是委派会话上的 durable 数据，因此机器崩溃后 pane 映射依然可解释。默认情况下，一次调用由自己的响应帧判定完成；使用 `completion: 'session-idle'` 时，只有子会话报告 idle 才算完成，因为 prompt 的响应只表示已入队。pane 消失时，调用会带着它的 key 失败：这里没有兜底邮箱，也没有补投。

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

每台机器挂载一行，与驱动它的委派提供方相邻；fleet 的每个 pane 都经 `ctx.tmux` 放置，而这一行是部署声明 pane 运行哪个 harness、帧写到哪里去的地方。

### 何时选用

当另一个 agent 必须作为进程存在，并且在启动它的那次调用之后仍可被访问、观察和中断时，选用本行：纠偏轮次必须唤醒同一个 worker，而不是新起一个（不变量 R-4），并且 pane 是 fleet 唯一承认的实时通道（不变量 R-6）。在自身进程内完成委派的组合里跳过它——基础 `spawn` 与 `fork` 提供方就是这种情形——因为它们不需要 pane、帧日志和放置记录。fleet 只挂载本行一次，并通过 [`@dsh-fleet/subagent-tmux`](../subagent-tmux/README.zh.md) 使用它。

### 最小配置

```yaml
- id: fleet-tmux
  name: '@dsh-fleet/tmux'
  config:
    dshHome: /var/lib/dsh-fleet/home
    machineId: !!js process.env.DSH_FLEET_MACHINE_ID
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | 必填 | 绝对 harness home，作为 `DSH_HOME` 交给每个 pane |
| `machineId` | 必填 | 拥有本进程创建的每一次放置的机器 |
| `sessionPrefix` | `dsh-fleet` | fleet 所有 pane 所在的 tmux 会话 |
| `dshBin` | `dsh` | pane 运行的 harness 可执行文件 |
| `profile` | `sdk` | pane 的 harness 加载的 profile |
| `patches` | `[]` | 按顺序交给 pane 的绝对 profile patch 文件 |
| `frameRoot` | `<dshHome>/fleet/frames` | 保存每个 key 的 `out.ndjson` 帧日志的目录 |
| `credentialEnv` | 本仓库已知的八个 provider key | 本进程持有这些凭据形态变量时，把它们复制进 pane |
| `pollIntervalMs` | `40` | 两次帧日志轮询之间的间隔（毫秒） |
| `startTimeoutMs` | `15000` | pane 创建的上界（毫秒），包含 harness 自身的启动 |
| `graceMs` | `2000` | tmux 客户端进程的终止宽限（毫秒） |
| `tmuxBin` | `tmux` | 本行运行的 tmux 可执行文件 |

生成的[配置目录](../../../docs/config-catalog.zh.md#dsh-fleettmux)是字段的完整清单，并带有其源码声明。以下情况会让加载失败：相对的 `dshHome`、空的 `machineId`、相对的 patch，或不是正整数的上界；不在可接受字母表内的放置 key 会在放置时被拒绝。

### 你得到什么

- `place(key, { cwd, mode, env?, recordTo? })` 创建或复用 key 的 pane，并返回它的放置。当本进程已经放置过该 pane 且 tmux 仍报告它存在时，`resident` 复用；`fresh` 替换它。调用方会话会收到 `tmux/placement` 记录。
- `request(key, method, params, { completion, sessionId, timeoutMs, signal })` 写入一次 JSON-RPC 请求，等待它的完成信号，并返回响应中的 `result`。
- `send(key, frame)` 写入一帧且不等待；`observe(key, listener)` 与 `frameLog(key)` 暴露从 pane 读回的帧。
- `interrupt(key, signal, recordTo?)` 投递 `INT`、`TERM` 或 `KILL`，并返回它是否到达了存活的 pane。给出父会话时，父会话会收到 `tmux/interrupt` 记录。
- `release(key)` 销毁 pane 并遗忘该 key；释放从未放置的 key 也会成功。`alive(key)`、`placement(key)`、`placementsList()` 与 `machine` 报告本进程拥有的 pane 状态。

### 完成判定

JSON-RPC 响应帧带 id 而不带 method，因此请求由 id 匹配上的那一帧回答；被回显的请求帧两者都有，永远不会被当作答案。在默认的 `completion: 'response'` 下，该帧就是完成信号。在 `completion: 'session-idle'` 下，响应只能证明 prompt 已入队，调用会继续等待，直到某条 `session.status` 通知为调用方的 `sessionId` 报告 `status: 'idle'`；这正是 fleet 的 worker 会话模型要求的规则（§5.4）。`timeoutMs` 缺省或不为正数时无限等待，中止信号以 `tmux call <method> was aborted` 结束等待。

### 失败与恢复

每次失败都是带 key 的 `TmuxChannelError`：从未放置过的 key、等待期间消失的 pane、来自子进程的 JSON-RPC 错误，或超时。没有任何东西会为之后的重试排队——pane 消失时调用失败，由调用方运行自己的纠偏回环，这正是没有兜底邮箱的 fleet 所要求的（§5.3）。放置同样大声失败：harness 未在 `startTimeoutMs` 内接管前台时，报错会带上 tmux 仍显示的命令。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计理念

一个服务拥有 fleet 其余部分否则要各自重复实现的三件事：放置、帧化与中断路径。放置根据调用方的 key 决定 pane 名称（`<sessionPrefix>:w-<key>`），把 harness 命令作为窗口命令交给 tmux，而不是把它敲进交互式 shell，把 pane 输出管道写入 `<frameRoot>/<key>/out.ndjson`，并等到 tmux 报告的前台命令不再是 shell。帧化增量读取该文件。这里不保存消息：durable 的 `tmux/placement` 与 `tmux/interrupt` 记录是历史，不是队列。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务入口：`Config`、加载期校验、放置、请求轮询、中断、释放、观察者 |
| [`src/panes.ts`](src/panes.ts) | `runTmux`（不经过 shell 传递 argv）与 `FrameLog`（增量 NDJSON 读取器） |
| [`src/types.ts`](src/types.ts) | 放置、帧、信号与两个 durable 会话事件，只有类型 |

### 帧化规则

一帧就是完整的一行。`FrameLog` 保存字节偏移与末尾未完成的行，因此落在写入中间的轮询会先不交付该帧，并在之后的轮询里整帧交付；日志变短说明它被替换过，读取会从文件开头重新开始。不是 JSON-RPC 对象的行会作为 `malformed` 报告而不是抛出，因为 tty 噪声不能杀死通道，服务会把这些行从分发的帧流里丢弃。读取器只在有调用等待时轮询，因此 `observe()` 的监听器只在该 key 上某个 `request` 进行中时看到它的帧。

### 写入帧

`send-keys -l` 把帧作为字面文本写入，另有单独的 `send-keys Enter` 提交它，因此帧内容永远不会被当作 tmux 按键名查找。pane 的命令以 `stty -echo -icanon` 开头：tty 会回显写进它的内容，而被回显的请求帧本身就是合法 JSON，后来的读取者会把它误当成答案（§5.3）。

### 中断投递

`INT` 把 `C-c` 写进 pane 的 tty，由它向前台进程组投递 SIGINT；`TERM` 直接向 pane 的进程组发信号，失败时退回向 pane 顶层 pid 发信号；`KILL` 销毁窗口。每种结果都以 `tmux/interrupt` 记录在调用方会话上，带有 `delivered`，成员无法触达时还带有 `reason`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Fleet 需求](../../../infra-requirements.dsh.md)——§5.3 说明通道，§5.4 说明完成判定，§11 第 1、2、4、13 项说明建立在它之上的插件行。
- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——由本通道的提供方驱动的委派 seam。
- [`@dsh-fleet/subagent-tmux`](../subagent-tmux/README.zh.md)——把放置、帧与 idle 规则变成一次委派调用的提供方。
- [`@dsh-fleet/tmux-gateway`](../tmux-gateway/README.zh.md)——让另一台机器上的 pane 可达的 TCP 桥。
- [生成的配置目录](../../../docs/config-catalog.zh.md#dsh-fleettmux)——每个可用配置字段及其源码声明。
- [生成的持久化目录](../../../docs/persistence-catalog.zh.md)——`tmux/placement` 与 `tmux/interrupt` 记录下来的载荷。

-----

<a id="model-experience"></a>
## 模型体验

### 委派通道

#### 模型看到的内容

本服务自身没有任何内容进入请求：它不注册工具 schema，也不注册提示词段落，而 `tmux/placement` 与 `tmux/interrupt` 都是仅入日志的记录。模型看到的一次委派，是 [`@dsh-fleet/subagent-tmux`](../subagent-tmux/README.zh.md) 依据本通道承载的帧渲染出的 `subagent` 工具结果；通道故障只会以该提供方的诊断文本到达模型。

#### Token 影响

每次请求零直接 token。帧本身属于交换它们的两个会话：调用方写进 pane 的 prompt 计入子会话的请求，子进程的最终消息计入调用方的工具结果。

#### KV Cache 影响

与实时请求无关：放置、释放或中断 pane 都不改变任何请求前缀，因此不会让任何缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下是本通道当前受到的约束及其背后的决定，不是待办清单。

- **没有兜底邮箱，也没有补投**——pane 消失时，等待中的调用以 `pane for <key> disappeared during <method>` 失败，也不会有任何帧留待之后重试。这种缺失是刻意的（§5.3）：调用方观察到失败，并运行自己的纠偏回环。
- **同一时刻只有一个进程拥有某个 key**——放置保存在本进程的映射里；第二个进程放置一个窗口名已存在的 key 时，会创建同名窗口，随后在 `tmux could not pipe pane <session>:<window>: can't find window: <window>` 处失败，因为 tmux 按名字解析 `session:window`，而该名字已不再唯一。重启后的进程无法接管或驱动它此前放置的 pane，即便它们的 `tmux/placement` 记录就在它的会话日志里。
- **完成判定依赖子会话的状态通知**——`completion: 'session-idle'` 需要一条携带调用方 `sessionId` 与 `status: 'idle'` 的帧。子运行时若不发布该通知，调用会一直等到 `timeoutMs`，没有设置上界时则永远等待。
- **帧日志只增不减**——`pipe-pane` 在 pane 的整个生命周期内向 `<frameRoot>/<key>/out.ndjson` 追加；没有任何截断、轮转或大小上界，因此常驻 worker 会累积它写过的每一帧。
- **回显抑制属于本行的启动命令**——`stty -echo -icanon` 只在本服务创建的 pane 里运行。由其他进程（或手工）放置的 pane 会回显写进它的内容，而被回显的请求帧本身就是合法 JSON。
- **就绪判断依据 tmux 报告的前台命令**——放置会等到 `#{pane_current_command}` 既非空、也不是 `sh`、`bash`、`dash`、`zsh`、`fish`、`ksh`、`tmux` 之一。前台命令始终是其中之一时，放置会在 `startTimeoutMs` 之后失败，而不是继续等待。
- **只有给出会话时中断才有记录**——`interrupt(key, signal, recordTo?)` 只为传入会话的调用方追加 `tmux/interrupt`；它记录的原因有 `pane is not present`、`tmux refused the interrupt key` 与 `pane process group is gone`。
- **tmux 是宿主依赖**——每次调用都从部署的 PATH 启动 `tmuxBin`，本行没有进程内的退路。机器上没有 tmux 时，放置与轮询都会失败，而不是降级到另一种传输方式。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与尚未确定的方向。它明确不具备权威性——已发布的行为与限制以上文各节和包内代码为准。

- **中断路径没有测试。** `tests/tmux.spec.ts` 中没有任何用例调用 `interrupt()`；提供方只有在轮次尚未完成时才会在销毁路径上触达它，因此 `INT` 或 `TERM` 投递的回归今天不会让测试变红。
- **`observe()` 没有自己的轮询器。** 监听器由同一 key 上进行中的 `request` 驱动；后台读取者需要自己的定时器与自己的偏移纪律。
- **放置不会被重建。** `tmux/placement` 记录足以重建 pane 映射，但没有任何东西重放它们：每个进程都从空映射开始，这正是限制一节中第二个进程的场景会失败而不是重连的原因。
- **窗口是按名字而非索引定位的。** 在名字之外记录 tmux 窗口索引，会让 `pipe-pane` 与 `kill-window` 跨进程无歧义；当前放置只携带名字。
- **就绪判断是启发式的。** `#{pane_current_command}` 能区分 shell 与 harness，却分不出仍在启动的 harness 与已在服务的 harness；后者由提供方里的 `initialize` 握手证明。

</details>

**运行时不变式：** 不发布伴生模块。放置映射、帧日志读取器与观察者各自只有一份，且都由本进程持有，而 durable 的 `tmux/placement` 记录写的就是填充该映射的同一个值，因此进程内不存在两个可能背离的观测。
