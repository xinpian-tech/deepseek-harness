---
description: "fleet 的 nix-only 沙箱后端：面向组合、配置或调试这样一个工作区的用户与维护者——其中只有 flake store、session 工作区与一个私有临时根目录可见。"
kind: "package-reference"
---

# @dsh-fleet/nix-sandbox

[English](README.md) | 中文

## 概述

在命令必须运行于一个 nix-only 世界里的地方挂载本包：只读的 `/nix/store`、session 工作区与一个私有临时根目录，PATH 由 store 目录重建，并且除非部署主动开启，否则没有网络。作为 process-sandbox seam 的一个后端，它给一次受限的 bash 调用一个无法触达宿主上任何其他东西的进程。`ctx.fleetSandbox` 把生效的 profile 作为纯数据报告出来，任务验收证据引用的就是它。需要带 bubblewrap 的 Linux，且 harness 可执行文件必须来自 flake store；其他任何宿主都会以 `SANDBOX_UNAVAILABLE` 快速失败。

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

在组合原本会挂载 `sandbox-local` 的地方挂载本提供方：它注册为 `ctx.sandbox`，因此现有的 bash 与文件系统消费方继续工作，而每次受限调用都获得一个它们自己从不表达的可见性决策。

### 何时选用

为必须只依赖 flake 的 fleet worker 选用它（[`infra-requirements.dsh.md`](../../../infra-requirements.dsh.md) §2.2 第一层）：store 是唯一的依赖来源，工作区是唯一 durable 的可写位置，而装在宿主上的包管理器不只是不被鼓励，而是根本不存在。当宿主是 macOS 或 Windows、当命令必须触达工作区之外的宿主路径，或当部署没有可用于派生 PATH 的 flake 时，改用 `dsh-sandbox-local`——本后端拒绝这些宿主，而不是去近似它们。

### 最小配置

替换组合中的沙箱行；该 seam 每个上下文只允许一个提供方，因此把本包与 `dsh-sandbox-local` 挂载在一起会在加载时失败，而不是静默选择其中一个。

```yaml
- id: sandbox
  name: '@dsh-fleet/nix-sandbox'
  config:
    storePath: /nix/store
    writableRoots: []
    network: false
    allowPackages: []
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `profileName` | `nix-only` | 解析出的 profile 携带、并被验收证据引用的名字 |
| `storePath` | `/nix/store` | 以只读方式绑定的绝对 store 路径；加载时必须存在 |
| `writableRoots` | `[]` | 授予每次调用的额外绝对可写根目录；session 工作区按调用加入，不属于这里 |
| `network` | `false` | 共享宿主网络命名空间；这是对必须获取 flake 输入的调用的显式开启 |
| `allowPackages` | `[]` | 被重新放回受限 PATH 的包管理器名；这是一次刻意的削弱，记录在 profile 上 |

本插件把该 schema 导出为 `Config`，而 [`src/index.ts`](src/index.ts) 是它的完整声明；fleet 包没有生成的目录条目。

### 受限进程看到什么

受限命令在自己的 mount、PID 以及（默认情况下）网络命名空间中运行。其中存在的正是 profile 列出的那些路径：只读的 store、发起调用的 session 的工作区、部署的可写根目录，以及宿主临时根目录上一个其他任何东西都看不进去的私有空 tmpfs。PATH 由 harness 自己 PATH 中位于 store 之下的那些目录重建，临时根目录被导出为 `TMPDIR`。提供包管理器的 store 目录会整体被排除在该 PATH 之外；`allowPackages` 指出部署刻意恢复的那些管理器。

### 读取生效的 profile

`ctx.fleetSandbox.profile()` 返回部署的 profile，而 `profile({ workspaceRoot, mode })` 返回一次调用实际得到的东西——与 `confine()` 所用相同的派生，作为任务可以引用的数据：

```ts
ctx.fleetSandbox.profile({ workspaceRoot: '/srv/ws/task-7', mode: 'workspace-write' })
```

### 失败与恢复

无法运行该 profile 的宿主——不是 Linux、没有 bubblewrap，或 harness 可执行文件在 store 之外——会让第一次 `confine()` 以该 seam 的 `SANDBOX_UNAVAILABLE` 错误失败，因此消费方报告的是不可用的沙箱，而不是一次未受限的命令。配置格式错误会更早在插件加载时失败：相对的或缺失的 `storePath`、相对的、缺失的或与 store 重叠的可写根目录、空的 profile 名、指定了该 profile 并未屏蔽的任何管理器的 `allowPackages` 条目，以及没有 flake 提供的工具目录的 PATH，都会在任何命令运行之前阻止该组合。命名空间内被拒绝的写入会以后端的拒绝方言浮现，而命令启动前 bubblewrap 的拒绝会以 runner-failure 签名浮现。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节说明该扩展点与 profile 背后的派生；可观察的行为在[使用本包](#use-this-package)中已完整覆盖。

### 扩展点，以及 seam 无法表达的部分

该 seam 的约定是 `SandboxProvider.confine(argv, policy)`：后端返回要 spawn 的 argv，而不是调用方自己的 argv，并给出描述它如何治理该策略的文件效应的强制执行完整度、拒绝签名与 runner-failure 规则。三种模式（`read-only`、`workspace-write`、`danger-full-access`）只决定写权限，而 `SandboxPolicy` 的任何部分都不携带可见路径、PATH 或网络状态。因此可见性决策存在于 seam 确实允许它的地方——在本提供方的包装里。于是 profile 是对 seam 的追加，而不是能在 seam 内表达的东西：`ctx.sandbox` 仍然回答「这次调用可以在这里写吗？」，而 `ctx.fleetSandbox` 回答「这次调用可以触达什么？」。

seam 中也没有任何东西强制消费方经过本后端。解析出 `danger-full-access` 的组合根本不会调用 `confine()`，而第二个提供方无法与本提供方共存。nix-only 世界成立的范围，恰好就是部署挂载本包并让其策略保持受限的范围；本包的任何部分都无法替该组合做出这个选择。

### Profile 派生

`resolveProfile` 读取配置加上三项宿主事实——进程环境、`os.tmpdir()` 与一次存在性探测——并把 profile 作为数据产出；它在加载时运行一次。PATH 派生保留环境中的顺序，丢弃 store 之外的条目与相对条目，并在某个目录提供了 `allowPackages` 未指名的被屏蔽管理器时丢弃该目录。随后 `effectiveProfile` 把发起调用的 session 的工作区加在 store 之后，并在调用的模式为 `read-only` 时把每一项授权收窄为 `read-only`，两种情况下都让 store 保持只读。

### Runner argv

`confine()` 用 bubblewrap 的方言表达生效的 profile：`--die-with-parent`、带全新 `/dev` 与 `/proc` 的私有 PID 命名空间、每个可见路径一条 `--ro-bind` 或 `--bind`、临时根目录上的 `--tmpfs`（只读调用下再加 `--remount-ro`）、除非部署主动开启否则 `--unshare-net`，以及为受限 PATH 与 `TMPDIR` 设置的 `--setenv`。临时 tmpfs 在每次 bind 之前挂载，因此恰好位于宿主临时根目录之下的工作区或可写根目录不会被它遮蔽。

### 可用性探测

可用性在每个提供方生命周期内只判定一次，做法是用真实的 profile 围绕 `process.execPath` 运行一个空程序。这一次探测同时回答三个问题：内核接受这些挂载、受限 PATH 能执行该 harness，以及 harness 可执行文件位于 store 之内。否定结论会被缓存，之后每次调用都快速失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、加载期解析、两个服务注册 |
| [`src/profile.ts`](src/profile.ts) | profile 解析、校验、PATH 派生、按调用收窄 |
| [`src/provider.ts`](src/provider.ts) | `ctx.sandbox` 后端：探测、包装、强制执行、拒绝与 runner-failure 事实 |
| [`src/service.ts`](src/service.ts) | `ctx.fleetSandbox` 的只读 profile 查询 |
| [`src/types.ts`](src/types.ts) | profile 词汇，仅有类型 |
| — | 不发布运行时不变式伴生模块；本包不拥有事件流或可变关系，它的注册随创建它们的 fiber 一起被移除。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

先看本后端实现的 seam，再看它替换的同类后端，以及渲染其事实的消费方。

- [Process sandbox 子系统](../../../docs/subsystems/sandbox.zh.md)——模式、按调用的策略、拒绝方言与快速失败错误。
- [Sandbox seam 包](../../sandbox/sandbox/README.zh.md)——这里实现的服务约定与提供方角色。
- [本地沙箱后端](../../sandbox/sandbox-local/README.zh.md)——本包在 fleet 组合中替换的按平台提供方。
- [沙箱策略包](../../sandbox/sandbox-policy/README.zh.md)——按调用的模式与工作区根目录的来源。
- [Bash 沙箱执行器](../../shell/bash-sandbox/README.zh.md)——受限消费方，它的结果渲染本后端的事实。
- [Fleet 需求](../../../infra-requirements.dsh.md)——§2.2 第一层与 §11 第 14 项，本包实现的 profile。

-----

<a id="model-experience"></a>
## 模型体验

### 受限结果，间接地

#### 模型看到的内容

经由 [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.zh.md) 与 [`dsh-tool-bash`](../../shell/tool-bash/README.zh.md)，本后端无法强制执行的一次受限调用会渲染 [`dsh-sandbox`](../../sandbox/sandbox/README.zh.md) seam 的 `SANDBOX_UNAVAILABLE` 错误；而文件效应被拒绝的调用会把本后端的拒绝方言（`read-only file system`、`permission denied`）渲染为该 seam 的拒绝标记。因路径在命名空间内不存在而失败的命令读起来是普通失败：可见性拒绝不携带自己的标记。本包不贡献提示词段落、工具或结果文本。

#### Token 影响

只有失败调用的错误或拒绝标记会变得可见，并保留在历史中直到 compaction。本后端强制执行的 profile 不增加 token。

#### KV Cache 影响

仅追加；拒绝与否定文本跟在保留的前缀之后，不会让已有的 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定本后端何时不合适或需要特别的运维注意。它们是本包当前受到的约束，不是通用的沙箱对比，也不是待办清单。

- **该 seam 仍然无法表达可见性。** `SandboxPolicy` 携带模式、工作区根目录与 session id；profile、PATH 与网络状态存在于本包的配置与 `ctx.fleetSandbox` 中。从不调用 `confine()` 的消费方——任何解析出 `danger-full-access` 的东西——完全在本后端之外。
- **每个上下文一个提供方。** 把本包挂载在 `dsh-sandbox-local` 旁边会在加载时以该 seam 的注册错误失败；fleet 替换那一行，而不是在它之上叠加。
- **PATH 过滤以目录为粒度。** 一个 store 目录被整体保留或整体丢弃，因此同时提供工具链与其包管理器的目录要么两者都在，要么两者都不在。在 nixpkgs 上，`node` 与 `npm` 共用一个 store 目录，因此想让 `node` 出现在受限 PATH 上的部署必须在 `allowPackages` 中指名 `npm`，并接受该管理器可达。过滤单个可执行文件需要往命名空间里挂载一个链接农场；这已被推迟。
- **环境是继承的，不是清洗过的。** profile 决定存在哪些路径，而不是命令能看到哪些变量；`HOME`、`DSH_*` 与凭据形态的变量仍会到达受限进程。需要最小环境的调用方必须自己提供一个。
- **bubblewrap 自己的挂载是结构性的。** 每次受限运行中都存在全新的 `/dev` 与私有的 `/proc`，因此「别无其他」指的是宿主文件系统的别无其他，而不是一个空的命名空间。
- **可见性拒绝读起来像文件缺失。** 本后端的拒绝方言排除了 `no such file or directory`，因为真正不存在的文件会产生同样的文本；模型无法把被拒绝的路径与拼写错误区分开。
- **仅限带 bubblewrap 的 Linux。** profile 用 bubblewrap 的挂载与命名空间方言表达，并通过执行它来探测，因此 macOS 与 Windows 宿主快速失败，而 store 之外的 harness 可执行文件即使在 bubblewrap 可用的地方也会让探测失败。
- **store 必须存在，且 PATH 必须来自它。** 没有任何 store 提供的工具目录的加载会被直接拒绝，对于在 `nix develop` 之外启动的 harness，这正是预期的失败；但这也意味着一个只部分填充的环境根本无法启动本插件。
- **`network: true` 共享整个宿主网络命名空间。** 没有按主机或按命令的允许列表，因此这次开启对所挂载的 profile 是整个部署范围的，而不是只作用于需要它的那次 flake 获取。
- **没有任何东西验证一条命令确实在该 profile 下运行。** profile 就是 `confine()` 返回、`ctx.fleetSandbox` 报告的东西；对运行中进程的证明并未尝试。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：尚未确定的方向与未决问题。它明确不具备权威性——已发布的行为、限制与被接受的理据以上文各节和包内代码为准。

- **可执行文件粒度的 PATH 过滤。** 在私有临时根目录里建一个链接农场并挂载进命名空间，就能保留 `node` 同时从同一个 store 目录中移除 `npm`。尚未决定；它每次调用都要付一次目录列举与一次挂载。
- **证明。** 把每次受限调用所运行的 profile 记录下来（作为会话事件），能让评审人从日志而不是从配置重建可见性。该 seam 的「模型可见 ⟺ 记入日志」规则目前到不了 profile，因为 profile 不是模型可见的。
- **第二层。** 在 `nix develop -c` 内执行每条 shell 命令是另一项改动（一个 `ctx.shell` 提供方或一个 bash 包装层）；本包只决定这样的命令能看到什么。

</details>
