---
description: "面向 fleet 组合与运维者的 worker 启动模板：放置一个常驻 tmux pane，抑制它的 tty 回显，exec sdk profile 的 harness，并显式下传凭据形态的变量。"
kind: "package-reference"
---

# @dsh-fleet/worker-template

[English](README.md) | 中文

## 概述

用 `dsh-worker-template` 按 §5.4 的要求启动 worker：tmux pane 里一个 `dsh --profile sdk` 进程，在整个任务期间常驻、永不退出，tty 回显被抑制，模型凭据显式交给该 pane。`launch()` 在 `ctx.tmux` 之上组合出放置与帧通道，返回确切的命令行与 pane 收到的确切环境条目，并针对本进程不持有的每一项已配置凭据告警——在 pane 启动之前，而不是在嵌套 harness 返回 401 之后。它的对等实现是 `infra/scripts/worker.sh` 中的 shell 约定。

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

把它挂载在 tmux 通道旁边，并让两行配置来自同一个来源：

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

### 何时选用

在每个会启动 worker pane 的组合里挂载它。自己通过 `ctx.tmux.place` 放置 pane 的组合可以省略它，但那样它就得自己拥有启动序列、凭据下传与诊断——而这正是本包要防止的重复。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `profile` | `sdk` | worker harness 运行的 profile |
| `patches` | `[]` | 按顺序的绝对 profile patch 文件 |
| `dshBin` | `dsh` | pane exec 的 harness 可执行文件 |
| `dshHome` | 必填 | 绝对 harness home；也是 pane 收到的 `DSH_HOME` |
| `credentialEnv` | 本仓库已知的八个 provider key | 启动进程持有这些凭据形态变量时被显式下传 |
| `extraEnv` | `{}` | 覆盖在允许列表之上的显式名值对 |
| `enableStty` | `true` | 启动行是否带有 tty 设置步骤；`false` 在加载时被拒绝 |
| `startTimeoutMs` | `15000` | 确认已放置 pane 的上界（毫秒） |
| `confirmPollMs` | `50` | 两次确认检查之间的间隔（毫秒） |

每个字段不可用时都会让加载失败：相对的 `dshHome` 或 patch、空的二进制名或 profile、不匹配 `^[A-Za-z_][A-Za-z0-9_]*$` 的环境变量名，或非正数的上界，都会在插件构造期间抛出。

### 你得到什么

- `launch(key, { cwd, mode?, recordTo? })`——放置或复用该 pane，并返回 `{ key, placement, launchLine, env, reused }`。`mode` 默认为 `resident`，因为 worker 在整个任务期间常驻；`recordTo` 是接收 durable `tmux/placement` 记录的会话。
- `launchLine`——pane 运行的确切命令，包含 tty 设置：`stty -echo -icanon; exec '<dshBin>' --profile '<profile>' [--patch '<file>']…`，其中每个值都作为一个 shell 词被引用。
- `env`——交给该 pane 的确切环境条目：`DSH_HOME`、本进程持有的每一项已配置凭据，以及 `extraEnv`。
- `credentialReport()`——每项已配置凭据的 `{ name, present }`，刻意从不返回值本身。

### 失败与恢复

启动进程不持有的凭据会在启动时产生一条 `ctx.logger` 警告，并从 `env` 中省略：worker 可能是为一个不需要模型访问的任务启动的，因此这不致命，但它必须在 pane 运行之前可见。新建的 pane 若在 `startTimeoutMs` 内无法确认，会被释放，而启动会抛出指名该启动行的 `WorkerTemplateError`——从未出现的 pane 在这里失败，而不是之后变成一个死掉的通道。相对的 `cwd` 抛出 `TypeError`。dispose 插件的 fiber 会移除 `ctx.workerTemplate`；它放置的 pane 属于通道，并通过 `ctx.tmux` 释放。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计理念

- **组合，绝不重新实现。** 放置、pane 的环境、回显抑制步骤、帧日志，以及等到 harness 接管 pane 前台的过程，都属于 `@dsh-fleet/tmux`；本包计算命令与环境，把两者交给 `place`，并把它们报告回来。
- **报告 pane 收到了什么。** `launchLine` 与 `env` 是值，而不是对运行中 pane 的观测，因此测试或运维者可以直接断言它们。
- **只在一处引用，即在构造时。** 该行中的每个路径都经过同一个导出的辅助函数，因此含有空格、引号、`$` 或换行的工作区目录无法改变这条命令。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、配置校验、放置、确认、凭据报告 |
| [`src/launch.ts`](src/launch.ts) | `shellQuote`、`buildLaunchLine` 与 `resolvePaneEnv`——纯函数、已导出、有单元测试 |
| [`src/types.ts`](src/types.ts) | `WorkerLaunchRequest` 与 `WorkerHandle` |

### 启动序列

`launch` 组装 pane 环境，对缺失的凭据发出警告，用组装好的环境调用 `ctx.tmux.place`，并对它自己创建的 pane 等待直到 `ctx.tmux.alive` 报告它存在。通道交给 tmux 的命令，与本包作为 `launchLine` 返回的字符串相同；测试通过读取被组合的通道交给它 tmux 二进制的 argv 来断言这一点，因此两行之间的分歧会让测试失败，而不是表现为一个损坏的通道。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [infra-requirements.dsh.md](../../../infra-requirements.dsh.md)——§11 第 4 项（本包）、§5.3（通道及其回显规则）、§5.4（worker 为何常驻），以及 §8.2（向嵌套 harness 下传凭据）。
- [`infra/scripts/worker.sh`](../../../infra/scripts/worker.sh)——同一份启动约定的 shell 实现。
- [`@dsh-fleet/tmux`](../tmux/src/index.ts)——拥有放置、帧日志与就绪等待的通道。
- [`@dsh-fleet/subagent-tmux`](../subagent-tmux/src/index.ts)——驱动已启动 pane 的委派提供方。

-----

<a id="model-experience"></a>
## 模型体验

### Worker 启动

#### 模型看到的内容

什么都没有。`ctx.workerTemplate` 不注册工具，也不注入提示词文本；`launch()` 启动一个进程，并把它的命令与环境报告给启动方。

#### Token 影响

每次请求零直接 token。在 pane 里启动的 worker 运行自己的 harness，并拥有自己的 token 用量。

#### KV Cache 影响

与实时请求无关：启动或复用一个 pane 不改变任何请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本模板做不到什么。它们是当前受到的约束，不是待办清单。

- **pane 的实际环境可能多于所报告的 `env`。** `@dsh-fleet/tmux` 把本包传入的条目覆盖在它自己配置的 `credentialEnv` 允许列表与它自己的 `DSH_HOME` 之上。返回的 `env` 正是本模板交给放置的内容；对通道行做不同配置的部署会加入这份报告没有列出的条目。请让两行配置来自同一个来源。
- **两行无法相互校验。** `ctx.tmux` 不为自己的 `dshBin`、`profile`、`patches` 或 `dshHome` 发布任何读取器，因此 profile 与通道不同的模板会启动一个运行通道命令行的 pane，却报告自己的那一行。测试为完全相同的配置固定了这一配对；配置有分歧的部署在这里无法被发现。
- **`enableStty: false` 无法表达。** 通道的 pane 命令总是带有 `stty -echo -icanon`，因此该选项在加载时被拒绝，而不是被静默忽略。确实需要不带回显抑制的 pane 的部署，必须在本模板之外放置它。
- **确认是存活检查，不是握手。** 本模板通过 `ctx.tmux.alive` 确认已放置的 pane 存在；证明 harness 正在服务的 SDK `initialize` 握手属于调用方（由 `@dsh-fleet/subagent-tmux` 执行）。
- **被复用的 pane 不会得到通道自身检查之外的再次验证。** `resident` 复用返回通道认为存活的 pane；本模板不会额外探测 worker 的协议端点。
- **`extraEnv` 的值被原样下传，包括空字符串。** 只有凭据允许列表会省略不存在的变量；显式给出的键值对就是调用方声明的值，丢弃它会静默改变部署所要求的内容。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与尚未确定的方向。它明确不具备权威性——已发布的行为与限制以上文各节和包内代码为准。

- **单一配置来源**——对重复的 `profile`/`patches`/`dshBin`/`dshHome` 取值，干净的修法是通道侧的读取器（或一行共享配置），让模板能在加载时断言相等，而不是把这一点写进文档。
- **启动行的归属**——本模板镜像通道的 pane 命令，是因为通道不导出它的构造器；从 `@dsh-fleet/tmux` 导出它会移除这面镜像，测试的 argv 断言届时可以比较同一个函数的两次调用。
- **跨机器 pane**——tmux gateway（§11 第 3 项）将决定启动是否会在另一台机器上发生；本模板目前假设 pane 是本地的。

</details>

**运行时不变式：** 不发布伴生模块。本服务拥有一份已解析配置与一次放置调用；不存在可能背离的、由独立观测构成的关系，因此不变式伴生模块只会复述服务是否存在。
