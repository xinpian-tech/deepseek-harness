# DeepSeek Harness 多机 Agent 集群需求基线(dsh 口径)

状态:需求基线 v2。上游 `infra-requirements.md`(Codex 口径)保留为历史基线,不被本文覆盖。

本文替代上游文档的全部**实现手段**章节与冲突章节;上游的**目标层**仍然有效,逐章对照见第 10 节。

## 1. 不变量

违反其中任何一条,后面的设计都不成立。

- **R-0 上游隔离。** 所有自定义只以新包 + profile patch 的形式存在,**不修改任何上游文件**。上游同步永远是无冲突 fast-forward。
- **R-1 逐层极简。** 每一层只向直接上层汇报三件事:`完成了什么`、`证据在哪`、`需要什么`。上层不需要下层的全文。
- **R-2 验收标准任务自带、机器可判、不可改写。** 只接受机器可判形态;不能被机器判定的项不进标准,交由顶层 agent 判断。标准随任务下传,只能细化,不能改写。
- **R-3 逐层判定。** `Ln 判 Ln+1`。L0 只见 L1,因此**树再深,L0 的信息量恒定**。
- **R-4 纠偏续接。** 整改必须唤醒原 agent 继续工作,不得重开新 agent。重开会丢上下文,纠偏退化为重做,回环不收敛。
- **R-5 归档两段式。** 每 turn 本地 commit(同步、不联网);push 异步重试直到成功;最终提交同步 push。
- **R-6 通信唯一通道。** agent 之间的全部交流只走两条:**tmux**(实时)与 **git**(durable)。不存在第三条通道,也不存在任何 harness 私有的 agent 间通信机制,没有例外。
- **R-7 只调用,不传消息。** agent 之间只允许**调用-返回**语义(一方发起、等待、拿回结构化返回值),**禁止消息传递**语义(异步投递、凭空注入对方上下文、无需对方发起)。这条线决定下面所有插件的去留,见第 12 节。
- **R-8 Nix 唯一依赖来源(最高优先级)。** 任何被维护的项目,依赖必须全部来自 flake,构建产物必须可丢弃并从 flake 重建。禁止在机器上安装任何东西,禁止依赖机器上"恰好存在"的工具,禁止依赖 workspace 之外的可写状态。详见第 2 节。

## 2. 核心要求:Nix 唯一依赖来源

### 2.1 规则

一句话:**任何依赖必须来自 flake;任何构建产物必须可丢弃并从 flake 重建。**

| 禁止 | 为什么是 slop |
|---|---|
| `npm install` / `pip install` / `apt install` / `cargo install` / `go install` | 在机器上留下不可审计的状态;100 台机器必然漂移 |
| 依赖机器上"恰好存在"的工具或库 | 换一台机器就失败,而且失败原因无法从任何记录推出 |
| 依赖 `$HOME` 或 workspace 之外的可写路径 | 状态不在 workspace 里,不可复现、不可交付 |
| 依赖不可丢弃的构建缓存 | 缓存与源码不一致时,产出无法解释 |
| `curl … \| sh` 之类的手动运行时安装 | 同第一行,且无法验证装了什么 |

必须成立:

- 依赖出现在 `flake.nix` / `flake.lock`;
- 执行发生在 `nix develop` / `nix build` / `nix run` 之内;
- 构建产物删除后可重建,且重建结果一致。

### 2.2 三层强制

按强度排序。**提示词是最弱的一层,不能单独依赖**——dsh 自己的仓库规范就写明:提示词过滤不构成强制,直接或替代调用者都能绕过。

**第一层:环境,物理强制。** 沙箱只暴露 `/nix/store`(只读)、workspace、tmp;系统包管理器不在 PATH 内;网络默认关闭,需要 fetch 时走 flake 的固定输入。落点是 `ctx.sandbox`,但 dsh 现有的三种模式(read-only / workspace-write / danger-full-access)只管**写权限**,不管**可见范围**——所以需要一个新的 sandbox profile 或 backend。

**第二层:执行环境,结构性强制。** 让每条 shell 命令都在 `nix develop -c <cmd>`(或 `nix shell`)里执行,而不是在宿主环境里执行。这样**即使命令里写了 `pip install`,它也只能装进一个临时环境**。这不是"禁止命令",而是"改变命令的执行环境"——比黑名单可靠得多,因为黑名单永远不完备。落点:自定义 `ctx.shell` provider,或 bash 工具的前置包装。

**第三层:提示,声明性。** 见 2.3。它让模型**知道**规则并主动配合,但它不是边界。

### 2.3 提示词落点

**dsh 侧**:新增一个 prompt **section** 插件(不是 context——这是常驻规则,不是动态状态)。用未占用的 order 值(600 与 800 之间,如 700)。注意:不能往上游的 `SECTION_ORDERS` 里加新名字(R-0),所以只能用数字,并在插件 README 里记录这个选择的理由。

**跨 harness 侧**:dsh 的 section 只覆盖 dsh agent。**Codex / Kimi / Claude 有自己的系统提示,注入不了。** 它们读的是 workspace 的 `AGENTS.md`(dsh 的 `dsh-agent-instructions` 默认也读 `AGENTS.md` / `CLAUDE.md`)。所以同一条规则**必须同时**出现在 workspace 的 `AGENTS.md` 里。

**单一事实来源**:section 文本与 `AGENTS.md` 的对应段落由**同一个插件**在 workspace 初始化时写出,避免两处漂移。

### 2.4 验收

R-2 要求验收标准机器可判,Nix 恰好是最容易机器判的:

```
{ kind: 'command', run: 'nix flake check',                   expect: { exitCode: 0 } }
{ kind: 'command', run: 'nix build .#default',               expect: { exitCode: 0 } }
{ kind: 'command', run: 'nix develop -c <project test cmd>', expect: { exitCode: 0 } }
```

于是"必须用 Nix"不只是提示,而是**任何任务都自带的验收项**:项目没有 flake,任务直接判不通过,不需要任何主观判断。

## 3. 拓扑

```
人类
 ↑  最终结果
验收 agent                              ← 终点,跨 harness,不参与执行
 ↑
L0  主 agent(dsh root session)          ← 编排(workflow 引擎)、审计、资源池
 ↑↓  tmux
L1  任务组 leader(Codex,pane 内常驻)
 ↑↓  tmux
L2  组员(dsh worker,pane 内常驻 --profile sdk,100 台机器)
 ↑↓  tmux
L3  异构 harness(kimi / glm / claude,pane 内常驻)
```

- **每一层的箭头都是 tmux。** 全部进程外 agent 都是 **tmux pane 内的 stdio 协议进程**,这是 R-6 的物理含义。
- **dsh 是控制面与运行时。** 编排状态、审计全部落在 dsh 的 session log 里;编排动作由 `workflow` 引擎执行,但**它驱动 agent 的通道是 tmux**。
- **Codex 是 leader**,通过 tmux provider 启动和调用,不是进程内 subagent。
- **异构 harness 封装在 worker 内部**,L0 与 L1 只认识一种 worker 接口。
- **git 是 durable 层**:任务、结果、产物、session 归档都在 git 里,跨机器可用。
- tmux 额外提供进程持久、attach 观察、崩溃后现场保留。

## 4. 层级与纠偏

### 4.1 生长规则

层级是一棵运行时生长的树,每一层形状相同:`Group(leader, members[])`,`members` 既可以是 worker,也可以是更大的 Group。递归深度由 dsh 原生的 `delegationDepth` / `subagentDepth` 记账,不需要新的深度机制。

判定规则统一为 `Ln 判 Ln+1`。L0 永远只见 L1——这是"允许动态加深"与"主 agent 信息量最小"能共存的原因,实现时不得以"主管要看全局"为由破坏它。

### 4.2 加深优先,升级兜底

卡住时的顺序:

1. **先加深**:把当前问题拆成子问题,加一层。
2. **加深有次数上限**,由上层给定。
3. **加深无效再升级**:L2 卡住 → L1 重新规划;L1 卡住 → L0。

**加深必须伴随验收标准的细化**:把上层的一条验收标准拆成几条更具体的、可执行的子标准。把同一条标准原样往下传,是"用加深逃避'我做不到'"的失败模式,必须拒绝。

### 4.3 收敛保证

无限量 token + 动态深度 + rework 回环三者叠加,天然不收敛。四个机制缺一不可:

1. **每层纠偏轮数上限**,由上层给定,并随任务下传。
2. **纠偏指令必须携带未通过项**。禁止"做得更好"这类不可执行指令。
3. **单调性检查**:每一轮必须在验收标准上有进展(未通过项减少)。无进展即停,不许原地磨。
4. **升级路径**存在且可达(见 3.2)。

### 4.4 验收 agent

L0 之上是一个**独立验收 agent**,它:

- 不参与任何执行,只按任务自带的验收标准判 L0 的产出;
- 用**与执行侧不同的 harness**(交叉验证,避免同类错误系统性漏过);
- 是 agent 层级的终点,结果**直接交给人**。

## 5. 任务组

一个任务组 = **一次 `workflow` run**(dsh 原生:fan-out、`parallel` barrier、`phase`、并发上限、后台 job 集成、`agent()` 的结构化 schema 返回)。**`workflow` 保留**——它是调用-返回语义(R-7),编排逻辑仍然在 dsh 里。变化的是它**驱动 agent 的通道**:`agent()` 必须解析到 tmux provider,而不是进程内或 stdio 管道。

### 5.1 编制

```
K 个红军候选   同一任务多候选(best-of-N)
M 个蓝军       临时编制,专职对抗,不产出实现
```

N 与评测轮数上限**由主 agent 按任务确定**,不由预算确定。

### 5.2 蓝军规则

- 蓝军的验收标准不是"实现正确",而是"找出可复现的缺陷",产出结构化缺陷清单 `{severity, location, repro, evidence}`。
- 蓝军**只看验收标准与产物,不看红军的实现过程**。看了就会趋同,趋同的蓝军没有价值。
- 蓝军与红军同组,通过组内 tmux 通道交流。

### 5.3 通信

R-6 只承认两条通道,二者职责不重叠:

| 通道 | 用途 | 机制 |
|---|---|---|
| **tmux** | 实时:派活、纠偏、进度、完成通知 | pane 内进程的 stdin/stdout,NDJSON 帧 |
| **git** | durable:任务、结果、产物、session 归档 | commit + push |

组内 N:N 的落地细节:

- **成员形态**:每个成员是 **tmux pane 内的常驻 stdio 协议进程**(`--profile sdk`)。`headless` 不行——它只在启动时读一次 stdin,之后不再是消息通道。
- **传输**:输出用 `tmux pipe-pane` 落 NDJSON;输入用 `tmux send-keys -l` 写 NDJSON 帧。pane 必须 `stty -echo -icanon`,否则 tty 回显会污染通道。
- **边界与确认**:NDJSON 换行定界;JSON-RPC 的 id + response 帧即 ACK。
- **跨机器**:tmux 无网络传输能力,跨机器经 tmux gateway(TCP ↔ tmux unix socket,动态端口),或逐条 `ssh <host> tmux send-keys`。
- **记录**:成员各自把自己的收发落进自己的 session log,满足 dsh 的「模型可见 ⟺ 已记录」。
- **没有兜底邮箱**。R-7 禁掉了消息传递,所以对方 pane 消失时**消息不补投**——调用方观察到失败,按纠偏回环处理。这是有意的:补投需要一套消息存储,那正是被移除的东西。

### 5.4 worker 会话模型

worker 常驻,**不退出**。原因是 `dsh --profile sdk` 的 `getOrCreateSession` 用进程内 Map + `ctx.agents.create()`,**新进程拿同一个 sessionId 会重新创建而不是恢复**。常驻因此不是优化,是"纠偏续接"能成立的前提。

`session/prompt` 调用 `agent.followup(message)`——排队、不阻塞、立即返回 `{messageId}`。所以同一个 worker 可以在忙时继续接收指令,忙完依次执行。

**由此得到一个必须注意的判定规则**:`session/prompt` 的 JSON-RPC response **不是完成信号**,它只表示"已入队"。tmux provider 判定一次调用完成,只能靠**通知流**:SDK server 会持续向 stdout 推送 session 事件与 agent 状态变化,provider 必须按 request 关联到对应会话,等到该会话的 `turn/end` 或 agent 转为 idle 才算完成。把 response 当成完成信号会得到"任务还没跑完就返回"的静默错误。

tmux provider 需要区分两种会话语义:

```
agent(prompt, { context: 'fresh' | 'resident' })
```

- `fresh` —— 为本次调用起新 pane/进程,跑完回收(普通 workflow 调用)。
- `resident` —— 复用既有 pane(纠偏续接,同一 worker 同一会话继续)。

### 5.5 落选候选

落选候选的 commit **保留**(它们是评测证据与复现素材),与选中 commit 在 branch 命名上区分。

## 6. 验收与上报

### 6.1 验收标准

`TaskSpec.acceptance` 是一等字段,任务创建时即必须是可执行形态:

```
{ kind: 'command', run: 'pnpm test', expect: { exitCode: 0 } }
{ kind: 'schema',  target: 'artifacts/report.json', schema: { … } }
{ kind: 'diff',    scope: 'src/**', maxLines: 500 }
```

**可执行带来的三个后果**,每一个都是设计依赖:

1. 每一层都可以**重跑验收**,不需要信任下一层。因为标准任务自带且不可改写,重跑是确定性的。
2. "确定性上报"闭环:上报的是**未通过项列表**,不是自然语言评价。
3. 纠偏有靶子:指令 = 未通过项 + 方向。

验收标准随任务下传,作为 **durable 数据**(不是提示词),落进子 session 的 bootstrap 上下文,并带任务树路径。提示词会被模型重新解读,传四层就失真。

### 6.2 上报

每层向上层发两种上报:

**稳态信号**(决定"能否继续派活"):

```
{ task_id, status: done | blocked | failed, cost }
```

**终评包**(决定"接受还是纠偏"):

```
{ candidates: [ { id, status, commit, diff_stat,
                  artifacts[], self_report, peer_signals[] } ] }
```

主 agent 的产出是**指令**,不是代笔:

```
{ decision: accept | rework, target, instruction }
```

于是 L0 的上下文是 `O(N × 摘要)`,不是 `O(N × 全文)`。**"主 agent 信息量最小"是判断力措施,不是省 token 措施**——上下文越大,主管判断越差。

### 6.3 纠偏回环

```
执行 → 提交 → 评估 → 纠偏 → 整改 → 再提交 → …
```

状态机:`submitted → evaluating → (accepted | rework) → reworking → submitted`。

整改唤醒原 agent(dsh 的 continuable child 冷恢复),原会话历史仍在。

### 6.4 绩效簿

每个 worker 的绩效记录是 durable 数据,随 Team State Repo 留存,参与后续派活(N 的分配、候选的选择)。

**评分权归主 agent。** 权威单一,避免组内互评的趋同偏差。组内互评信号与蓝军缺陷清单作为**评分输入**,不作为评分权威。

## 7. 持久化与 git

### 7.1 两段式归档

| 阶段 | 行为 |
|---|---|
| 每个 turn | **本地 commit**(不联网,快) |
| 后台 | **异步 push + 退避重试,直到成功**;推进 durable 水位 |
| 最终提交 | **同步 push,阻塞直到成功**——上层必须能取到该 commit |

把网络往返放进 turn 循环,100 台机器会把集群拖死,因此必须拆开。同时只有最终提交会因 remote 故障阻塞,不会全集群冻结。

### 7.2 refs 分片

git 的同一个 ref 不能并发写。所有 session 归档按机器分片:

```
refs/dsh/machines/<machine-id>/sessions/…
```

每台机器独占 ref 命名空间,**push 零竞争**。root session 的分组视图由内容重建(session header 带 `parentSession`),不靠 ref 结构。

### 7.3 实现形态

写**旁路归档器**,不写 `SessionPersistence` 后端。原因:JSONL 是 dsh 唯一的持久化 provider,位于模型请求前的热路径(有 fail-closed 检查点),替换风险极高。

## 8. 环境、版本与凭据

### 8.1 harness 与版本

- 全部 harness 由 **`github.com/numtide/llm-agents.nix`** 提供(约 70 个 agent,每日更新,有 binary cache),它已经打包了 dsh 本身,我们的 fork 通过 **override `src`** 接入。
- **一个 `flake.lock` 锁定全部 harness 版本**,它就是 ConfigGeneration 要的版本指纹,写入每次执行的记录。
- **生产钉 release tag,master 轨道单独跟踪**。dsh 是 developer preview,生产集群直接跟 master 等于把上游每次重构直接引到 100 台机器上。
- fork 之后**砍掉与私有插件无关的门禁**(文档预算、i18n 配对、覆盖率预算),保留 typecheck、相关单测、快照。

### 8.2 凭据

明文 token 进入 Git、Nix derivation、closure 与 `/nix/store`,这是**有意的设计**(见第 13 节的前提),不是疏漏。

实现路径**不修改任何上游文件**:

- 凭据由 Nix 生成的环境注入进程(environment / systemd unit / tmux 环境),**不经过 dsh 的文件型凭据存储**。
- dsh 侧只走 `CredentialRef`(POSIX 环境变量名)这一层。它按"进程环境 > 托管存储 > 项目 `.env` > `$DSH_HOME/.env`"分层解析,环境层是启动快照,本身没有文件权限检查。
- 于是 `credentials-local` 的 owner-only 检查(文件他人可读即拒绝加载)**保持原样,只是在这套部署里不被使用**——不需要在 dsh 里留一个绕过权限检查的补丁。这符合 R-0。

**一个必须处理的副作用**:dsh 在拉起进程外 subagent 时会**剥离凭据形态的环境变量**再叠加显式 `env`(`subagent-codex` / `subagent-claude-code` / `subagent-dsh-sdk` 都如此),MCP stdio 桥同样剥离凭据形态变量与全部 `DSH_*`。因此环境注入的凭据**不会自动传给子 harness**,必须通过各 provider 的 `env` 配置显式下传。这一条要在 worker 启动模板里统一处理,否则会出现"leader 能调模型、worker 的子 harness 报 401"这类只在深层才暴露的故障。

## 9. 规模约束(100 台机器)

- **多账户的真实理由是打散配额**,不是"多账号"。token 无限 ≠ API 无限,限流是硬约束。
- **墙钟时间**不因并行而减少:轮数多 = 单任务时延长。100 台并行解决吞吐,不解决时延。
- **N 越大冲突率越高**,这是 N 上限的物理约束,不只是成本约束。
- **主 agent 是单点**,且是所有结果汇聚处,最先被限流。它必须可从 Team State Repo + session log 重建。

## 10. 与上游文档的对照

| 上游章节 | 处置 |
|---|---|
| §1 目标 | **保留**,补入本文的不变量 |
| §1.2 最小改动原则 | **改写**为 R-0(不改上游文件,而不是"少改 Codex") |
| §2 仓库分离 / refs | **改写**:refs 按机器分片;session 由旁路归档器写入 |
| §3 Nix 生产环境 | **保留并升级为 R-8**:llm-agents.nix + flake.lock 指纹,再加三层强制与可执行验收(第 2 节) |
| §3.2 明文凭据进 Git/Nix store | **保留**,实现路径见 §8.2 |
| §4 TaskSpec | **保留并扩写**:acceptance 成为一等字段 |
| §5 机器模型 | **保留**,MachineId = hostid;MachineContext 扩 dsh 的 tmux-context |
| §6 本地远端统一 | **保留**,但 dsh 的 `ctx.ssh` 目前是单机,需新增机器注册表 |
| §7 Subagent tmux 管理 | **保留**;tmux 是唯一实时通道,不再是"可选载体" |
| §8 tmux Gateway / 动态端口 | **保留**(跨机器 tmux 必需) |
| §9 Agent 间通信 | **改写**:唯一通道 tmux + git;消息传递一律禁止(R-7) |
| §10 Role / Directory / 路由 | **改写**:`agent-team` 停用(roster/mailbox 是消息型);Directory 落在 git + tmux placement 记录 |
| §11 消息身份 | **改写**:来源/目的地落在 git 提交与 tmux 帧上;不走 `MessageSourceMap` 的 agent-message 路径 |
| §12 worktree 隔离 | **保留**,N 候选 = N worktree/branch;落选保留 |
| §13/§14 checkpoint / finalization | **保留**,落点改为 `agent/turn-stopping` + 两段式 push |
| §15 多 Provider | **保留**,dsh 原生 |
| §16 多账户 | **改写**:按配额粒度建模 |
| §17 配置管理 | **改写**:bundle → profile → home → patch 四级 + 任务级 acceptance |
| §18 Session 留存 | **保留**,落旁路归档器,粒度每 turn |
| §19 Skills / Memory | Skills 保留(dsh 原生 + 自定义 root);Memory 需新写或接 MCP |
| §20 核心数据绑定 | **保留**,按 dsh 的 session header / descriptor 落 |
| §21 生命周期 | **改写**,按本文第 4/5/6 节的层级与回环 |
| §22 组件清单 | **替换**为第 11 节 |

## 11. dsh 改造清单

按依赖顺序。

| # | 改动 | 形态 |
|---|---|---|
| 1 | **tmux provider**(实现 `SubagentProvider`):取/建 pane → 启动或复用 `--profile sdk` → 投 NDJSON 帧 → 从 `pipe-pane` 读结果 → 返回 `SubagentResult`;支持 `context: fresh \| resident` | 新插件(**全系统的咽喉**) |
| 2 | tmux 托管 + placement 记录(`{machine, tmux_session, window, pane}` 写成 durable session 事件) | 新插件 |
| 3 | tmux gateway(跨机器,动态端口) | 新插件 |
| 4 | worker 启动模板(常驻 sdk 进程 + `stty -echo -icanon` + 凭据 env 显式下传) | 新插件 |
| 5 | `session/prompt` 增加 `source` 字段(区分人发的与 leader 发的) | 改 dsh |
| 6 | git checkpoint hook(`agent/turn-stopping`)+ 异步 push 重试队列 | 新插件 |
| 7 | session 归档器(每 turn,per-machine refs) | 新插件 |
| 8 | worktree 管理(N 候选 = N worktree/branch) | 新插件 |
| 9 | 绩效簿(durable,进 Team State Repo) | 新插件 |
| 10 | 机器注册表 + MachineContext(hostid + alias + nix_system) | 新插件 |
| 11 | TaskSpec + acceptance(durable,随调用下传) | 新插件 |
| 12 | ConfigGeneration 记录(flake URI/rev/lock/drv/store path) | 新插件 |
| 13 | 中断通道定义(tmux 发信号 / kill 进程) | 新插件 |
| 14 | **Nix-only sandbox profile**(只暴露 `/nix/store` 只读 + workspace + tmp;包管理器不在 PATH;网络默认关) | 新插件(第 2.2 节第一层) |
| 15 | **`nix develop -c` shell provider**(每条命令跑在 flake 环境里,而不是宿主) | 新插件(第 2.2 节第二层) |
| 16 | **Nix mandate prompt section**(order 700)+ 同步写 workspace `AGENTS.md` | 新插件(第 2.3 节) |
| 17 | acceptance 模板内置 `nix flake check` / `nix build`(第 2.4 节) | 并入第 11 项 |

## 12. 移除清单(关插件行,不改上游代码)

R-7 的分界线落到 `packages/bundle/base/cordis.patch.yml` 的具体行上。全部以 profile patch `disabled` 实现,**不修改任何上游文件**(R-0)。

**移除(消息传递)**:

| 行 | id | 理由 |
|---|---|---|
| 363 | `tool-subagent-control` | `send_message` / `interrupt_agent`,纯消息传递 |
| 367 | `tool-subagent-list-agents` | 只列 continuable 子 agent,机制移除后为空 |
| 351 | `subagent-spawn-in-process` | 同进程子 agent,**不在 tmux 里** |
| 356 | `subagent-fork-in-process` | 同上 |
| — | `agent-team` 全套 | roster / task board / **mailbox** 都是 dsh 内消息 |
| — | settlement 自动通知 | `continuation-activation.ts` 的 `notifySettlement` |
| — | `agent-message` / `subagent-settled` source kind | 消息型上下文注入 |

**保留,但只挂 tmux provider**:`subagent` seam(行 348)、`tool-subagent`(369 / 382)、`workflow-ptc`(392)、`tool-workflow`(397)、`tool-ralph`(446)。现成的 `spawn` / `fork` / `acp` / `codex` / `claude-code` / `dsh-sdk` 六个 provider **一个都不挂**——前两个在进程内,后四个走 stdio 管道,都不是 tmux。

**停用的能力**:continuable subagent(其续接依赖 inbox 注入,属消息传递)。

**必须保留的东西(容易被误删)**:`agent.followup()` / `steer()` / inbox 这套**投递原语本身保留**——Web UI 的用户发消息与 `session/prompt` 都走它,删了产品就没了。移除的只是 **agent 之间**经由它投递的路径。

**一个由此产生的缺口**:SDK server 目前把每条 prompt 都标成 `source: { kind: 'user' }`,移除 agent-message source kind 之后,**leader 的指令与人发的消息在 session log 里无法区分**。审计要求区分,这就是改造清单第 5 项。

## 13. 非目标与已接受的取舍

**安全不是本设计的目标。** 前提是上游 §5.4 的"所有机器都是沙盒机器":整个集群处于受控边界内。在此前提下有意接受:

- 明文凭据进入 Git、Nix derivation、closure 与 `/nix/store`(§8.2)。
- tmux gateway 与组内 N:N 通道使用明文 TCP。
- 进程以 root 运行。
- 凭据形态的环境变量在需要时会显式下传给子 harness(§8.2 的副作用一节)。

**存储不是本设计的约束。** 完整留存与审计优先于体积:

- 组内讨论在参与成员的 session log 中各存一份,存储翻倍。
- 每 turn 一次归档 commit,git 历史持续增长。
- 落选候选的 branch 与 commit 全部保留。
- Team State Repository 体积无上限。

这些取舍全部依赖开头那个前提。**前提一旦不成立**——例如 Team State Repo 需要被集群外的机器 clone,或某台"沙盒机器"不再受控——**第 8.2 节与本节必须重写,而不是就地放宽**。
