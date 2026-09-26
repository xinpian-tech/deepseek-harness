# infra/ —— Nix 是 fleet 唯一的依赖来源

[English](README.md) | 中文

本目录记录 fleet 的构建与部署接线，而不是包的对外接口。

`infra/requirements` 从这里得到满足：集群构建与运行所需的一切都用 Nix 表达，没有任何东西依赖某台机器上碰巧存在的工具。它实现的需求是 [`infra-requirements.dsh.md`](../infra-requirements.dsh.md)，主要是其中的不变量 **R-8**（§2）与它的改造清单（§11）。

## Nix 强制什么

| 层 | 机制 | 位置 |
|---|---|---|
| 环境 | dev shell 携带 node、pnpm、tmux、git、jq、nix 与各 harness 二进制；宿主上不安装任何东西 | [`../flake.nix`](../flake.nix) 的 `devShells.default` |
| 执行 | 命令经 `nix develop -c …` 运行，而 `@dsh-fleet/nix-shell` 插件让每条 agent shell 命令都在 flake 内执行 | [`../packages/infra/nix-shell`](../packages/infra/nix-shell/README.zh.md) |
| 可见性 | `@dsh-fleet/nix-sandbox` 把命令限制在 `/nix/store`（只读）、工作区与一个私有临时目录内，`PATH` 上没有包管理器，并且除非某个 flake 输入需要，否则没有网络 | [`../packages/infra/nix-sandbox`](../packages/infra/nix-sandbox/README.zh.md) |
| 声明 | order 700 的一个提示词段落，与工作区 `AGENTS.md` 一起写入，使 fleet 中每个 harness 读到同一条规则 | [`../packages/infra/nix-mandate`](../packages/infra/nix-mandate/README.zh.md) |

## 命令

```sh
nix develop                      # the only supported build environment
nix develop -c infra/scripts/check.sh   # typecheck + fleet tests + composition gate
nix build .#default              # the deployable fleet runtime (`result/`)
nix flake check                  # runtime, vendoring record, change inventory
```

`nix build .#default` 产出一个 store 路径，其中包含 fleet 的入口点（`dsh-fleet-machine-id`、`dsh-fleet-worker`、`dsh-fleet-push`）、profile patch 层、vendored 的 harness flake、改造清单与 ConfigGeneration 指纹。删除 `result/` 后重新构建即可复现它。

harness 二进制**不会**作为本 flake 的包重新导出，因为 `nix flake check` 会构建 flake 暴露的一切，而本仓库并不拥有那些产物。请从 vendored flake 取用它们：

```sh
nix build ./infra/nix/llm-agents.nix#codex
nix build ./infra/nix/llm-agents.nix#claude-code
```

## 布局

| 路径 | 职责 |
|---|---|
| [`../flake.nix`](../flake.nix) | 输入、包、dev shell 与各项检查 |
| [`nix/fleet.nix`](nix/fleet.nix) | 组装运行时、各 shell、ConfigGeneration 指纹与清单检查 |
| [`nix/llm-agents.nix/`](nix/llm-agents.nix) | vendored 的上游 flake：fleet 放进 pane 的每一个 harness |
| [`nix/vendor.json`](nix/vendor.json) | vendored 副本锁定到的 revision、narHash 与 nixpkgs revision |
| [`fleet.manifest.json`](fleet.manifest.json) | §11 的每一项改造与 §12 的每一项移除，对应到实现它的包或 patch 行 |
| [`scripts/`](scripts) | `machine-id.sh`、`worker.sh`、`push-queue.sh`、`check.sh`、`vendor-llm-agents.sh` |
| [`vitest.config.ts`](vitest.config.ts) | fleet 各包的测试入口 |

## vendoring numtide/llm-agents.nix

fleet 从不在运行时获取 harness：上游 flake 被复制进 [`nix/llm-agents.nix/`](nix/llm-agents.nix)，并由本仓库自己的 `flake.lock` 锁定。`nix/llm-agents.nix/flake.lock` 与 `nix/vendor.json` 记录同一个 revision，而 [`nix/fleet.nix`](nix/fleet.nix) 在两者不一致时拒绝求值——一个记录下来的指纹与它实际运行的 harness 不符的 fleet，无法在事后解释结果。

用下面的命令重新 vendor 另一个 revision：

```sh
infra/scripts/vendor-llm-agents.sh <rev-or-tag>
```

生产环境锁定一个确切的 revision，而不是上游的默认分支：dsh 是开发者预览版，跟随它的主分支会把上游的每一次重构一次性引入每一台机器（§8.1）。

## 本次改动维护的生成产物

新增一个带 `Config` 的包，或一个 durable 的 session 事件，会让仓库中少数**生成**产物变陈旧。它们是派生数据，而不是手写代码，fleet 用仓库自己的生成器重新生成它们：

```sh
nix develop -c pnpm --config.verify-deps-before-run=false exec tsx scripts/gen-persistence-catalog.ts
nix develop -c pnpm --config.verify-deps-before-run=false exec tsx scripts/gen-config-catalog.ts
nix develop -c pnpm install --lockfile-only
```

持久化目录不是可选项。`packages/core/session/src/known-event-types.ts` 是冷读取方接受的词汇，而包含该词汇不认识的事件类型的 session 日志会被拒绝，而不是被静默重建——因此 fleet 的 durable 事件（`tmux/placement`、`tmux/interrupt`、`git/checkpoint`、`worktree/*`、`machine/context`、`config/generation`、`prompt/source`、`task/*`）必须出现在那里。

## 只增不改的边界（R-0）

fleet 新增的一切都存在于新文件里：`packages/infra/*`、`packages/bundle/fleet/*`、`infra/*` 与 `flake.nix`。没有任何上游 dsh 源文件被打补丁；运行时差异表达为一个 profile bundle 及其 patch 层，因此上游同步始终是一次 fast-forward。

有四个仓库文件是被维护而不是新增的，它们都不改变上游行为：

| 文件 | 为什么必须改动 | 方式 |
|---|---|---|
| `pnpm-lock.yaml` | 一个 workspace 成员的 importer 必须存在，`--frozen-lockfile` 才能通过 | `pnpm install --lockfile-only` |
| `packages/core/session/src/known-event-types.ts`, `docs/persistence-catalog.md` | 冷读取方会拒绝词汇不认识其类型的 durable 事件，因此 fleet 自己的事件必须登记进去 | `tsx scripts/gen-persistence-catalog.ts` |
| `docs/config-catalog.md` | 该目录枚举每个包的 `Config`；十五个新包各带一个 | `tsx scripts/gen-config-catalog.ts` |
| `tsconfig.base.json`（手写的别名区块） | 为了让一次 `tsx` 启动与 `scripts/verify-cordis-config.ts` 能工作，bundle patch 行必须解析到 workspace 的**源码**；生成的区块只覆盖 `@deepseek-ai/dsh-*` 命名空间，因此 fleet 自己的命名空间被映射在它旁边 | 十五条 `"@dsh-fleet/<name>": ["./packages/infra/<name>/src"]` 条目 |
| `scripts/gen-cordis-catalog.ts`、`scripts/verify-concrete-terms.ts`、`scripts/translation-pairing.manifest.json` | 内置的 harness flake 是一份 pin 住的上游拷贝，因此它的文字与 `vendor/` 一样不在术语门禁与双语文档门禁的范围内，而 fleet 自己的服务则要指明各自的文档归属 | 一处命名空间说明、一个排除前缀、每个 fleet 服务一条豁免条目 |

它们是每位贡献者在新增一个 workspace 包、一个事件类型、一份 `Config` schema 或一个插件命名空间时都要做的机械登记。fleet 与上游 dsh 之间的运行时差异仍然只表达为新包与 profile patch 层。

## ConfigGeneration

[`nix/fleet.nix`](nix/fleet.nix) 把 `config-generation.json` 输出进运行时，而 `@dsh-fleet/config-generation` 在运行时产出同一条记录，因此任何一次执行都能由它运行时所依据的 flake URI、`flake.lock` 哈希、llm-agents revision 与 narHash 解释（§11 第 12 项）。
