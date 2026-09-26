---
description: "把 Nix 唯一依赖来源规则作为常驻提示词段落，并同步写入每个工作区的 AGENTS.md，供 Codex、Kimi、Claude 读取。"
kind: "package-reference"
---

# @dsh-fleet/nix-mandate

[English](README.md) | 中文

## 概述

`@dsh-fleet/nix-mandate` 让每个在工作区里干活的 agent 始终面对同一条规则：依赖只来自 `flake.nix` 与 `flake.lock`，命令在 `nix develop -c` 里执行，构建产物可丢弃。它把这条规则注册为 order 700 的 dsh system prompt 段落，并把同一段文字写进工作区的 `AGENTS.md`，后者是 Codex、Kimi、Claude 读取的位置。每个部署挂载一次即可：每次会话启动时，本行会创建或刷新自己那一段。这条规则是声明性的，不是强制边界——真正拦住 flake 之外安装的是沙箱 profile 与 `nix develop -c` shell provider。

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

在每台 fleet agent 都会运行的组合里挂载一行；此后 dsh agent 的系统提示词中带有这条规则，它们打开的每个工作区也会在 `AGENTS.md` 里带有同一条规则，供非 dsh harness 读取。

### 何时选用

当部署要求所有依赖来自 flake、所有命令都在 `nix develop` 内执行，并且同一个工作区里会有多个 harness 的 agent 工作时，选用本行——只有 `AGENTS.md` 那一半能到达 Codex、Kimi 与 Claude。工作区没有 flake 时不要挂载，因为此时这条规则只是告诉模型任何任务都无法通过；部署已经自行维护指令文件时也不要挂载，因为同一个文件有两个写入方只会互相覆盖。把规则从"建议"变成"事实"的强制位于沙箱与 shell provider，不在本行。

### 最小配置

```yaml
- id: nix-mandate
  name: '@dsh-fleet/nix-mandate'
  config:
    order: 700
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `order` | `700` | 提示词段落位置；600–800 区间本来无人占用 |
| `workspaceRoot` | 各会话自身的工作目录 | 改为维护这个绝对工作区根目录 |
| `agentsFile` | `AGENTS.md` | 工作区根目录内的指令文件名 |
| `enabled` | `true` | 是否注册段落、`nixMandate` API 与会话监听器 |

[`src/index.ts`](src/index.ts) 中的 `Config` schema 是可用字段的完整清单；相对路径的 `workspaceRoot`、空的 `agentsFile`、会逃出工作区根目录的文件名，或是非有限的 `order`，都会在加载时失败，而不是拖到第一个会话。

### 为什么 order 是数字

`dsh-system-prompt` 上游的 `SECTION_ORDERS` 注册表为每个仓库段落分配一个名字，从 600 的 `TEAM_POLICY` 到 800 的 `PTC_ONLY`。要在那里新增一个 fleet 位置就必须改上游文件，而 fleet 的 R-0 隔离禁止这样做，所以本行改用数字空档：700 把规则放在 team policy 之后、PTC-only 指导之前，同时 `order` 仍是配置字段，部署可以另选位置。

### 文件写入做什么

`ensureAgentsFile` 只拥有指令文件中的一段区域，位于 `<!-- BEGIN dsh-fleet nix mandate -->` 与 `<!-- END dsh-fleet nix mandate -->` 之间。没有这两个分隔符的文件会在一个空行之后追加该块；已有分隔符的文件只替换这一段区域。区域之外的内容永远不会被写入，而当结果与当前文本相同时，调用返回 `unchanged`，不会打开文件写入。两个分隔符都带上 harness 与规则名，读到这段区域的人就知道是哪个插件行在拥有它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计理念

一段文字，两个载体。`renderAgentsBlock()` 把常量 `NIX_MANDATE` 包进文件所需的分隔符与标题，提示词段落注册的也是同一个常量，因此 dsh 提示词与共享指令文件不可能对规则给出不同说法。本行是没有默认导出的函数插件，这正是 Loader 能保住其 `name`、`inject` 与 `Config` 的原因；它通过 `ctx.provide` 发布 `ctx.nixMandate`，让其他插件行无需重复实现即可渲染规则或刷新某个工作区文件。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、加载期校验、段落注册、`nixMandate` API、会话监听器 |
| [`src/mandate.ts`](src/mandate.ts) | 规则文本、分隔符，以及由二者构造的指令文件块 |
| [`src/agents-file.ts`](src/agents-file.ts) | 区域定位、替换、追加，以及写前比较 |

### 会话流程

`session/created` 先确定工作区：配置了 `workspaceRoot` 就用它，否则用 `session.header.cwd`，随后开始写入。写入在监听器返回之后进行，因此会话永远不会因为文件系统故障被否决；失败会记一条警告，指明会话与文件。监听器由 fiber 拥有，所以销毁时它会与段落、API 一起被移除。

### 区域语义

区域定位会拒绝分隔符重复或不成对的文件。这是刻意的：另一种做法——在两段区域里猜哪一段属于自己——会覆盖本行并不拥有的文本，而人工编辑过的文件上大声失败可以恢复，静默覆盖则不能。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [系统提示词子系统](../../../docs/subsystems/system-prompt.zh.md)——段落、组装，以及本行注册所用的有序注册表。
- [工作区指令](../../context/agent-instructions/README.zh.md)——harness 如何读取 `AGENTS.md` 并把它渲染进会话。
- [Fleet 需求](../../../infra-requirements.dsh.md)——§2.3 说明提示词落点，§11 第 16 项说明本行。
- [架构](../../../docs/architecture.zh.md)——本行遵循的插件模型。
- [包约定](../../AGENTS.md)——插件导出形态、配置规则与 README 约定。

-----

<a id="model-experience"></a>
## 模型体验

### Nix 规则 system prompt 段落

#### 模型看到的内容

挂载了本行的组合中，agent 的每一次请求都带有这条规则构成的一个段落，位置在 team policy 段落之后、PTC-only 指导之前。给定配置下文本固定不变，其中写明了依赖来源、命令包装、被禁的安装命令，以及验收命令。

##### 规则段落文本

```markdown
Every dependency of this workspace comes from `flake.nix` and `flake.lock`, and every command runs inside `nix develop -c <command>`.

Do not run `npm install`, `pip install`, `apt install`, `cargo install`, `go install`, or `curl … | sh`, and do not call a tool the flake does not provide: a tool that happens to exist on this machine is not a dependency of this workspace.

Build outputs in the workspace are discardable. Delete them, rebuild them from the flake, and the rebuild produces the same result.

Three commands are machine-checked acceptance items for every task here, and each must exit 0: `nix flake check`, `nix build .#default`, and `nix develop -c <project test command>`. A workspace without a flake fails all three, so no task in such a workspace passes.
```

#### Token 影响

该段落把固定文本加进每个已挂载 agent 的每一次请求，且位于可复用前缀而非保留历史中，从会话的第一次请求起就存在。禁用本行会移除这些 token。

#### KV Cache 影响

只追加且稳定：段落文本不随请求、会话或工作区变化，因此它延长可复用前缀，不会让任何缓存条目失效。改动 `order` 或 `enabled` 会移动或移除该段落，并从该位置起使复用失效。

### 工作区指令块

#### 模型看到的内容

所有读取工作区指令的 harness 中的 agent，都会从工作区的 `AGENTS.md` 里读到同一条规则，它位于一个标题之下、两个分隔符之间。`dsh-agent-instructions` 以自己带来源的消息把该文件呈现给 dsh agent；Codex、Kimi 与 Claude 则各按自己的机制读取该文件。

##### 指令文件块

```markdown
<!-- BEGIN dsh-fleet nix mandate -->
## Nix is the only dependency source

Every dependency of this workspace comes from `flake.nix` and `flake.lock`, and every command runs inside `nix develop -c <command>`.

Do not run `npm install`, `pip install`, `apt install`, `cargo install`, `go install`, or `curl … | sh`, and do not call a tool the flake does not provide: a tool that happens to exist on this machine is not a dependency of this workspace.

Build outputs in the workspace are discardable. Delete them, rebuild them from the flake, and the rebuild produces the same result.

Three commands are machine-checked acceptance items for every task here, and each must exit 0: `nix flake check`, `nix build .#default`, and `nix develop -c <project test command>`. A workspace without a flake fails all three, so no task in such a workspace passes.

<!-- END dsh-fleet nix mandate -->
```

#### Token 影响

对 dsh agent 来说，该块随 `dsh-agent-instructions` 本就会发送的工作区指令消息到达模型，因此本行不额外增加消息，新增的 token 就是该块的字节数。对非 dsh harness 来说，效果取决于那个 harness 自己的指令加载，而该块是规则中唯一能到达它的部分。

#### KV Cache 影响

只追加。该块在会话第一次请求之前就已写好，之后不再变化，因此始终落在读取方本就在复用的前缀之内。两次会话之间重写该区域会改变文件，读取方随即从它渲染该文件的位置起使复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下是本行当前受到的约束及其背后的决定，不是待办清单。

- **规则是建议性的，不是强制的**——本行只是告诉模型部署要求什么。绕过它的调用方，或根本不读提示词的路径，都不受影响；强制的力量属于沙箱 profile 与 `nix develop -c` shell provider。
- **`AGENTS.md` 的所有权是排他的**——本行只写自己的分隔区域，但分隔符重复或不成对的文件会中止写入，而不是靠猜。两个插件行维护同一个文件，或者人删掉了其中一个分隔符，文件都不会被改动，并会记录原因。
- **生成的目录尚未收录本行**——`pnpm run gen-cordis-catalog` 与 `pnpm run gen-persistence-catalog` 从包树生成 `docs/config-catalog.md` 和 `packages/core/session/src/known-event-types.ts`，而在 R-0 之下本次改动不能重新生成上游文件。因此目前[`src/index.ts`](src/index.ts) 中的 `Config` schema 就是字段的完整清单。
- **没有 durable session 事件记录这次写入**——新增一个 `SessionEventMap` 成员会让该事件对本构建的 `KNOWN_SESSION_EVENT_TYPES` 而言是未知类型，而 `Session.append` 的调用方无法把自己的事件标记为 `ignorable`；持久化读取路径随后会拒绝挂载过本行的每一个会话。改为记录日志，而模型可见的后果本来就是可重建的：渲染该指令消息的插件会把它记进日志。
- **不发布 invariant 伴随包**——本行没有跨来源可发散的关系：段落文本与文件块是同一个常量，进程内不存在能与之背离的第二份来源。
- **未注册进任何聚合 tsconfig**——本行的 `tsconfig.json` 是叶子配置，所以 `pnpm run typecheck` 到不了它，在 fleet patch 补上引用之前，覆盖它的是 `tsc -b packages/infra/nix-mandate`。
- **跨进程的并发写入未做串行化**——两个 dsh 进程同时维护同一个工作区文件时可能都执行追加；内容完全相同，文件会收敛，但两者都可能报告 `created`。
- **没有经 Loader 启动的组合测试**——注入 Loader 模块映射的现有写法需要一次 `as unknown` 断言，而 `verify-no-unknown-casts` 禁止新增此类断言，完整实现 Node 内部 loader 接口也不成比例。测试改为挂载真实的 `SystemPrompt` 与 `SessionStore` 服务并驱动真实 `Session`，而不是启动 `cordis.yml`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具备权威性；已发布的行为与限制以上文各节和包内代码为准。

- **order 700 是空档，不是分配。** fleet patch 保持上游文件不动，因此本行无法占用某个 `SECTION_ORDERS` 名字。若上游将来发布 fleet 段落位置，本行应改用该名字，并把 700 保留为默认值。
- **块标题与分隔符是文件格式的一部分。** 去掉分隔符的读者会失去这段区域的所有权信息；[`src/mandate.ts`](src/mandate.ts) 中的常量是二者的唯一归属。

</details>
