---
description: "面向 fleet 组合与审计者的提示词来源标注：把 leader 或 peer 下达的 prompt 绑定到它 durable 的 prompt/source 记录，并从已存储的 session 数据里读回该记录。"
kind: "package-reference"
---

# @dsh-fleet/prompt-source

[English](README.md) | 中文

## 概述

当 session 日志必须说明一条 prompt 来自人还是来自 leader 时，使用 `dsh-prompt-source`。SDK JSON-RPC 服务器把它服务的每条 prompt 都标为 `source: { kind: 'user' }`，因此一旦 fleet 移除消息传递类的来源取值，leader 的指令与人的消息就完全一样。本包拥有一套按请求作用域的标签注册表，外加一条携带来源的 prompt 路径，把解析出的标签记录为仅入日志的 `prompt/source` 会话事件，`kindOf` 再从 durable 存储而不是内存里读回它。它不改变模型请求看到的任何东西：投递的消息就是 SDK 服务器构造的那一条。

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

在每个 prompt 必须可归因的组合里挂载本服务——worker pane，以及任何向 worker 会话投递 prompt 的进程：

```yaml
- id: fleet-prompt-source
  name: '@dsh-fleet/prompt-source'
  config:
    defaultSource: user
    extraKinds: [curator]
    markTtlMs: 300000
```

### 何时选用

只要一条 prompt 可能来自不止一种调用方，就挂载它。每条 prompt 都由人键入的组合可以省略它，但那样就没有任何东西能把之后由 leader 下达的 prompt 与人的消息区分开，而这正是本包要弥合的审计缺口。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `extraKinds` | `[]` | 在 `user`、`leader` 与 `peer` 之外接受的标签；每个都必须匹配 `^[a-z][a-z0-9-]{0,31}$`，且不得与内置标签重复 |
| `defaultSource` | `user` | 没有待处理标记的投递所解析到的标签；必须是可接受的标签 |
| `markTtlMs` | `300000` | 未被认领的标记保持有效的上界（毫秒） |
| `maxPendingMarks` | `1024` | 同时持有的未认领标记数上限；超出时抛出而不是丢弃标记 |
| `readWindow` | `500` | 回答 `kindOf` 时每次 durable 读取请求的事件数 |

每个字段不可用时都会让加载失败：格式错误或重复的额外标签、不在可接受集合内的 `defaultSource`，或非正数的上界，都会在插件构造期间抛出。

### 你得到什么

- `markNext(requestId, source, sessionId?)`——为该 request id 下投递的 prompt 预留一个标签。绑定 session 的标记只对指名该 session 的调用方可见；对同一 request id 的第二次调用会替换第一次，这正是调用方重试自己那条 prompt 所需要的行为。
- `take(requestId, sessionId?)`——消费该预留一次。第一次 `take` 之后标记就消失了，而未被认领的标记在 `markTtlMs` 之后过期，因此标签无法到达一个并非为它放置的 prompt。
- `prompt(target, { requestId, contentBlocks })`——携带来源的路径。它消费待处理标记（或默认值），构造与 SDK 服务器相同的用户消息，把它交给 `target.followup`，并向 `target.session` 追加 `prompt/source`。存活的 `Agent` 在结构上满足 `PromptTarget`，因此通常的参数是 `ctx.agents.get(id)`。
- `kindOf(sessionId, messageId)`——审计答案，通过 `ctx.sessionPersistence` 以 `readWindow` 大小的分片从已存储的 session 事件中读取。本进程从未存储过的 session 回答 `undefined`；没有任何内存内状态参与其中。
- 一个仅入日志的 `prompt/source` 事件，携带 `{ sessionId, messageId, requestId, source }` 纯 JSON，因此该记录会随日志的其余部分一起回放。

### 失败与恢复

`markNext` 对不在可接受集合内的标签抛出 `TypeError`，在达到 `maxPendingMarks` 时抛出 `PromptSourceError`——注册表已满会被上报，而不是静默丢弃一个之后审计会漏掉的预留。没有挂载持久化服务时，`kindOf` 抛出 `PromptSourceError`；已存储的日志无法读取时，它上报存储自己的拒绝。标签注册本身是所挂载 fiber 的一项 effect：dispose 插件会移除该服务、它的标签集合与所有待处理标记。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计理念

- **绑定的是 request id，不是 session。** 标记以调用方的关联 id 为键，且只被消费一次，因此同一个 session 上的两条 prompt 无法继承彼此的标签；可选的 session 绑定会让范围更窄。
- **日志就是答案。** `kindOf` 从不查询注册表：重启之后注册表是空的，而由它推出的猜测会把 leader 的指令重新标成人的消息。
- **消息本身不被改动。** 投递的消息完全按 `@deepseek-ai/dsh-sdk-jsonrpc-server` 的构造方式构造——内容加上 `{ kind: 'user' }`——因此 LLM seam 的任何消费方都不会遇到它没有声明的来源取值，模型请求也不会变化。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、标签校验、注册表、携带来源的 prompt 路径、durable 读取 |
| [`src/types.ts`](src/types.ts) | `PromptSourceMark`、`PromptSourceRecord`、`PromptTarget`，以及 `prompt/source` 事件声明 |

### 本包使用的扩展点

SDK 服务器插件不暴露来源字段所需的任何东西：它从自己的配置创建自己的 `JsonRpcLineTransport`，而 `HarnessSdkJsonRpcServer.handleRequest` 分发的是一组封闭的方法（`initialize`、`session/prompt`、`shutdown`），随后 `prompt()` 用硬编码的来源构造用户消息。`JsonRpcLineTransport.onRequest` 会替换已安装的处理函数，因此第二个插件也无法新增方法。所以本包使用从外部确实存在的两个扩展点：**可合并扩展的 `SessionEventMap`**（durable 记录）与 **`agents` seam 加上基于 `Append` 的 session 写入**（投递路径）。由此产生的缺口在下文精确说明。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [infra-requirements.dsh.md](../../../infra-requirements.dsh.md)——§11 第 5 项（本包）、§12 的末段（它弥合的审计缺口），以及 §5.4（worker 为何常驻）。
- [`packages/sdk/server/src/server.ts`](../../sdk/server/src/server.ts)——本包绕开的硬编码 `source: { kind: 'user' }`。
- [`packages/sdk/protocol/src/transport.ts`](../../sdk/protocol/src/transport.ts)——插件无法扩展的请求/通知分发。
- [`@dsh-fleet/tmux`](../tmux/src/index.ts)——leader 今天用来触达 worker `session/prompt` 的通道。

-----

<a id="model-experience"></a>
## 模型体验

### 提示词归因

#### 模型看到的内容

什么都没有。本插件不注册任何工具，也不注入任何提示词文本。它投递的消息与 SDK 服务器为同样内容构造的消息逐字节相同，而 `prompt/source` 是仅入日志的事件，因此没有任何请求携带该标签。

#### Token 影响

每次请求零直接 token。

#### KV Cache 影响

与实时请求无关：标记一条 prompt 与记录它的标签都不改变任何请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本包做不到什么。它们是当前受到的约束，不是待办清单。

- **SDK 服务器自己的 `session/prompt` 路径仍然没有标签。** 服务器在 `HarnessSdkJsonRpcServer.prompt` 中硬编码 `source: { kind: 'user' }`，而且它既不暴露自己的 transport 实例，也不暴露自己的方法表，更不暴露插件可以贡献的服务。因此直接发送 `session/prompt` 的 leader 仍然产生一条与人的消息无法区分的消息，也没有 `prompt/source` 记录。只有经 `ctx.promptSource.prompt` 的投递——或另一条自己追加该记录的路径——才是可归因的。本项要求的上游改动（在 `session/prompt` 上增加 `source` 字段，也就是修改 SDK 服务器）在 R-0 之下超出新插件的范围。
- **`session/prompt` 参数中无法识别的 `source` 成员会被静默忽略。** 服务器只读取 `sessionId` 与 `contentBlocks`，因此今天自行添加 `source` 字段的部署既得不到记录，也得不到诊断；本包中没有任何东西能观察到这些参数并就此告警。
- **投递的消息仍然声明 `{ kind: 'user' }`。** 标签存在于 `prompt/source` 记录中，通过 `messageId` 与 prompt 关联。只根据 `MessageSource.kind` 分支的消费方看不到区别，这是刻意的：LLM seam 的任何消费方都不应遇到它没有声明的来源取值。
- **记录的关联只靠 request id 与 message id。** 以不同 request id 投递同样内容两次的调用方会产生两条记录，而且没有任何东西检查一个 `requestId` 是否跨进程唯一。
- **标记只存在于进程内，从不 durable。** 因重启丢失的标记会让下一条 prompt 失去标签——它会回退到 `defaultSource`——而 `kindOf` 无法恢复它，因为没有写入任何记录。
- **冷读取需要该事件类型出现在生成的持久化词汇中。** `kindOf` 通过 `ctx.sessionPersistence` 读取已存储事件，而它的读取器会拒绝本构建不认识的事件类型，除非写入方把它标为可忽略。`prompt/source` 是仓库内声明的事件，因此它必须先出现在 `packages/core/session/src/known-event-types.ts` 中（用 `pnpm run gen-persistence-catalog` 重新生成），包含它的已存储日志才会被接受；在那次重新生成落地之前，冷读取会以存储自己的拒绝快速失败，而不是把一条 prompt 标错。同一次重新生成也覆盖其他 fleet 事件（`tmux/placement`、`tmux/interrupt`、`machine/context`）。
- **冷读取用例只在持久化后端能存储 session 的地方运行。** JSONL 后端会加载一个预构建的原生系统 addon；只有源码的检出无法创建该 fixture，因此那一个用例在那种环境里被跳过，而实时日志用例仍然运行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与尚未确定的方向。它明确不具备权威性——已发布的行为与限制以上文各节和包内代码为准。

- **上游修复**——一旦 `session/prompt` 接受 `source` 字段，durable 记录就变得多余；正确的顺序是先在上游加上该字段，让本包的 prompt 路径发送它，并让 `kindOf` 继续读取同一条记录。
- **标签词汇**——`extraKinds` 的存在，是为了让 fleet 能区分本包不认识的签发者；另一种做法是为每个插件一个标签，那会把生产者身份放进 durable 载荷，并迫使每个读取者认识每一个生产者。
- **投递归属**——本包刻意不创建 session 或 agent。如果将来的消费方需要本插件自己解析一个存活的 agent，那次查找属于该消费方，而不属于记录路径。

</details>

**运行时不变式：** 不发布伴生模块。本服务拥有一个标签集合、一个内存内注册表与一条追加路径；不存在可能背离的、由独立观测构成的关系，因此不变式伴生模块只会复述服务是否存在。
