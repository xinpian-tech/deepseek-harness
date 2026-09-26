---
description: "fleet 任务携带的机器可判验收标准、它们的 durable session 记录，以及某一层向上回传的未通过项报告。"
kind: "package-reference"
---

# @dsh-fleet/task-spec

[English](README.md) | 中文

## 概述

`@dsh-fleet/task-spec` 让每个任务在被创建的那一刻就获得一份验收约定：由机器判定的标准，记录在任务的 session 上，而不是写进 prompt。§2.4 的 Nix 模板是内置的，因此每一份生成的标准集都要求 `nix flake check`、`nix build .#default` 与 `nix develop -c <project test command>`；没有 flake 的项目会直接失败，不存在主观判断。在某一层创建、委派或判定任务的地方挂载它，也在某一层不信任下一层而重跑验收的地方挂载它。它针对工作区判定 `command`、`schema` 与 `diff` 三类标准，并报告未通过项，而不是散文。

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

在创建、委派与判定任务的组合里挂载本服务。它为 command 类标准读取 `ctx.shell`，为 diff 类标准运行的 git 二进制读取 `ctx.subprocess`，并注册 `ctx.taskSpec`。

### 何时选用

当任务必须在没有评审人意见的情况下被判定，且每一层都必须能重跑同一套验收而不是信任下一层时，选用本包。它是标准词汇的唯一归属：记录任务的层、执行验收的层与报告未通过项的层说的都是这三种标准。需要不同标准的层应当扩展这里的词汇，而不是另加一套并行的；而结果无法由机器判定的任务根本不属于这棵树——不会为它接受任何标准。

### 最小配置

```yaml
- id: task-spec
  name: '@dsh-fleet/task-spec'
  config:
    defaultTestCommand: pnpm test
    defaultTimeoutMs: 600000
    maxCriteria: 64
    workspaceRoot: !!js process.cwd()
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `defaultTestCommand` | 无 | 调用方不传时，`nix develop -c` 标准运行的项目测试命令 |
| `defaultTimeoutMs` | `600000` | 一条标准，以及 `diff` 标准运行的 git 调用的截止时间 |
| `maxCriteria` | `64` | 一份 spec 可携带的标准数上限 |
| `workspaceRoot` | harness 启动目录 | `schema` 目标必须留在其中的绝对根目录；相对值在加载时相对启动目录解析一次，并且必须在那里存在 |

### Nix 验收模板

`nixAcceptance(testCommand?)` 按这个固定顺序返回 §2.4 模板，每一份生成的验收集都携带它：

```ts
{ kind: 'command', run: 'nix flake check',                   expect: { exitCode: 0 } }
{ kind: 'command', run: 'nix build .#default',               expect: { exitCode: 0 } }
{ kind: 'command', run: 'nix develop -c <project test cmd>', expect: { exitCode: 0 } }
```

Nix 是机器总能做出的依赖决策，因此「项目必须使用 Nix」在这里不是提示词指令——它是每个任务都携带的一条验收项。没有 flake 的项目会让 `nix flake check` 失败，任务随即被拒绝，不存在需要人判断的地方。

### 这套词汇存在的三个理由

1. **每一层都能在不信任下一层的情况下重跑验收。** 标准作为 durable 数据记录在任务的 session 上，而不是作为模型会重新解释的提示词文本，因此重跑是确定性的，上一层也能自己检查同样的条目。
2. **上报是一份未通过项列表，而不是散文。** `AcceptanceResult[]` 是可上报单元；稳态下的 `TaskReport` 把未通过的那些向上回传。
3. **纠偏指令就是未通过项加上方向。** 因为这份未通过列表由机器产出、在每一层都相同，返工轮次无需自然语言评判即可执行。

### 本服务做什么

| 方法 | 作用 |
|---|---|
| `nixAcceptance(testCommand?)` | 按顺序返回 §2.4 的三条标准 |
| `validate(spec)` | 拒绝一份机器无法判定的 spec，并指出有问题的字段 |
| `run(criteria, context)` | 针对 `context.workspace` 执行每条标准，把每个结果记录到 `context.recordTo`，并按顺序为每条标准返回一个 `AcceptanceResult` |
| `attach(session, spec)` | 校验并记录 spec，使标准与任务树路径作为 durable 数据到达子 session |
| `report(session, report)` | 记录任务的状态、未通过项与成本 |

拒绝永远不会变成抛出的运行。以非零退出的命令是一条 `failed` 项，携带观测到的退出状态；缺失或无效的 schema 目标记为 `failed`；完全无法尝试的标准——目标在工作区根目录之外、捕获上限截断了证据、工作区不是 git 仓库——记为 `error` 项。调用方为每条标准保留一个结果，而它们中的每一个都在日志里。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 来源

| 文件 | 拥有 |
|---|---|
| `src/index.ts` | 服务、配置解析，以及经 shell 与 subprocess seam 的逐标准执行 |
| `src/criteria.ts` | §2.4 模板、可判定性门禁，以及工作区路径包含 |
| `src/git.ts` | `git` subprocess 调用与变更行总数 |
| `src/types.ts` | 标准、结果与报告的词汇，以及 durable 的 `task/*` 会话事件 |

### 标准与结果如何到达 durable 日志

三个仅入日志的会话事件承载这份约定及其结果。`attach` 为每个任务追加一次 `task/spec`，带有标题、任务树路径、验收标准与轮次上限。`run` 在判定每条标准时追加一条 `task/criterion`，携带任务 id、标准的序号、标准本身、状态与证据细节。`report` 追加 `task/report`，带有状态、未通过项，以及调用方知道时的成本。

回放会重建 `run` 返回的同一个列表：某个任务 id 的 `task/criterion` 记录按日志顺序折叠起来，就是逐字不变的 `AcceptanceResult[]`，因为每条记录复制的是标准与判定本身，而不是指向它们。测试套件针对一次真实运行断言这份相等。

command 类标准经 `ctx.shell` 运行，使用标准自己的 `expect.timeoutMs`，因此部署的执行器保留它的超时上限。diff 类标准以 argv 形式经 `ctx.subprocess` 运行 `git diff --numstat --no-renames HEAD -- <scope>`，从不经过 shell，因此 scope 无法变成第二条命令。schema 类标准读取目标文件，并用仓库强制执行的 JSON Schema 子集，按标准的 schema 校验解析出的 JSON。

### 判定一条标准

`command` 把观测到的退出状态与 `expect.exitCode` 比较，并在存在 `expect.stdoutMatches` 时，用该正则表达式测试捕获到的 stdout。`schema` 在工作区根目录内解析目标——绝对路径或会逃出根目录的路径在任何读取之前就被拒绝——解析它，并报告最早的违规。`diff` 汇总 git 为该 scope 报告的增删行数，并在总数超过 `maxLines` 时失败。

每条被执行的标准都会产生一条记录，无论它通过、失败还是无法尝试，因此只读日志的层看到的验收历史与执行器看到的相同。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [任务约定与验收](../../../infra-requirements.dsh.md)——§2.4（Nix 验收）、§6.1（验收标准）、§6.2（上报）、§11 第 11 与 17 项
- [`@deepseek-ai/dsh-session`](../../core/session/README.zh.md)——记录这些事件的仅追加日志
- [`@deepseek-ai/dsh-tools`](../../core/tools/README.zh.md)——`schema` 标准所用的、被强制执行的 JSON Schema 子集
- [`@deepseek-ai/dsh-shell`](../../shell/shell/README.zh.md)——command seam 及其超时上限

-----

<a id="model-experience"></a>
## 模型体验

### 子 session 的任务引导

#### 模型看到的内容

本包不注册自己的提示词段落、工具或 tool schema。它把验收约定记录在任务的 session 上，而打开子 session 的委派消费方会把记录下来的 `task/spec` 载荷——标题、任务树路径与标准——渲染进该子 session 的引导上下文。子模型把这些标准当作它必须满足的数据来读，而上一层重跑验收时重新读取的正是同一份 durable 载荷。

#### Token 影响

它自己不产生 token：这里没有任何东西进入请求。渲染 spec 的消费方在子 session 的第一次请求中为渲染出的标题、路径与标准付出 token，并为其选择展示的每一条 `task/criterion` 或 `task/report` 付出 token；无论哪种情况，记录都留在 session 日志里。

#### KV Cache 影响

对消费方而言是仅追加且保持前缀的：引导渲染在子 session 打开时即固定，之后的验收记录在父上下文的末尾到达，而不是重写更早的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

它们是本包当前受到的约束，不是待办清单。

- **diff 标准度量的是未提交的工作树。** 它汇总 `git diff --numstat HEAD -- <scope>`，因此 fleet 的逐轮次 commit 已经记录下来的工作会报告为零，未跟踪的文件也完全不计入。要为一个已提交候选的变更设界，需要一个该标准并不携带的基准版本；请把该字段加进标准，而不是在这里猜一个基准。
- **本包中没有任何东西渲染引导提示词。** `attach` 只负责记录；渲染出的文本属于委派消费方，因此使它模型可见的会话事件也属于它。在该消费方落地之前，记录下来的约定是 durable 的，但还没有进入任何模型的上下文。
- **被截断的证据是 error 项，永远不是通过。** 超过执行器捕获上限的命令 stdout，以及超过 64 KiB numstat 上限的 git 输出，都会让一条标准无法判定，并被报告为 `error`；调低这些上限的调用方是用可见的错误判定替换静默的错误判定。
- **`run` 需要一个 session。** `TaskRunContext.recordTo` 是必填的，因此没有 durable 记录时验收无法执行；只想要一次用完即弃检查的调用方不应使用本 seam。
- **没有 `./invariant` 伴生模块。** 本包拥有的唯一关系是服务注册——cordis 已经把它与挂载它的 fiber 配对——以及 durable 记录，后者的一致性由测试套件针对一次真实运行断言。伴生模块会检查服务是否存在或固定示例，而包不变式规则拒绝这类检查。
- **生成的目录跟随本包。** 声明 `task/*` 事件会使 `packages/core/session/src/known-event-types.ts`、`docs/persistence-catalog.md` 与 `docs/config-catalog.md` 变陈旧，直到 `pnpm run gen-persistence-catalog` 与 config-catalog 生成器运行；它们由各自的归属脚本重新生成，而不是手工编辑。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与尚未确定的方向。它明确不具备权威性——已发布的行为与限制以上文各节和包内代码为准。

- **标准的 `base` 应该放在哪里。** 为一个已提交候选设界的 `diff` 标准需要一个比较版本。候选形态（固定的基准 ref、在 attach 时记录的基准，或标准级的 `since`）尚未确定；决定它的地方是标准词汇。
- **谁来渲染引导内容。** 渲染属于打开子 session 的消费方，因为环绕它的提示词段落也属于该消费方。把渲染器排除在本包之外是刻意的：服务因此不包含提示词文本，也不对哪个消费方执行委派做任何假设。
- **基础设施故障下 `error` 与 `failed` 的区别。** 完全无法运行的标准——没有仓库、git 故障、文件不可读——是 `error`；运行了但没有达到其标准的才是 `failed`。正是这一区分让纠偏指令能够把「你的工作有问题」与「工作区无法判定」分开。

</details>
