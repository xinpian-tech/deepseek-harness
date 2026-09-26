---
description: "ConfigGeneration 记录（ctx.configGeneration）：面向集群组合与维护者，记录、摘要或审计每次执行所运行的 flake。"
kind: "package-reference"
---

# @dsh-fleet/config-generation

[English](README.md) | 中文

## 概述

使用 `dsh-config-generation` 记录一个 harness 进程执行时的确切输入：它启动自哪个 flake、该 flake 的 `flake.lock` 的 SHA-256、随源码内置的 `numtide/llm-agents.nix` 修订及其 nixpkgs 修订，以及 nix system。挂载后，用 `ctx.configGeneration.current()` 读取该记录，并让它在每次会话宣告时追加一条持久的 `config/generation` 会话事件。凡结果在事后必须可解释之处都应选择它：§8.1 让一个 `flake.lock` 成为整个集群的版本指纹。它仅供宿主代码使用，对模型没有可见影响。

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

在集群组合中为每个进程挂载一次该服务，位置在第一个任务可以运行之前：

```yaml
- id: fleet-config-generation
  name: '@dsh-fleet/config-generation'
  config:
    # All four fields are optional; a process launched from its own checkout
    # resolves the flake and both files without any configuration.
    harnessVersion: 0.1.7-rc.2
```

### 何时使用

集群的每个 harness 进程——控制面与 worker 一样——都应挂载它，这样每条会话日志都带着自己运行时的修订号。从不需要解释历史结果的组合可以省略它，但此后没有任何记录能区分同一次运行的 flake 修订。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `flakeUri` | 启动所用的 flake | 进程报告的 flake 引用；依次取本字段、`DSH_FLEET_FLAKE_URI`、本模块所在的检出目录 |
| `flakeLockPath` | `<flake 根>/flake.lock` | 参与哈希的 lock 文件的绝对路径；配置的路径必须存在 |
| `vendorRecordPath` | `<flake 根>/infra/nix/vendor.json` | 内置 llm-agents 记录的绝对路径；配置的路径必须存在 |
| `harnessVersion` | 无 | 本次部署钉住的 harness 版本；设置后写入记录 |
| `nixSystem` | 宿主三元组 | 本记录描述的 nix system，供记录自身以外系统的进程使用 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个可接受字段及其 JSDoc 的完整来源。

### flake 解析

默认值是本进程启动自的 flake，按以下顺序取得：

1. 本插件配置中的 `flakeUri`。
2. 进程环境中的 `DSH_FLEET_FLAKE_URI` —— 启动方给出的字符串，与 `infra/nix/fleet.nix` 计算的 `configGeneration.flakeUri = "path:${fleetFlake.outPath}"` 相同。
3. 本模块向上最近的、含有 `flake.nix` 的目录，以 `path:<该目录>` 报告。从源码运行的 harness，以及装在某个检出目录里的包，都会解析到该检出的根目录。

三者都不存在时插件拒绝加载：它无法说出 flake 是哪一个，而猜测出的 URI 会把错误的修订写进每一条记录。

`path:<绝对目录>` 引用同时为另外两个路径提供锚点。`flakeLockPath` 默认为 `<该目录>/flake.lock`，`vendorRecordPath` 默认为 `<该目录>/infra/nix/vendor.json`；每个默认值只在文件存在时生效，因此缺少它们的检出会得到相应字段缺失的记录，而不是指向空处的记录。不指向本地目录的引用（间接或远端 flake）会让两者都保持未设置。

### 记录内容

`current()` 返回纯 JSON，在进程生命周期内冻结：

| 字段 | 来源 |
|---|---|
| `flakeUri` | 解析出的 flake 引用（始终存在） |
| `flakeLockHash` | lock 文件字节的 SHA-256，小写十六进制，加载时计算一次并记忆 |
| `llmAgentsRev` | 内置记录的 `rev` |
| `llmAgentsNarHash` | 内置记录的 `narHash` |
| `nixpkgsRev` | 内置记录的 `nixpkgsRev` |
| `nixSystem` | `nixSystem` 配置，否则为运行宿主按 nix 拼写的三元组 |
| `system` | 同一个三元组，用 `infra/nix/fleet.nix` 对 `pkgs.stdenv.hostPlatform.system` 使用的名字 |
| `harnessVersion` | `harnessVersion` 配置，设置时写入 |
| `recordedAt` | 解析出该记录的那次加载的 ISO-8601 时间戳 |

除 `flakeUri`、`nixSystem`、`system` 与 `recordedAt` 之外的每个字段，在进程无法解析时都会被省略。带占位成分的指纹比缺失的指纹更糟，而配置了却不存在的 lock 文件是加载失败，不是被省略的字段。

### 摘要

`digest()` 返回 `sha256:` 加上以下内容的 SHA-256 的前 16 个小写十六进制字符：对一个按固定顺序持有已解析字段的对象做 `JSON.stringify` 后的 UTF-8 字节——顺序为 `flakeUri`、`flakeLockHash`、`llmAgentsRev`、`llmAgentsNarHash`、`nixpkgsRev`、`nixSystem`、`system`、`harnessVersion`，未解析的字段不出现。`recordedAt` 被有意排除：它说的是记录何时被读取，而不是它描述哪个环境，因此同一修订的两次运行摘要相等，任务记录即可通过附带该摘要把它们归为一组。

### 会话记录

每条被宣告的会话都会收到一条 `config/generation` 事件，内容与 `current()` 完全一致，因此会话日志本身就能说明它运行在哪个 flake 修订之下，任何消费方都不必再去查询运行时。

### 失败与恢复

配置的 `flakeUri`、`harnessVersion` 或 `nixSystem` 为空，配置路径为相对路径，配置的 lock 或 vendor 路径不存在，内置记录无法解析、不是 JSON 对象、或已知字段不是非空字符串，平台组合没有 nix 拼写，以及无法解析出任何 flake URI 时，加载都会失败。加载之后服务不再做 IO：`current()` 与 `digest()` 不会失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 设计要点

- **一次解析，一个时间戳。** 一切都在构造函数中解析，lock 哈希也一样，因此在运行中的进程之下变动的 lock 无法追溯改写已经按旧 lock 跑完的执行。
- **宁缺毋造。** 无法解析的成分在记录中缺席，绝不用占位值或替代来源顶替。
- **摘要覆盖环境，不覆盖观测。** `recordedAt` 是唯一不在摘要内的字段，这正是摘要能作为任务记录分组键的原因。

### 源码导航

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、flake 与路径解析、lock 哈希、内置记录读取、摘要 |
| [`src/types.ts`](src/types.ts) | `ConfigGeneration`、内置记录类型与 `config/generation` 事件声明 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [infra-requirements.dsh.md](../../../infra-requirements.dsh.md) —— §11 第 12 项（本包）与 §8.1（以一个 `flake.lock` 作指纹，生产环境钉 release tag）。
- [fleet.nix](../../../infra/nix/fleet.nix) —— 本记录在运行时复现其字段的 `configGeneration` 属性集。
- [vendor.json](../../../infra/nix/vendor.json) —— 本包读取的内置 llm-agents 记录。

-----

<a id="model-experience"></a>
## 模型体验

### 版本指纹注册

#### 模型看到什么

没有。该服务不注册任何工具，也不注入提示词。`config/generation` 会话事件只写日志：它是 durable 记录，而不是模型可见面，因此任何请求都不会携带 flake URI 或 lock 哈希。

#### token 影响

每个请求的直接 token 为零。

#### KV 缓存影响

与在线请求无关：解析或记录该指纹不会改变任何请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该记录做不到什么。它们是本包当前的约束，不是任务清单。

- **代码不在 flake 检出内的 harness 必须自报 flake** —— 模块锚点默认值在没有任何 `flake.nix` 的 store 路径下什么也找不到，因此这类部署要设置 `flakeUri` 或 `DSH_FLEET_FLAKE_URI`；随包发布的集群组合挂载该行时不带任何配置。
- **lock 哈希是加载时刻的快照** —— 比一次 lock 变更活得更久的进程会继续报告启动时的哈希；这是有意的，重新读取只能作为一条新记录，而不是对这条记录的改写。
- **内置记录只与文件本身一样可靠** —— 本包读取 `rev`、`narHash` 与 `nixpkgsRev`，但从不拿它们与内置 flake 自己的 lock 对照校验（那是 `infra/nix/fleet.nix` 在构建时做的断言）。
- **宿主三元组与机器注册表各自独立推导** —— 本包的 `nixSystemFor()` 与 `@dsh-fleet/machine-registry` 的同名函数共用表格却不共用代码，因为在不变式 R-0 下，fleet 包要么无法共享辅助模块（缺少仓库级别名条目），要么需要一次工作区安装把某个 fleet 包链接进另一个。
- **`recordedAt` 是墙上时钟时间戳** —— 它是观测元数据，不是指纹的一部分，而且集群各机器的时钟并不同步。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与未定方向。它明确不具权威性——已发布的行为与限制以上文各节及包内代码为准。

- **共享 nix system 推导** —— 一个 `@dsh-fleet/fleet-platform` 辅助包，或为 fleet 包增加 `paths` 条目，可以去掉重复的表格。
- **读取 flake 自身的 store 路径** —— 导出 `DSH_FLEET_FLAKE_URI` 的启动方会让环境来源在生产中成为权威，这也是运行时导出后预期的部署形态。

</details>

**运行时不变式：** 不发布伴生模块。该服务持有唯一不可变记录与一个监听器；不存在可能发散的两个独立观测之间的关系，因此不变式伴生模块只会重复服务存在性。
