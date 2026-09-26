---
description: "两阶段 git 归档（ctx.gitCheckpoint）：面向 fleet 组合与维护者，让每个轮次都在无网络访问下本地 commit，并把 push 异步放在 durable 队列之后。"
kind: "package-reference"
---

# @dsh-fleet/git-checkpoint

[English](README.md) | 中文

## 概述

用 `dsh-git-checkpoint` 让每个轮次都在 git 中持久化，同时永不把网络往返放进轮次内部。把它挂载在 fleet 组合里；`agent/turn-stopping` 暂存该轮次的工作区并在本地 commit，每个轮次一次，同时把该 commit 记录为 durable 的 `git/checkpoint` 会话事件。push 是独立的另一个阶段：`ctx.gitCheckpoint.enqueuePush(ref)` 写入一条 durable 队列条目后返回，`drain()` 以有界指数退避重试队列中的 ref，`finalPush(ref)` 阻塞直到远端持有该 ref。选用它，是为了让远端故障只到达最终 push，而不进入轮次循环（§7.1）。它只在 host 侧运行，对模型没有可见影响。

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

每个进程挂载一次本服务，并给出部署方拥有的仓库与队列文件：

```yaml
- id: fleet-git-checkpoint
  name: '@dsh-fleet/git-checkpoint'
  config:
    repositoryRoot: /srv/fleet/team-state
    remote: origin
    backoffBaseMs: 2000
    backoffMaxMs: 300000
    maxAttempts: 0
    queueFile: /srv/fleet/state/push-queue/pending.tsv
```

### 何时选用

在每台运行轮次的机器上挂载它。只有当某个组合的轮次产出的东西都不值得保留时，省略才是正确的：没有它，一个轮次的成果只存在于工作树里，一次崩溃或一次被清扫的检出就会让它消失。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `repositoryRoot` | 停止轮次的工作区 | 每个检查点提交到的绝对仓库；省略时使用 `session.header.cwd` |
| `remote` | `origin` | 异步 push 指向的远端 |
| `commitMessageTemplate` | `dsh checkpoint: session {session} turn {turn}` | commit message 模板；`{session}`、`{turn}`、`{branch}` 会被替换 |
| `backoffBaseMs` | `2000` | 首次重试延迟，每次尝试翻倍 |
| `backoffMaxMs` | `300000` | 单次重试延迟的上限 |
| `maxAttempts` | `0` | 一个 ref 保持排队之前的 push 尝试次数；`0` 表示永远重试 |
| `queueFile` | `<DSH_HOME>/push-queue/pending.tsv` | durable push 队列的绝对路径 |
| `enabled` | `true` | `agent/turn-stopping` 是否为一个轮次做检查点 |

模板必须包含 `{session}` 与 `{turn}`：一个其历史无法指明所属会话与轮次的检查点是加载失败，而不是一次静默的匿名 commit。`backoffMaxMs` 必须不小于 `backoffBaseMs`。

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个可接受字段及其 JSDoc 的完整来源。

### 你得到什么

- 第一阶段：每个停止的轮次一次本地 commit，记录为 `git/checkpoint` 会话事件，携带 `turn`、`commit`、`repository`，在分支上时还携带 `branch` 与入队的 `ref`。工作区未发生变化的轮次不产生 commit，也不产生记录。
- 第二阶段：`enqueuePush(ref, repository?)` 追加一行 durable 队列后返回；`drain(signal?)` 重试队列中的每个 ref 并报告 `{ pushed, failed }`；`finalPush(ref, repository?)` push 该 ref，并阻塞直到远端持有它。
- `queueFile` 与 `remote` 两个 getter，使运维界面无需重新读取配置就能指出第二阶段状态所在的位置。

### 队列文件

队列就是 `infra/scripts/push-queue.sh` 维护的那个文件：每个条目一行 `<repository>\t<remote>\t<ref>`，在 `enqueuePush` 返回之前追加并同步，只有在该 ref 的 push 到达远端之后才会被删除。因此 shell 工具与本服务互相消费对方的工作，而不是各自维护一个队列；本插件不替换该脚本，只是把同样两个阶段暴露给 harness。

一条完整但不是队列条目的行会让整次读取被拒绝（`PushQueueError` 会指出文件与行号）。末尾一行若没有换行符，说明那次写入仍在进行、尚不构成条目，因此与写入方并行的读取方永远不会因为一次撕裂的追加而失败。

### 失败与恢复

轮次永远不会因为归档而失败。轮次路径上永远不会尝试 push，本地 git 故障通过 `ctx.logger.warn` 上报，并让轮次继续进行：它没能做出的那次 commit 直接由下一个检查点承载。失败的 push 以同样方式上报并保持排队——`drain()` 把它放进 `failed` 返回，下一次 drain 会重试它。`finalPush` 是唯一把远端故障变成抛出 `GitPushError` 的路径，而且只在有限的 `maxAttempts` 预算耗尽，或插件在 push 中途被 dispose 时才抛出。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节说明这两个阶段从何而来；可观察的约定见[使用本包](#use-this-package)。

### 设计理念

- **一个轮次一次 commit，且在轮次内决定。** `agent/turn-stopping` 在一个本来已完成的轮次关闭之前运行，因此 commit 发生在产出这些工作的那个轮次之内。本服务记住它已经提交过哪些 `(session, turn)` 组合，因此重复的 stopping 事件——一个被 steering 的轮次继续后又再次停止——永远不会提交两次。
- **没有空 commit。** 暂存总会发生，但当 `git diff --cached --quiet` 报告没有差异时跳过 commit，因此历史记录的是工作，而不是墙上时钟时间。
- **网络是独立的阶段。** 轮次路径上没有任何东西接触远端。队列是第二阶段唯一需要的状态，而且在 `enqueuePush` 返回之前就已落盘，因此在两个阶段之间死掉的进程不会丢失任何东西。
- **上报不等于失败。** 两个阶段都通过 `ctx.logger` 与 `drain` 的报告上报；两者都不会向 agent loop 抛出，因为远端故障不是轮次故障。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、配置校验、轮次检查点、退避策略、最终 push |
| [`src/git.ts`](src/git.ts) | git 原语：经 subprocess seam 执行一条子命令，外加它带类型的失败 |
| [`src/queue.ts`](src/queue.ts) | durable 队列文件：行格式、带同步的追加、成功后才删除 |
| [`src/types.ts`](src/types.ts) | 队列条目、drain 报告、检查点记录，以及 `git/checkpoint` 事件声明 |

### 第一阶段

`agent/turn-stopping` 解析仓库——配置的 `repositoryRoot`，否则用会话自己的工作区——运行 `git add --all`，并向 `git diff --cached --quiet` 询问是否有内容被暂存。退出码 0 表示没有可提交的内容；1 表示要提交；其他任何值都是真实故障，会以 `GitCommandError` 浮现。commit message 由模板渲染，随后 `git rev-parse HEAD` 与 `git symbolic-ref --short HEAD` 提供 commit id 与分支。detached HEAD 会提交并记录，但什么都不入队，因为 detached 检出没有可发布的分支 ref。

### 第二阶段

`drain` 读取队列，并用 `git push --quiet <remote> <ref>` 尝试每个条目，每次失败后把延迟从 `backoffBaseMs` 开始翻倍，直到 `backoffMaxMs`。条目只有在自己的 push 成功之后才会从文件中删除，而那次重写之前会重新读取文件，因此在 drain 运行期间入队的条目能在这次 drain 中存活。`finalPush` 对单个 ref 运行同样的策略，并在有限预算耗尽时抛出 `GitPushError`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [infra-requirements.dsh.md](../../../infra-requirements.dsh.md)——§7.1（两阶段归档）、§11 第 6 项（本包），以及 §10（`agent/turn-stopping` 的落点）。
- [push-queue.sh](../../../infra/scripts/push-queue.sh)——同样两个阶段与同一个队列文件的 shell 实现。
- [`@dsh-fleet/session-archive`](../session-archive/README.zh.md)——逐轮次归档会话的归档器，本队列 push 的就是它写出的 ref。

-----

<a id="model-experience"></a>
## 模型体验

### 轮次检查点

#### 模型看到的内容

什么都没有。本服务不注册任何工具，也不注入任何提示词。`git/checkpoint` 会话事件是仅入日志的：它是 durable 记录，而不是模型可见的界面，因此没有任何请求携带 commit id、队列条目或 push 失败。

#### Token 影响

每次请求零直接 token。

#### KV Cache 影响

与实时请求无关：一个轮次被提交、入队、drain 或 push 时，没有任何请求前缀发生变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定两阶段归档做不到什么。它们是本包当前受到的约束，不是待办清单。

- **git 身份属于部署方。** commit 通过部署方自己的 git 运行，因此必须为进程配置 `user.name` 与 `user.email`（仓库级或全局配置）；没有它们时，检查点会被上报并跳过，而不是被凭空编造。这里没有硬编码任何身份。
- **第二阶段没有定时器。** 本包中没有任何东西安排 drain：它由调用方（一次定时 follow-up、最终 push 路径，或一条运维命令）驱动。一个固定间隔会是本包没有证据去选择的可调项。
- **重复抑制是建议性的。** 两个进程可能并发追加同一条队列条目；把一个 ref push 两次无害，这正是队列不加锁的原因。
- **`finalPush` 只 push 一个 ref。** 队列其余部分仍是第二阶段的工作，因此阻塞路径不会被一个无关的 ref 拖住。需要全部就位时，运行 `drain()`。
- **轮次记忆按进程保存。** `(session, turn)` 记录存活在进程里；重启后的进程可能重试一个已经提交过的轮次，它提交的是剩余差异，或者什么都不提交。
- **`DSH_HOME` 决定队列的位置。** `DSH_HOME` 未设置时，shell 工具默认使用 `$PWD/.dsh`，而本插件使用 harness home `~/.dsh`；要让两者共用同一个队列，请设置 `DSH_HOME`，或显式配置 `queueFile`。
- **`git/checkpoint` 事件必须登记进生成的目录。** `packages/core/session/src/known-event-types.ts` 由仓库的 `SessionEventMap` 生成；在 `pnpm run gen-persistence-catalog` 收录该事件之前，对包含它的日志做冷读取会被拒绝。写入不受影响。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与尚未确定的方向。它明确不具备权威性——已发布的行为与限制以上文各节和包内代码为准。

- **为什么队列文件与 shell 脚本共用**——两种实现必须对同一份 durable 状态达成一致，否则混用两者的 fleet 会在另一方重写文件时丢条目。
- **为什么失败的检查点可以重试，而已提交的轮次永不重试**——失败标记会被释放，使真正的瞬时故障（索引锁）能在下一个 stopping 事件上恢复；而成功是终局的，因为为一个轮次做第二次 commit 会把该轮次的工作拆到两个 commit 里。

</details>

**运行时不变式：** 不发布伴生模块。本服务拥有一份队列文件与一份逐轮次记录，对其中任何一个做检查都只是在复述服务是否存在，而不是比较两个彼此独立的观测。
