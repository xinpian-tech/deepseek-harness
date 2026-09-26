---
description: "在 flake 环境内而不是宿主上运行每条 shell 命令的 ctx.shell 提供方，面向不允许命令改动机器的 fleet 组合。"
kind: "package-reference"
---

# @dsh-fleet/nix-shell

[English](README.md) | 中文

## 概述

挂载本提供方，使 `nix develop <flakeRef> -c bash -lc <command>` 成为 shell 命令唯一的运行方式。安装软件包的命令会把它装进一次性的 flake 环境，或者在那里失败，因此任何命令都无法改变它运行所在的机器，而每条命令的工具都来自 flake，而不是来自 harness 进程。把它挂载在 `@deepseek-ai/dsh-bash-sandbox` 的位置上，并由同一个组合禁用它，因为一个组合只能持有一个 `ctx.shell` 实现。

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

在禁用 base profile 的执行器之后，把本提供方挂载进 fleet 组合：

```yaml
- id: bash-sandbox
  disabled: true

- insert:
    - id: fleet-nix-shell
      name: '@dsh-fleet/nix-shell'
      config:
        timeoutMs: 60000
```

### 何时选用

当命令必须无法改动宿主时选用它：`pip install`、全局的 `pnpm add -g`，或对 `/etc` 下文件的修改，要么落进 flake 的一次性环境，要么在那里失败。当命令必须在宿主上按文件策略运行时，改用 `@deepseek-ai/dsh-bash-sandbox`——本提供方不提供宿主路径，而它的 `flakeRef` 是加载期常量，因此同时需要宿主命令与 flake 命令的组合需要两个进程，而不是两行配置。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `flakeRef` | `.` | 环境来源的 flake；加载时相对 harness 启动目录解析 |
| `nixBin` | `nix` | nix 可执行文件，加载时在 `PATH` 上或按路径解析 |
| `developTimeoutMs` | `300000` | 为兑现 flake 环境而加到每条命令截止时间上的毫秒数 |
| `mode` | `develop` | `develop`（`nix develop`）或 `shell`（`nix shell`） |
| `extraArgs` | `[]` | 插入在 flake 引用与 `-c` 之间的额外 nix 参数 |
| `timeoutMs` | `120000` | 加入准备预算之前，每条命令默认的截止时间 |
| `maxTimeoutMs` | `600000` | 调用方自带 `timeoutMs` 的上界 |
| `maxOutputBytes`, `maxSpillBytes`, `graceMs`, `cwd` | 见目录 | 继承自本地执行器的输出、spill、终止宽限与工作目录预算 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个可接受字段及其 JSDoc 的完整来源。

`extraArgs` 承载随部署而异的 nix 标志，例如 `--no-write-lock-file`；默认值为空，因此由部署显式开启。`developTimeoutMs` 与 `timeoutMs` 分开，是因为 `nix develop` 可能在命令开始之前获取或构建开发环境：解析后的截止时间是命令预算加上准备预算，并封顶在可调度的最大定时器上，而 `ShellRunResult.timeoutMs` 报告的就是这个和。

### 命令看到的内容

在 flake 内而不是宿主上运行命令带来三个后果，每一个都值得单独说明：

- **安装软件包的命令无法改变机器。** 安装会进入 flake 的环境，并在命令结束时被丢弃；或者因为该环境是只读且无特权的而失败。这里没有允许列表，也没有命令黑名单：让命令无害的是环境本身，而不是模式匹配。
- **命令可由 flake 复现。** 命令解析到的工具来自组合指定的、已锁定的 flake，因此同一条命令在 fleet 的两台机器上运行时解析到同样的程序，而不是各自宿主碰巧装了什么。
- **宿主 PATH 不是命令看到的东西。** `nix develop` 把 flake 的开发环境覆盖在启动环境之上，因此 `PATH` 及其背后的程序都是 flake 的。harness 进程设置而 flake 未提及的变量仍然可见，因为 `nix develop` 默认是非纯的；环境内 `IN_NIX_SHELL` 为 `impure`，这是命令用来判断自己在哪里运行的那一个标记。

### 失败与恢复

加载失败属于配置错误，会在任何命令运行之前停止进程：无法解析的 `nixBin`、作为路径传入但不是包含 `flake.nix` 的目录的 `flakeRef`、非正数的 `developTimeoutMs` 或 `timeoutMs`，或空的 `extraArgs` 条目。加载之后，命令的非零退出、截止时间终止与中止终止都是普通结果；一次从未产生进程的 spawn 会让 `result()` 拒绝。flake 本身按命令解析，因此不可达的 flake 输入会让每条命令都带着 nix 自己在 stderr 上的诊断失败，而不是在加载时失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计理念

- **继承消费沙箱的执行器。** `NixShellExecutor` 继承 `@deepseek-ai/dsh-bash-sandbox`，因此部署的沙箱策略仍然约束该进程，`ctx.shell` 仍然只有一个实现，进程相关的管线也留在一处。
- **改写 argv，而不是策略。** 唯一的行为变化是 spawn 哪个 argv；输出捕获、截止时间、取消、写路径检测与强制执行事实都属于 base 实现。
- **路径只在加载时解析一次。** nix 可执行文件、flake 路径与各项预算在插件加载时即固定，因此之后的任何调用都不依赖可变的 `PATH` 或工作目录。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务类、config schema、加载期解析与校验 |
| [`src/command.ts`](src/command.ts) | 纯调用辅助：argv 构造与 shell 词引用 |

### 命令改写

`nixShellArgv()` 返回一条命令实际运行的确切 argv：

```
[nixBin, 'develop' | 'shell', flakeRef, ...extraArgs, '-c', 'bash', '-lc', command]
```

`nix <mode> -c <argv…>` 会在环境内 exec 余下的 argv，因此调用方的命令文本就是一个 argv 元素，`ls`、管道与 heredoc 都按原样到达 shell。命令中的任何内容都不由 nix 解析。

shell seam 自己的 `bash -c` 层位于该 argv 之外，由 `shellCommandLine()` 渲染：每个元素都变成一个单引号词，因此含有空格、引号或 `$` 的命令会作为同一个元素存活下来，而不是被重新拆分或展开。那条 shell 行是本包构造的唯一 shell 字符串，其中没有任何部分以未引用的方式被插值。

改写发生在 `execute()` 而不是 `resolve()` 中，因为 `execute()` 是调用方无法绕过的方法：插件手工构造的 spec 仍然在 flake 内运行，而从 `resolve()` 得到的 spec 则保留调用方自己的命令文本，用于展示与 job 标签。

### base 执行器仍然拥有的部分

`resolve()` 委托给消费沙箱的 base，只加上准备预算；`execute()` 在替换命令之后把其余一切委托出去。base 又继承自本地执行器：经 `ctx.subprocess` 的 spawn、带 spill 文件的 stdout/stderr 捕获、融合后的截止时间、中止分类、SIGTERM 到 SIGKILL 的升级、后台读取，以及组合 dispose 时对运行中进程的销毁。沙箱模式、强制执行与拒绝事实由 base 依据 `ctx.sandbox` 对本包交给它的那个 argv 的回答打上标记。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [infra-requirements.dsh.md](../../../infra-requirements.dsh.md)——§2.2 第二层，本包实现的结构性强制执行。
- [bash-sandbox](../../shell/bash-sandbox/README.zh.md)——本类继承的执行器，它同时仍然是该沙箱的消费方。
- [shell](../../shell/shell/README.zh.md)——`ctx.shell` 的 Service Definition、它的 request/spec 拆分，以及每个执行器都必须遵守的生命周期。
- [flake.nix](../../../flake.nix)——fleet 命令运行所在的开发环境。

-----

<a id="model-experience"></a>
## 模型体验

### Bash 工具调用

#### 模型看到的内容

它写下的 `bash` 工具调用原样，以及该命令自己的 stdout、stderr 与退出码。transcript 中没有任何东西表明这条命令在 flake 内运行：没有提示词段落，没有 tool schema 字段，也没有被改写后的命令被回显。假设自己处在宿主环境中的模型看到的仍是普通的命令失败；flake 无法兑现时，nix 的求值与构建诊断出现在 stderr 上。

#### Token 影响

零直接 token：没有 schema 字段，没有 `ctx.shell` 提示词段落，也没有额外消息。唯一的 token 影响取决于数据——flake 无法兑现时 nix 自己的诊断，它们作为普通命令输出到达。

#### KV Cache 影响

没有影响。tool schema 与请求前缀都没有变化，因此挂载本提供方不会让任何已缓存的前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本执行器何时不合适。它们是本包当前受到的约束，不是待办清单。

- **没有宿主执行路径**——必须在宿主上生效的命令没有经本提供方的受支持途径，而一个组合只能持有一个 `ctx.shell`，因此混用宿主命令与 flake 命令意味着分成多个进程，而不是多行配置。
- **每个执行器一个 flake，加载时固定**——`flakeRef` 在插件加载时解析，因此 flake 位于别处的工作区需要自己的组合或一次重新加载；逐命令选择 flake 已被推迟。
- **每条命令都要付出 flake 解析的代价**——`nix develop` 为每条命令解析 flake，因此不可达的 flake 输入或冷环境会让每条命令失败或延迟，而不只是第一条。
- **`nix shell` 不导出环境**——`mode: shell` 只把 installable 的 `bin` 放进 `PATH`；需要开发环境变量的命令必须使用默认的 `develop`。
- **本包不锁定 flake**——写入还是禁止更新 `flake.lock` 是 flake 与部署方的决定，因此 `--no-write-lock-file` 及其同类参数属于 `extraArgs`。
- **不强制 `--impure`**——`nix develop` 会保留 harness 进程设置的变量；需要干净环境的部署必须在组合中清除它们，因为本包不清洗这些变量。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与尚未确定的方向。它明确不具备权威性——已发布的行为与限制以上文各节和包内代码为准。

- **逐命令 flake**——携带多个 flake 的工作区需要一个 shell seam 今天没有的 request 字段；request 词汇属于该 seam，因此这要等它，而不是等一个包装层。
- **锁文件策略**——固定还是冻结 `flake.lock` 是 fleet 层面的决定；`extraArgs` 是当前的载体，专用字段需要部署方为某一种拼写提供证据。
- **准备时间的记账**——准备预算与命令计入同一个截止时间，因此异常缓慢的兑现会缩短命令自己的时间窗口，而缩短了多少调用方无法单独看到。

</details>

**运行时不变式：** 不发布伴生模块。本执行器拥有一份已解析配置，加上基类的进程内状态；这里没有任何东西观察可能背离的独立关系，因此不变式伴生模块只会复述服务是否存在。
