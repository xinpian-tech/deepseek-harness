---
description: "逐轮次的 session 归档器（ctx.sessionArchive）：面向 fleet 组合与维护者，把 durable 的 session 日志复制进按机器划分的 git ref，而不触碰持久化提供方。"
kind: "package-reference"
---

# @dsh-fleet/session-archive

[English](README.md) | 中文

## 概述

用 `dsh-session-archive` 把每个 session 的 durable 日志保存在 git 里：在每个停止的轮次，它把该 session 的 JSONL 复制进归档树，用 git plumbing 提交，并把该 commit 发布在 `refs/dsh/machines/<machine-id>/sessions/<session-id>` 之下。每台机器拥有自己的 ref 命名空间，因此没有任何 push 会在整个 fleet 上串行化，而 `family(sessionId)` 从归档的 header 重建父子树，而不是从 ref 布局推断（§7.2）。

它是**旁路归档器，而不是 `SessionPersistence` 后端**：它读取 JSONL 提供方已经持久化的日志，从不写入它，因此归档始终远离模型的热路径（§7.3）。

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

每台机器挂载一次本服务，并给出团队状态仓库与本机的 id：

```yaml
- id: fleet-session-archive
  name: '@dsh-fleet/session-archive'
  config:
    repositoryRoot: /srv/fleet/team-state
    machineId: !!js process.env.DSH_FLEET_MACHINE_ID
    archiveRoot: /srv/fleet/team-state/sessions
```

### 何时选用

在每台运行 session 的机器上挂载它。没有它的组合只在写入它们的机器上拥有 durable 的 session：团队状态仓库会承载任务与结果，却没有 session 历史，而一台机器死掉就会带走它那些 session 的可解释性。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `repositoryRoot` | 必填 | 归档提交进的绝对仓库 |
| `machineId` | 必填 | 本进程归档所用的 MachineId；ref 命名空间的分片与归档树的分片 |
| `refPrefix` | `refs/dsh/machines` | 归档发布所在的 ref 命名空间 |
| `archiveRoot` | 必填 | 绝对归档树；它必须位于 `repositoryRoot` 之内 |
| `enabled` | `true` | `agent/turn-stopping` 是否归档一个 session |

`repositoryRoot` 必须存在且是 git 工作树，`archiveRoot` 必须是它内部的一个目录（提交路径由它派生），而 `machineId` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，因为它同时会成为目录名与 git ref 的路径片段。以上每一条都是加载失败，而不是第一个轮次才失败。

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个可接受字段及其 JSDoc 的完整来源。

### 你得到什么

- 逐轮次的归档：该 session durable 日志的一份 `<archiveRoot>/<machineId>/<session-id>.jsonl` 副本，已提交，并发布在 `refs/dsh/machines/<machineId>/sessions/<session-id>` 之下。归档副本保持提供方写出的同样 JSONL 格式——一行 header，然后每个 durable 事件一行——因此归档日志读起来与实时日志一样。
- `archiveSession(session): Promise<{ ref, commit }>`——立刻归档一个 session，并返回它落在哪里。
- `refs(machineId): Promise<readonly string[]>`——只读列出一台机器的分片。
- `family(sessionId): Promise<SessionFamily | undefined>`——父子树，包含根、被查询的节点，以及它已归档的祖先。

### 为何 ref 要分片

一个 git ref 只有一个写入方。当每台机器都发布 session 归档时，一个共享 ref 会把整个 fleet 压在同一把锁上；按机器划分的命名空间让每台机器得到一个只有它写入的命名空间（§7.2）。因此分组**不是** ref 结构：一条 `parentSession` 链接经常指向归档在另一台机器前缀下的 session，这正是 `family()` 读取 header 的原因。

### 失败与恢复

归档永远不会让轮次失败：失败通过 `ctx.logger.warn` 上报，轮次继续进行。durable 日志未被改动且完整，因此下一个停止的轮次会重新归档整个前缀——每次归档都是完整副本，从不是增量。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节说明一份归档是如何产生的；可观察的约定见[使用本包](#use-this-package)。

### 设计理念

- **旁路，而不是替换。** 日志通过 `ctx.sessionPersistence` 的读取路径读取。归档器不持有写句柄，从不追加，也从不刷新别人的缓冲区。
- **依据内容，而不是 ref。** 归档的 header 携带 `parentSession`；分组视图只由 header 构建。
- **用对象，而不是检出。** commit 由 `hash-object`、`ls-tree`、`mktree`、`commit-tree` 与 `update-ref` 构建。把归档检出会需要每台机器一个可写工作树，会在共享索引上与轮次自己的 `git add --all` 检查点竞争，还会把没有任何东西会从文件系统读取的若干 GB 实体化。由对象构建树让归档成为纯对象存储写入，因此它与轮次检查点可以按任意顺序落地。
- **每个轮次一份完整副本。** 每次归档都持有完整的 durable 前缀。这正是被跳过或失败的归档无害的原因：下一次会带上全部内容。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、配置校验、逐轮次触发、ref 派生 |
| [`src/plumbing.ts`](src/plumbing.ts) | 基于 git plumbing 的树构建、commit 创建与 ref 更新 |
| [`src/git.ts`](src/git.ts) | 经 subprocess seam 的一条 git 命令，外加它带类型的失败 |
| [`src/archive.ts`](src/archive.ts) | 片段编码、归档的 JSONL 格式、header 解析与家族重建 |
| [`src/types.ts`](src/types.ts) | 归档 ref、归档 session 节点与家族词汇 |

### 归档流程

`archiveSession` 打开该 session 已存储的日志，读取它的 header 与 durable 事件，并在日志不含任何事件时拒绝。内容成为一份 JSONL 产物，被原子地写进该机器的分片目录。blob 被哈希进对象存储，父 commit 的树沿归档路径被重新读取，并以替换那一个条目的方式重建，随后 `commit-tree` 写出 commit；父提交在存在时是该 session 自己的上一次归档，否则是 `HEAD`，因此一个 session 的 ref 沿它自己的历史前进，而第一次归档携带的是它构建时所基于的仓库状态。`update-ref` 把它发布出去。

### 路径与 ref 中的 session id

session id 是一个不透明字符串，会成为目录项、文件名与 git ref 的组成部分。`[A-Za-z0-9-]` 之外的每个单元都被转义为 `_XXXX`，这使结果留在 git 的 ref 字母表内（`~`、`.lock` 与前导点都被 git 拒绝），并防止任何 id 穿越出归档树。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [infra-requirements.dsh.md](../../../infra-requirements.dsh.md)——§7.2（按机器分片的 ref）、§7.3（旁路归档器）、§11 第 7 项（本包），以及 §18（session 保留）。
- [`@deepseek-ai/dsh-session-persistence-jsonl`](../../session/session-persistence-jsonl/README.zh.md)——唯一的持久化提供方，也是本包读取的日志。
- [`@dsh-fleet/git-checkpoint`](../git-checkpoint/README.zh.md)——发布本包所提交内容的那个两阶段 commit 与 push 队列。

-----

<a id="model-experience"></a>
## 模型体验

### Session 归档

#### 模型看到的内容

什么都没有。`ctx.sessionArchive` 不注册工具，也不注入提示词；它不追加 session 事件，因为把归档的记录写进正在被归档的日志会改变它刚刚提交的产物。没有任何请求携带归档 ref、commit id 或归档失败。

#### Token 影响

每次请求零直接 token。

#### KV Cache 影响

与实时请求无关：一个 session 被归档时没有任何请求前缀发生变化，而归档器从不写入回放或恢复所读取的日志。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本归档器做不到什么。它们是本包当前受到的约束，不是待办清单。

- **归档的是 durable 前缀，不是实时快照。** JSONL 后端把路由到的实时事件缓冲至多一个写入批次窗口（200 ms），之后它们才落到磁盘上。在该窗口内结束的轮次由下一个轮次归档，而后者携带完整前缀；就此结束的 session 会保持它最后那些事件未被归档，直到有东西再次归档它。
- **`family()` 只读取一个检出。** 它扫描本仓库中的归档树。由另一台机器归档的 session 只有在它们的文件出现在这里之后才会显现，因此获取并合并这些 ref 仍是调用方的步骤。
- **一个 session ref 不是完整的归档快照。** 它的第一个 commit 继承自 `HEAD`，之后的那些继承自该 session 的上一次归档，因此树里既有该 session 的日志，也有这条链起始时的仓库状态。请按路径（`<ref>:<archive path>`）读取归档，而不要把它当作整树导出。
- **归档文件也会落进分支。** `archiveRoot` 位于仓库内部，因此轮次检查点的 `git add --all` 也会把它们提交到工作分支上；让它们无需该分支即可被获取的，是那个按 session 划分的 ref。
- **归档需要持久化提供方。** 本插件注入 `sessionPersistence`；没有挂载后端时它永远不会加载，这是刻意的——没有 durable 日志可读的归档器没有任何东西可归档。
- **每个轮次都重新提交整份日志。** 存储增长是被接受的（§13）：长 session 的归档随它的日志一起增长，而不是发送增量。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与尚未确定的方向。它明确不具备权威性——已发布的行为与限制以上文各节和包内代码为准。

- **没有间隔触发。** §7.3 要求逐轮次的粒度，而定时器会在提供方正在写入 session 时于轮次中途归档它；`agent/turn-stopping` 触发就是全部调度。只有在有证据表明轮次可以在没有 stopping 事件的情况下结束时，才重新考虑。
- **session dispose 时没有任何东西归档。** 最终事件落在最后一次停止轮次之后的 session，会在这个检出里保持这些事件未被归档；如果这个缺口重要，dispose 时归档是显而易见的下一步。

</details>

**运行时不变式：** 不发布伴生模块。本服务不拥有任何长期存在的进程内关系：一次归档就是对 git 的一次写入，而分组视图在每次调用时从另一个进程可能已经写过的文件派生。
