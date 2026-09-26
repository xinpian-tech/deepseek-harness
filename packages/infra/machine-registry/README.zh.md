---
description: "机器注册表（ctx.machines）：面向集群组合与维护者，解析、记录或审计某条持久记录属于哪台主机。"
kind: "package-reference"
---

# @dsh-fleet/machine-registry

[English](README.md) | 中文

## 概述

使用 `dsh-machine-registry` 为每台集群主机上的每个进程提供唯一且稳定的机器身份。挂载后，用 `ctx.machines.current()` 读取本进程所在机器的 hostid、别名与 nix system，并让它在每次会话宣告时把该身份记录为持久的 `machine/context` 会话事件。任何写入按机器分片的持久记录的插件都应先挂载它：§7.2 把会话归档 ref、placement 记录与绩效簿全部按这个 id 分片，因此无法解析或不稳定的 id 会同时污染它们全部。它仅供宿主代码使用，对模型没有可见影响。

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

在集群组合中为每个进程挂载一次该服务，位置在任何会记录持久状态的插件之前：

```yaml
- id: fleet-machine-registry
  name: '@dsh-fleet/machine-registry'
  config:
    registryFile: /var/lib/dsh-fleet/machines.json
    alias: worker-07
```

### 何时使用

集群中每台机器都应挂载它。不写任何按机器分片的持久记录的组合可以省略它，但此后任何需要分片 id 的插件都必须自行解析，而这正是本包要消除的重复。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `machineId` | 解析得出（见下） | 显式机器 id；优先于其他所有来源 |
| `alias` | 无 | `current()` 报告的人类可读标签 |
| `registryFile` | 无 | `list()` 直读的持久 JSON 注册表的绝对路径 |
| `nixSystem` | 平台三元组 | 平台表无法拼写的宿主的 nix system 覆盖值 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个可接受字段及其 JSDoc 的完整来源。

### 机器 id 解析

顺序与 `infra/scripts/machine-id.sh` 完全一致，因此插件与集群的 shell 工具在任一台主机上始终得到同一个结果：

1. 本插件配置中的 `machineId`。
2. 进程环境中的 `DSH_FLEET_MACHINE_ID`。
3. `/etc/machine-id`，然后是 `/var/lib/dbus/machine-id` —— 按此顺序读取的 systemd hostid。
4. 主机名，用于没有 systemd 的宿主。

每个候选值都会去掉空白字符，空候选值落到下一个来源，最终结果必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` —— 该 id 会成为 git ref 路径片段（`refs/dsh/machines/<id>/…`）与注册表键，因此无法充当该片段的 id 会在加载时失败，而不是被静默改写。

### nix system 解析

配置中的 `nixSystem` 优先。未配置时，三元组由 `process.platform` 与 `process.arch` 按 nix 自身的拼写推导：`linux-x64` → `x86_64-linux`，`linux-arm64` → `aarch64-linux`，`linux-arm` → `armv7l-linux`，`darwin-x64` → `x86_64-darwin`，`darwin-arm64` → `aarch64-darwin`。其他组合在加载时抛错：拼不出自身 nix system 的主机同样无法构建它要运行的 flake，而猜出来的三元组会被写进该机器的每一条持久记录。

### 你能得到什么

- `current(): MachineContext` —— 加载时解析一次、以纯 JSON 返回并冻结的 `{ id, alias?, nixSystem, hostname }`。`hostname` 是观测到的主机名，只作诊断上下文，永不作为身份输入。
- `list(): readonly MachineContext[]` —— 已配置注册表文件的条目，每次调用都重新读取。不推导、不缓存、不追加，因此本进程所在的机器只有在文件列出它时才出现。未配置 `registryFile` 时该调用抛错，而不是暗示集群为空。
- 每次会话宣告时一条持久的 `machine/context` 会话事件，内容与 `current()` 完全一致。

### 注册表文件

`registryFile` 是一个 JSON 对象，`machines` 按文件顺序列出集群的机器：

```json
{
  "machines": [
    { "id": "3f2a1c…", "alias": "worker-07", "nixSystem": "x86_64-linux", "hostname": "worker-07" }
  ]
}
```

`id`、`nixSystem` 与 `hostname` 是必填的非空字符串，`alias` 可选，同一个 id 只能出现一次。相对路径、读不到的文件、无法解析的 JSON、非法条目或重复 id 都会导致加载失败；进程运行期间文件被改坏，则会让读取它的那次 `list()` 调用失败。

### 失败与恢复

`registryFile` 为相对路径或读不到、平台三元组未知、配置的 `alias`／`nixSystem` 为空、或解析出的 id 无法充当 ref 片段时，加载都会失败。这些都是自包含的配置错误，因此进程拒绝启动，而不是记录一个错误或缺失的分片 id。加载完成后服务自身不再做任何 IO：`current()` 不会失败，只有 `list()` 会再次读取注册表文件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 设计要点

- **每台主机一个身份，只解析一次。** id 与 nix system 在构造函数中解析并冻结，因此后续调用不会依赖可变的环境或 cwd。
- **在宣告时留下持久记录。** 会话宣告时即把身份追加进该会话的日志，早于任何可能产生分片记录的 turn。
- **注册表是观测面。** 条目只来自文件；`current()` 从不查询它，因此集群注册表与主机自身身份不会互相漂移。

### 源码导航

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、id 与 nix system 解析、注册表校验、会话记录 |
| [`src/types.ts`](src/types.ts) | `MachineContext`、注册表文件类型与 `machine/context` 事件声明 |

### 身份解析

`resolveMachineId()` 把来源作为参数接收，因此解析顺序无需触碰 `/etc` 即可被验证，shell 解析器的行为在测试中可复现。`readRegistry()` 是持久文件的唯一读取者，每次调用都校验结构、必填字段与重复 id。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [infra-requirements.dsh.md](../../../infra-requirements.dsh.md) —— §11 第 10 项（本包）、§7.2（按机器 id 分片的 refs）与 §10（`MachineId = hostid`）。
- [machine-id.sh](../../../infra/scripts/machine-id.sh) —— 本包与之保持一致的 shell 解析器。
- [fleet.nix](../../../infra/nix/fleet.nix) —— `configGeneration` 记录以及本组合随其发布的集群运行时。

-----

<a id="model-experience"></a>
## 模型体验

### 机器身份注册

#### 模型看到什么

没有。该服务不注册任何工具，也不注入提示词。`machine/context` 会话事件只写日志：它是 durable 记录，而不是模型可见面，因此任何请求都不会携带机器 id。

#### token 影响

每个请求的直接 token 为零。

#### KV 缓存影响

与在线请求无关：解析或记录机器身份不会改变任何请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明注册表做不到什么。它们是本包当前的约束，不是任务清单。

- **在本插件挂载之前宣告的会话没有 `machine/context` 事件** —— 记录器是 `session/created` 监听器，因此插件加载时已在存储中的会话保持它原有的机器记录。
- **`list()` 每次调用都读文件** —— 注册表是可能被其他进程改写的持久状态；没有缓存也没有变更通知，被改坏后的下一次 `list()` 会失败。
- **没有跨机器校验** —— 不会检查两台主机是否解析出同一个 id；让 id 在集群内唯一是运维方通过 `DSH_FLEET_MACHINE_ID` 承担的约定，与 shell 解析器一致。
- **nix system 表只覆盖本仓库构建的系统**（Linux x86_64／aarch64／armv7l，macOS x86_64／aarch64）。其他宿主必须显式给出 `nixSystem`，否则加载失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与未定方向。它明确不具权威性——已发布的行为与限制以上文各节及包内代码为准。

- **注册表写入** —— 本包不写注册表文件；集群的置备流程或后续的绩效簿包负责该写入路径。
- **别名来源** —— 别名来自配置而非注册表查询，因此在注册表中被改名的宿主仍会报告其配置的别名。

</details>

**运行时不变式：** 不发布伴生模块。该服务持有唯一不可变身份与一个监听器；不存在可能发散的两个独立观测之间的关系，因此不变式伴生模块只会重复服务存在性。
