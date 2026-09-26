---
description: "infra 包分组：fleet 组合——每个 agent 都是一个 tmux pane，持久状态落在 git，依赖只来自 Nix flake。"
kind: "package-group"
---

# infra/ —— fleet 组合

[English](README.md) | 中文

## 概述

`infra` 分组承载 fleet 组合：人类之上的每个 agent 都是一个 tmux pane，因此 tmux 是 agent 之间唯一的实时通道，git 是唯一的持久通道，Nix flake 是唯一的依赖来源。各包按职责划分——基于 tmux 的委派与 placement、git 中的逐 turn 归档与候选隔离、机器与任务身份，以及 Nix 强制的三层。用本页找到某个 fleet 需求项由哪个包负责；每个包的 README 拥有它自己的配置、服务契约与已知限制。

## 目录

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

下表中每一行给出一个包、它的贡献，以及它实现的需求项。[`@dsh-fleet/bundle`](../bundle/fleet/README.zh.md) 是把这些包挂载进 fleet profile 的那一层；[`fleet.manifest.json`](../../infra/fleet.manifest.json) 是可机读的清单，由 `infra/nix/fleet.nix` 约束到本目录树。

| Package | Role | Requirement |
|---|---|---|
| [`tmux`](tmux/README.zh.md) | Placement、NDJSON 帧通道与中断路径：一个成员就是一台机器上的一个 pane | §11 第 2、13 项 |
| [`subagent-tmux`](subagent-tmux/README.zh.md) | 每次委派都解析到的 provider：子 agent 是 pane 里的 `dsh --profile sdk` 进程，可以新起，也可以在原地续接 | §11 第 1 项 |
| [`tmux-gateway`](tmux-gateway/README.zh.md) | 用内核分配的端口经 TCP 触达另一台机器的 tmux unix socket | §11 第 3 项 |
| [`worker-template`](worker-template/README.zh.md) | worker pane 的启动契约：常驻 sdk 进程、关闭 tty 回显、显式下传凭据变量 | §11 第 4 项 |
| [`git-checkpoint`](git-checkpoint/README.zh.md) | 每个停止的 turn 一次本地 commit、一个异步 push 队列，以及一次阻塞式最终 push | §11 第 6 项 |
| [`session-archive`](session-archive/README.zh.md) | 每个 turn 复制一份 session 日志到按机器分片的 ref 命名空间，家族关系由 session header 重建 | §11 第 7 项 |
| [`worktree`](worktree/README.zh.md) | 每个候选一个 worktree 与分支，落选候选保留为证据 | §11 第 8 项 |
| [`ledger`](ledger/README.zh.md) | 每个成员的持久结果条目，以及由这些条目派生的聚合 | §11 第 9 项 |
| [`machine-registry`](machine-registry/README.zh.md) | 一个机器身份——hostid、alias 与 nix system——记录在每次会话上 | §11 第 10 项 |
| [`config-generation`](config-generation/README.zh.md) | 一次执行所运行其上的 flake 指纹 | §11 第 12 项 |
| [`task-spec`](task-spec/README.zh.md) | 作为机器可判任务数据的验收标准，Nix 检查内置于每个生成的标准集 | §11 第 11、17 项 |
| [`prompt-source`](prompt-source/README.zh.md) | 在 session 日志里区分 leader 下达的 prompt 与人发的消息 | §11 第 5 项 |
| [`nix-sandbox`](nix-sandbox/README.zh.md) | 只暴露 store、workspace 与私有临时根目录的沙箱 profile，别无其他 | §11 第 14 项 |
| [`nix-shell`](nix-shell/README.zh.md) | 让每条命令都在 flake 内执行的 `ctx.shell` provider | §11 第 15 项 |
| [`nix-mandate`](nix-mandate/README.zh.md) | 同时写进 system prompt 与每个工作区 `AGENTS.md` 的依赖规则，面向所有 harness | §11 第 16 项 |

四条不变量决定本分组里能存在什么。R-6 与 R-7 在 agent 之间只留下两条通道——实时走 tmux，持久记录走 git——并且只允许调用-返回语义，因此这里没有任何包会把消息投递进另一个 agent 的上下文：continuable 子 agent 与 `send_message` 都已移除，也没有兜底邮箱接替它们。R-2 让任务的验收标准成为机器可判的数据，下传时只能细化，由 `task-spec` 承载。R-5 把归档拆成每 turn 一次本地 commit 与一个重试到成功的异步 push，由 `git-checkpoint` 与 `session-archive` 实现。R-8 让 flake 成为唯一依赖来源，由 `nix-sandbox`、`nix-shell` 与 `nix-mandate` 按强度递增地强制；提示词段落只陈述规则，不是强制边界。

-----

<a id="related-documentation"></a>
## Related documentation

- [Fleet composition](../../docs/subsystems/fleet.zh.md) —— 拥有两条通道、每个包强制的不变量与移除集的子系统页。
- [Fleet profile bundle](../bundle/fleet/README.zh.md) —— 在 profile 中挂载这些包的两份 patch 文档。
- [Fleet requirements](../../infra-requirements.dsh.md) —— §11 改造清单、§12 移除清单与 §13 已接受的取舍。
- [Package conventions](../AGENTS.md) —— 插件导出形态、配置规则与 README 契约。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>供维护者使用的工作上下文——点击展开</summary>

无。

</details>
