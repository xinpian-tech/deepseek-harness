---
description: "面向集群 best-of-N 候选评测的 worktree 隔离：每个候选一个 git worktree 与分支，落选候选作为证据保留，每个任务持有持久候选集。"
kind: "package-reference"
---

# @dsh-fleet/worktree

[English](README.md) | 中文

## 概述

`@dsh-fleet/worktree` 注册 `ctx.worktrees`，把「一个任务有 N 个候选」变成 N 个分支上的 N 个 git worktree。每个候选有自己的检出目录，两个 worker 永不共用工作树。分支命名把候选与主 agent 选中的 commit 区分开。除非部署明确关闭，落选候选的 commit 与分支作为评测证据保留。每次创建、选择、清理的结果都记入调用方的会话日志，而任务的候选集是 worktree 根目录下的持久状态，后续进程读回它而不是信任创建它的进程。

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

把本包挂载在它所使用的 subprocess 接缝旁边，并告诉它任务组工作的仓库。主 agent 随后按需要评测的下标创建候选、选中它接受的那一个，并单独决定是否清理落选候选。

```yaml
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@dsh-fleet/worktree'
  config:
    repositoryRoot: /srv/team/state/repository
    worktreeRoot: /srv/team/worktrees
    maxCandidates: 4
    keepLosers: true
```

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `repositoryRoot` | harness 进程 cwd | 候选所属仓库的绝对路径；插件在加载时解析 git 的规范顶层目录 |
| `worktreeRoot` | `<repositoryRoot>/.dsh-fleet/worktrees` | 存放各任务候选 worktree 及其状态文件的绝对根目录 |
| `branchPrefix` | `fleet/candidate` | 创建候选所用的分支命名空间 |
| `keepLosers` | `true` | 是否保留落选候选的 worktree 与分支 |
| `maxCandidates` | 必填 | 每个任务存活候选的上限；超出上限的新候选会被拒绝 |
| `gitBin` | `git` | git 可执行文件 |
| `graceMs` | `2000` | git 进程的终止宽限期 |

### 你得到什么

| 调用 | 结果 |
|---|---|
| `createCandidate(taskId, index, options?)` | 该候选的 worktree，创建或复用；返回前已持久记录 |
| `list(taskId)` | 某个任务的存活候选，从持久状态读回 |
| `select(taskId, index, options?)` | 把被接受候选的 commit 发布到任务的选中分支，并记录该选择 |
| `prune(taskId, options?)` | 当 `keepLosers` 为 false 时删除落选 worktree 与分支；返回被删除的分支，空操作时返回 `[]` |

`options.recordTo` 指定接收持久 `worktree/candidate`、`worktree/select`、`worktree/prune` 记录的会话。调用方自己的会话才是正确的归属者，任务候选集因此可从该会话日志重建。

### 分支命名

一个候选一个分支：`fleet/candidate/<taskId>/c<index>`。被接受的 commit 另外发布为 `fleet/selected/<taskId>`，即前缀最后一段替换为 `selected`，因此仅凭分支名就能判断某个 commit 是被接受还是落选（§5.5）。被接受的候选同时保留自己的候选分支；选择永不删除其他候选的 worktree 或分支。

### 失败与恢复

- `TypeError` 拒绝无法作为 worktree 目录与分支名的任务 id 或下标，并在消息中点出非法值。
- `WorktreeError` 拒绝超出 `maxCandidates` 的候选、git 报告位于其他分支的已记录 worktree、任务不持有的下标选择，以及对尚无选中候选的任务执行清理。
- `GitCommandError` 报告失败的 git 命令及其 argv、退出码与 stderr；`WorktreeStateError` 报告不可读或版本不符的持久状态文件。
- 当配置路径为相对路径、`maxCandidates` 不是正整数、分支前缀不可用，或 `repositoryRoot` 不是 git 工作树时，加载即失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

- **一个候选、一个 worktree、一个分支。** 隔离正是目的：同一任务的两个候选永不共用工作树，选中其一的清理动作不会动到其他候选。
- **持久状态是 `list` 的权威。** 回答「存在哪些候选」的是任务状态文件而不是内存映射；从未创建过候选的进程同样能报告它。
- **git 经 subprocess 接缝运行。** 每条命令都是交给进程接缝的 argv 数组，永不拼接 shell 字符串，因此任务 id、分支名或路径无法改变实际运行的命令。
- **方案是数据，评分不是。** 本服务记录哪个候选存在、哪一个被接受。哪个候选**最好**是主 agent 的判断，依据是候选与红军产出的证据。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、`ctx.worktrees`、候选生命周期、分支命名 |
| [`src/git.ts`](src/git.ts) | git 原语：仅 argv 的调用、`GitCommandError`、`git worktree list` 解析 |
| [`src/store.ts`](src/store.ts) | 持久任务状态：原子替换与解码文档校验 |
| [`src/types.ts`](src/types.ts) | `Worktree`、记录选项，以及每种结果的 `SessionEventMap` 声明 |

### 持久状态

每个任务拥有 `<worktreeRoot>/<taskId>/`：以 `c<index>` 目录存放其候选 worktree，`state.json` 保存候选列表、创建它们时使用的分支前缀，以及选择结果。已记录的分支前缀与配置不再一致时会被拒绝，否则它将指向与已记录候选不同的分支。

### git 操作

创建候选时以仓库 `HEAD` 作为基线 commit，分支已存在时挂接该分支（使候选已产生的 commit 保持可达），否则在该基线上创建分支。选择时解析候选分支的 commit，并用 `git update-ref` 让选中分支指向它。清理时先移除每个落选 worktree 再删除其分支，因此 git 不会把该分支视为已检出。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [集群需求](../../../infra-requirements.dsh.md)——§11 第 8、9 项，§5.5（保留落选候选），§12（worktree 隔离）。
- [绩效簿姊妹包](../ledger/README.zh.md)——后续派活决策读取的持久绩效记录。
- [subprocess 接缝](../../subprocess/subprocess/README.zh.md)——git 命令所经的仅 argv 进程契约。
- [架构](../../../docs/architecture.zh.md)——能力接缝、插件与持久状态各自的归属。

-----

<a id="model-experience"></a>
## 模型体验

### worktree 记账

#### 模型看到什么

本身什么都不看到：本服务不注册工具、不贡献提示词段落、不写消息。调用方传入 `recordTo` 时，其会话会收到仅记录型的 `worktree/candidate`、`worktree/select` 或 `worktree/prune` 记录，后续评测轮次由此在不接触 git 的情况下重建候选集。

#### token 影响

每个请求的直连 token 为零。之后向主 agent 报告候选路径与分支名的工具自行负责进入请求的内容。

#### KV 缓存影响

与实时请求无关：本服务从不触碰请求前缀，因此不会破坏 provider 的缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本包何时不合适。它们是当前的包约束，不是任务清单。

- **仅限本地仓库**——候选是运行本服务的机器上某个仓库的 worktree；跨机器的任务组需要每台机器一个 worktree 服务。
- **本服务不拥有 commit**——它创建并命名分支，worker 在自己的候选 worktree 中提交。本包不决定候选改动了什么。
- **清理在特定配置下是破坏性的**——当 `keepLosers: false` 时，`prune` 在移除落选 worktree 之后删除其分支；之后可能需要这些证据的部署必须保持默认值。
- **worktree 不是工作区实体**——候选始终是本包拥有的路径，而不是 `dsh-workspace` 记录，因为这些 worktree 是评测用的临时空间而非用户工作区；若要向人展示其中一个，需要另行注册。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确非权威；已交付行为见上文各节与包代码。

- **并发**——同一任务状态文件的写入按服务实例串行。两个进程为同一任务创建候选时并无协调；需要该能力的集群应在状态文件之前安排唯一属主，或把它移到存储接缝上。
- **复用与重建**——git 仍报告在其分支上的已记录 worktree 原样返回；目录已消失的已记录 worktree 会在其记录分支上重新添加。中间情形，即路径注册在其他分支上，会被拒绝而不是靠猜测处理。

</details>
