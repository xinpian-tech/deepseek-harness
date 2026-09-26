---
description: "把一台机器的 tmux server 变成其他机器可达的 TCP 到 unix socket 桥：内核分配端口，并附带明文、无认证的信任边界。"
kind: "package-reference"
---

# @dsh-fleet/tmux-gateway

[English](README.md) | 中文

## 概述

`@dsh-fleet/tmux-gateway` 让一台机器的 tmux server 可以被另一台机器访问：`serve()` 绑定一个 TCP 监听并把每个被接受的连接转发到本地 tmux unix socket，`dial()` 连接别处的这类桥。端口默认是 `0`，由内核分配一个空闲端口，`address()` 发布实际绑定的地址；`close()` 停止服务并断开现有连接。这座桥按设计是明文且无认证的，只在 fleet 的受控边界之内可以接受（§13），绝不能暴露到边界之外。

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

在 tmux server 需要被其他机器访问的机器上挂载本行，然后启动桥并发布它绑定的地址；对端拨号该地址，并通过返回的 socket 驱动远端 tmux server。

### 何时选用

当 fleet 跨越多台机器，且其中一台上的 pane 必须从另一台访问时选用它，因为 tmux 本身没有网络传输能力：它的 server 监听在只有本地客户端才能打开的 unix socket 上（§5.3）。单机组合不需要它，那里的 [`@dsh-fleet/tmux`](../tmux/README.zh.md) 直接启动本地 tmux 客户端，不经过任何桥。它付出的代价是明确的：这座桥明文承载 tmux 流量，也不认证任何一方（§13），因此它只属于 fleet 已经端到端掌控的网络。

### 最小配置

```yaml
- id: fleet-tmux-gateway
  name: '@dsh-fleet/tmux-gateway'
  config:
    enabled: true
    socketPath: /tmp/tmux-1000/default
    host: 127.0.0.1
    port: 0
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 本机是否提供桥；为 false 时 `serve()` 会拒绝 |
| `socketPath` | 必填 | 本桥转发到的 tmux server socket 的绝对路径 |
| `host` | `127.0.0.1` | 绑定的网络接口 |
| `port` | `0` | 监听的 TCP 端口；`0` 表示向内核申请一个空闲端口 |
| `connectTimeoutMs` | `5000` | `dial()` 的上界（毫秒）；只有拨号一侧读取它 |
| `maxConnections` | `16` | 监听可接受的并发连接数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#dsh-fleettmux-gateway)是字段的完整清单，并带有其源码声明。缺失或相对的 `socketPath` 会让加载失败。

### 服务与拨号

`serve()` 绑定监听并返回它绑定的地址，因此配置了 `port: 0` 的部署可以从返回值或 `address()` 得知内核分配的端口。该调用是幂等的：再次调用会返回正在使用的地址，而不是绑定第二个监听。`connections()` 报告桥当前承载多少连接，`close()` 停止服务并销毁它们，而销毁插件的 fiber 会通过服务自身的 effect 关闭这座桥。

### 信任边界

这座桥是明文且无认证的：没有 TLS、没有凭据、也没有对端身份校验，因此任何能打开该 TCP 端口的东西都能访问其后的 tmux server，并驱动那台机器上的每个会话。默认的 `host` 是回环地址，原因正在于此。绑定可路由的接口是部署的明确决定，并且必须留在 fleet 的受控边界之内；从边界之外可达的机器不应提供这座桥。

### 失败与恢复

无法绑定的 `serve()` 以监听自身的错误拒绝，而 `connectTimeoutMs` 内没有得到应答的 `dial()` 会以 `tmux-gateway: <host>:<port> did not answer in time` 拒绝。当上游 unix socket 无法连接时——tmux 没有运行，或 `socketPath` 指向别的东西——桥会记录 `tmux-gateway: upstream <socketPath> failed: <message>` 并关闭连接的两端，因此调用方观察到的是被关闭的连接，而不是永远不应答的半开连接。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计理念

这座桥拼接字节，而不翻译协议：TCP 监听接受连接，打开配置的 unix socket，并把两个方向互相管道，因此远端 tmux 客户端原样使用自己的协议，这里既不解析也不校验任何 tmux 帧。这正是远端 pane 在 socket 层面与本地 pane 无从区分的原因，也是为什么保证这座桥安全的是信任边界而不是代码。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`、加载期校验、监听生命周期、字节拼接、`dial()`、由 fiber 拥有的关闭 |

### 监听生命周期

监听在 `serve()` 时才创建，绝不在挂载时创建，因此仅仅存在的插件行不会绑定任何东西。它的地址只在 `listening` 触发之后才发布，这正是 `port: 0` 安全的原因：返回的端口是内核分配的那个，而不是请求的零。关闭会先销毁所有存活连接，再关闭监听，而挂载的 fiber 被销毁时走的是同一条路径。

### 连接处理

每个被接受的连接都被跟踪，直到某一端关闭或出错；上游连接失败会记一条警告并丢弃两个 socket，这是调用方对错误 `socketPath` 能得到的唯一信号。拼接不会给已建立的连接设置超时，上游连接也没有自己的定时器：`connectTimeoutMs` 只约束 `dial()`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Fleet 需求](../../../infra-requirements.dsh.md)——§5.3 说明跨机器 tmux，§11 第 3 项说明本行，§13 说明被接受的明文取舍。
- [`@dsh-fleet/tmux`](../tmux/README.zh.md)——本桥让它的 pane 变得可达的通道。
- [生成的配置目录](../../../docs/config-catalog.zh.md#dsh-fleettmux-gateway)——每个可用配置字段及其源码声明。
- [架构](../../../docs/architecture.zh.md)——本行遵循的插件模型。

-----

<a id="model-experience"></a>
## 模型体验

### 跨机器桥

#### 模型看到的内容

没有任何直接内容：没有工具 schema、没有提示词段落、也没有会话事件。这座桥承载的是远端 tmux server 的字节，它的故障只会经由拨号它的消费方到达模型——目前 fleet 中没有任何东西调用 `ctx.tmuxGateway.dial()`，而 [`@dsh-fleet/tmux`](../tmux/README.zh.md) 驱动的是本地 pane，因此没有请求文本经过本服务。

#### Token 影响

每次请求零直接 token。桥承载的帧属于发送它们的会话，而桥既不读取也不改写拼接的任一方向。

#### KV Cache 影响

与实时请求无关：提供、拨号或关闭这座桥都不改变任何请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下是本桥当前受到的约束及其背后的决定，不是待办清单。

- **明文且无认证**——没有 TLS、没有凭据、也没有对端校验，因此任何能到达该端口的东西都能驱动这台机器上的每个 tmux 会话。§13 在 fleet 的受控边界之内接受这一点，在边界之外禁止它；把这座桥暴露出去的部署破坏了 §13 记录的前提。
- **默认绑定是回环地址**——跨机器部署必须明确把 `host` 设为可路由的接口，而没有任何东西验证所选接口位于受控边界之内。
- **目前没有已发布的消费方拨号远端桥**——服务暴露了 `serve()` 与 `dial()`，而 `@dsh-fleet/tmux` 启动的是本地 tmux 客户端，因此今天还无法端到端访问另一台机器上的 pane。
- **分配到的端口只被发布，不被持久化**——在 `port: 0` 下，内核可能在每次 `serve()` 时分配不同端口，而 `address()` 是当前端口唯一存在的地方；需要让对端到达本桥的一方必须自己记录它。
- **每行只对应一个上游 socket**——桥只转发到一个 `socketPath`，因此要到达两台机器上的 tmux server，就需要每台机器各一行、各一个监听。
- **`connectTimeoutMs` 只约束 `dial()`**——提供服务的桥所执行的上游连接没有自己的定时器，因此该选项并不约束它，尽管其声明里写了上游连接。
- **`socketPath` 只校验是否为绝对路径**——缺失或相对的路径会在加载时被拒绝，而一个不是 tmux server socket 的路径要等到某次连接的上游失败、调用方看到连接被关闭时才会被发现。
- **没有任何东西约束已建立的连接**——`maxConnections` 只限制监听接受的连接数，`connections()` 只统计它们；没有空闲超时、没有逐连接身份，也没有速率限制，因此一条打开的连接可以任意长时间占用这座桥。
- **提供服务永远是显式的**——挂载本行不绑定任何东西，而 `enabled: false` 会让 `serve()` 抛出 `@dsh-fleet/tmux-gateway is disabled; set enabled: true to serve the bridge`，而不是悄悄绑定。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与尚未确定的方向。它明确不具备权威性——已发布的行为与限制以上文各节和包内代码为准。

- **远端 pane 这条路径尚未完成。** 把 `ctx.tmux` 接到桥地址上——远端放置、远端帧日志，或按机器划分的通道——是 §11 第 3 项尚未完成的部分；在它出现之前，本网关是一座经过测试、但还没有消费方的传输层。
- **带认证的变体会改变 `dial()`。** 在拼接之前加握手，或改用隧道，都是替换明文立场而不是在其上叠加；§13 把该立场记为已接受的取舍，因此这是部署决定，不是缺陷。
- **测试用回显 socket 代替 tmux。** 桥是针对一个原样回显每个字节的 unix socket 测试的，因此拼接、动态端口与销毁都无需 tmux server 即可验证；协议行为属于 tmux。

</details>

**运行时不变式：** 不发布伴生模块。本服务拥有一个监听与一组存活连接，二者都由 `serve()` 创建，并由 `close()` 或挂载它的 fiber 丢弃；进程内不存在该状态的第二份观测，因此伴生模块只会重复服务存在性。
