---
description: "集群的持久绩效簿：主 agent 记录的结果条目、由条目派生的聚合，以及与任何评分在结构上分离的同伴信号与红军缺陷输入。"
kind: "package-reference"
---

# @dsh-fleet/ledger

[English](README.md) | 中文

## 概述

`@dsh-fleet/ledger` 注册 `ctx.ledger`，即每个成员绩效的持久记录。它存放两类数据且从不混用：结果条目，是主 agent 对该成员贡献的决策；评分输入，是原始同伴信号与红军缺陷计数。计数器与排名每次读取都由条目派生，因此聚合永远不会与它所概括的结果相互矛盾。评分权始终属于主 agent：本服务没有任何接受分数、权重或同伴投票的方法，同伴因此无法写入评分。绩效簿持久保存在配置的文件或存储接缝上。

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

在作出派活决策的地方挂载本包：后续轮次读取它来决定运行多少候选 N、以及选择哪个候选（§6.4）。先选择介质——要么是文件路径，不需要其他包；要么是存储接缝，需要在本行之前挂载存储枢纽与后端。

```yaml
- name: '@dsh-fleet/ledger'
  config:
    ledgerFile: /srv/team/state/ledger.json
    maxEntries: 200
```

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
  config: { root: /srv/team/state }
- name: '@dsh-fleet/ledger'
  config:
    storageKey: fleet/ledger
    storageBackend: json
```

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `storageKey` | `fleet/ledger` | 存储接缝中保存绩效簿文档的记录键 |
| `ledgerFile` | 未设置 | 绩效簿文件的绝对路径；设置后绩效簿持久保存在该处，不使用存储接缝 |
| `storageBackend` | `json` | 未配置文件时，承载绩效簿单元的已注册后端 |
| `maxEntries` | `200` | 每个成员保留的结果条目与评分输入上限；保留最新者 |

### 你得到什么

| 调用 | 结果 |
|---|---|
| `record(entry)` | 追加一条主 agent 决定的结果：成员、任务、角色、结果、轮数、可选成本 |
| `recordInput(input)` | 追加关于某个成员的原始同伴信号与红军缺陷计数 |
| `recordOf(memberId)` | 该成员由其保留条目派生的聚合，没有记录时为 `undefined` |
| `ranking()` | 所有成员的聚合，按排名顺序 |
| `inputs(memberId)` | 某个成员被记录下来的评分输入，原样返回 |

聚合为 `{ memberId, entries, accepted, reworked, failed, meanRounds }`。`ranking()` 以确定性的方式排序聚合：`accepted` 多者在前，其次 `meanRounds` 低者在前，再次 `failed` 少者在前，最后按 `memberId` 的码元顺序，因此派活决策从不依赖扫描顺序。

### 评分权

成员的记录意味着什么，只由主 agent 决定。同伴信号与红军缺陷计数是证据：记录它们不改变任何计数器，也不改变任何排名。这里没有分数、权重或投票的写入路径——这不是政策约定，而是本服务与其数据模型根本没有这样的字段——因此组内互评的趋同偏差无法进入绩效簿。

### 失败与恢复

- `TypeError` 拒绝未知角色或结果、负数或小数的轮数、空的成员 id 或任务 id、不可用的成本或时间戳，以及格式错误的同伴信号或缺陷计数；消息会点出字段名。
- 代码为 `storage-unavailable` 的 `LedgerError` 表示既没有 `ledgerFile` 也没有可用的存储服务；`malformed-ledger` 或 `unsupported-version` 表示本构建无法读取的持久文档。
- 当 `ledgerFile` 为相对路径、`storageKey` 为空、`maxEntries` 非正，或存储文档无法解码时，加载即失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计概念

- **条目是唯一的权威来源。** 聚合在读取时由保留的条目计算；没有任何地方在条目之外另存 `accepted`、`meanRounds` 或排名，因此两者不可能漂移。
- **输入是证据，不是裁决。** 同伴信号与缺陷计数存放在条目旁边，原样读回。它们没有任何可供分数占用的字段。
- **一份文档，两种介质。** 文件介质与存储接缝保存同一份 JSON 文档，因此选择 `ledgerFile` 只改变绩效簿持久保存在何处，其他一切不变。
- **先提交再发布。** 只有在介质报告写入持久之后才替换内存中的文档，因此被观察到的条目一定是已存储的条目。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、`ctx.ledger`、记录与读取 API |
| [`src/types.ts`](src/types.ts) | `LedgerEntry`、`MemberRecord`、`ScoringInput` 与持久文档 |
| [`src/validate.ts`](src/validate.ts) | 两个方向共用的一套字段校验：写入抛 `TypeError`，读取抛 `LedgerError` |
| [`src/derive.ts`](src/derive.ts) | 由条目聚合，以及有文档记录的排名比较 |
| [`src/store.ts`](src/store.ts) | 文件与存储接缝两种介质，以及打开 KV 单元 |
| [`src/errors.ts`](src/errors.ts) | `LedgerError` 及其错误码 |

### 持久文档

```json
{
  "version": 1,
  "members": {
    "worker-a": {
      "entries": [{ "memberId": "worker-a", "taskId": "task-1", "role": "worker", "outcome": "accepted", "rounds": 2, "recordedAt": 1700000000000 }],
      "inputs": [{ "memberId": "worker-a", "taskId": "task-1", "peerSignals": [], "defects": [{ "severity": "major", "count": 2 }], "recordedAt": 1700000000000 }]
    }
  }
}
```

### 加载顺序

未配置 `ledgerFile` 的部署必须在本包之前挂载存储枢纽及其后端，因为单元在加载时打开一次，介质缺失属于加载失败，而不是静默退化为内存绩效簿。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [集群需求](../../../infra-requirements.dsh.md)——§6.4（绩效簿）、§11 第 9 项、§6.2（主 agent 上报与决定的内容）。
- [worktree 姊妹包](../worktree/README.zh.md)——其选择结果被本绩效簿记录所影响的候选隔离。
- [存储枢纽](../../storage/storage/README.zh.md)——绩效簿所打开单元的后端注册表与 KV 单元契约。
- [存储 JSON 后端](../../storage/storage-json/README.zh.md)——上方示例使用的随包后端。

-----

<a id="model-experience"></a>
## 模型体验

### 绩效簿记账

#### 模型看到什么

本身什么都不看到：本服务不注册工具、不注入提示词段落，也不写会话事件。希望绩效簿抵达模型的调用方自行读取 `ranking()`、`recordOf()` 或 `inputs()` 并决定上报什么；模型可见文本由该调用方负责。

#### token 影响

每个请求的直连 token 为零。

#### KV 缓存影响

与实时请求无关：绩效簿从不触碰请求前缀，因此不会破坏 provider 的缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本包何时不合适。它们是当前的包约束，不是任务清单。

- **留存会丢弃最旧记录**——成员超过 `maxEntries` 后，最旧的条目不再计入其聚合；必须保留完整历史的部署应提高上限或归档该文档。
- **文档由单个服务实例拥有**——指向同一文件的第二个实例在加载时读取、之后整份写入，并发写入者会互相覆盖彼此的成员。每种介质只应有一个绩效簿属主。
- **计数器之外的跨成员比较有限**——排名比较接受数、平均轮数与失败数。成本被记录但不参与排名，因为成本值多少属于主 agent 的判断，而非绩效簿的判断。
- **Team State Repo 留存是部署的职责**——绩效簿只负责让记录持久；把该文件提交进 Team State Repo 并归档，属于 git checkpoint 与归档器包（§7）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确非权威；已交付行为见上文各节与包代码。

- **为何采用整份文档介质**——按成员分记录的布局能让单次写入触及更少介质，但绩效簿的写入频率是每个任务结果一条，整份文档让文件介质与存储介质保持完全一致。
- **加入评分需要什么**——该约束是结构性的，因此日后加入同伴评分意味着在数据模型中增加字段、在服务中增加方法，这是一次可见的契约变更而非开关。这正是预期的代价。
- **后续派活输入**——运行多少候选 N、以及选择哪个候选，是主 agent 依据 `ranking()` 与当前任务的证据作出的决定；绩效簿刻意两者都不计算。

</details>
