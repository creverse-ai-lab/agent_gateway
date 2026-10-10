# ACP Gateway

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | **简体中文**

[![npm version](https://img.shields.io/npm/v/acp-gateway-daemon.svg)](https://www.npmjs.com/package/acp-gateway-daemon) [![CI](https://github.com/creverse-ai-lab/agent_gateway/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/creverse-ai-lab/agent_gateway/actions/workflows/ci.yml?query=branch%3Amain) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**让你正在使用的编码 agent 按需把工作委派给 Claude Code、Codex 和 Grok —— 基于 MCP + ACP，会话持久保持，权限请求可以在对话中交互式审批，无需预先定义任何工作流。**

ACP Gateway 是一个在本地运行的 daemon，也是一个 MCP（Model Context Protocol）服务器：你正在对话的 Claude Code、Codex 或 Grok 可以通过它把工作委派给其余的 agent，也可以委派给本机已安装、并列在 ACP（Agent Client Protocol）官方 registry 中的其他 agent。

你是否同时在用多个 AI agent？

向 Claude 提问，再让 Codex 改代码，最后交给 Grok 做 review —— 你是不是一直在终端和对话之间来回切换？

你有没有想过：“要是不用我一个个指挥这些 agent，而是让一个 agent 自己去调用其他 agent 就好了……”？

这个项目就是为这样的你准备的。

## 概述

ACP Gateway 是一个中间件：让你直接对话的 AI —— 即 **编排器（orchestrator）** —— 能够发现本地安装的多个 AI Worker，通过 ACP 运行它们，并管理从长时间任务、权限请求到最终结果回收的全过程。代码和工具说明中使用的 `Main` 指的就是编排器这一角色。

- 内置支持 Claude Code、Codex 和 Grok 作为 Worker；本地安装的其他支持 ACP 的 AI，会与 ACP 官方 registry 比对后被发现。
- daemon 会持续维持 ACP 会话和 provider 进程。
- 即使 MCP 重启，也能恢复 Worker 会话。
- 模型、权限、提问、取消和结果收集均由编排器控制。
- Gateway 会从 Worker 的环境中移除自己的 token、socket 和 Main 标识；但不经过 Gateway 直接读取文件的 Worker 仍可能找到该 token，详见[权限策略](#权限策略)。
- 以本地单用户、单机使用为前提。

## 使用场景

- **一个对话，多个 agent** — 在与 Claude Code 的对话中，让 Codex 实现改动、让 Grok 做 review，无需离开对话，也不用来回切换终端。
- **在同一个会话中继续跟进** — 直接向完成工作的 Worker 发送反馈，不必从头交代。闲置后被 unload 的会话，只要 provider 支持 resume 或 load，下次发送 prompt 时就会自动重新连接。
- **由主 agent 处理权限请求** — 在 `ask` 策略下，Worker 的权限请求和提问会发给你正在对话的 agent，由它批准、拒绝或回答，必要时先来问你。
- **重新连接后照样取回结果** — 宿主重新连接或 Gateway 重启之后，`agent_acp_inbox {action: "attention"}` 仍会列出等你处理的事项，以及你还没取回的已完成结果。
- **不碰原始代码的 review** — 用 `workspace: "snapshot"` 打开 reviewer 会话，它会在仓库的私有副本中工作；再用 `workspace_diff` 以 patch 形式取回改动，只应用你需要的部分。
- **弄清会话为何停下** — 每个会话都会记录它处于当前状态的原因；`agent_acp_session {action: "check"}` 不启动任何进程，就能告诉你会话能否恢复。

## 快速开始

### 环境要求

需要 Node.js 22 或更高版本，以及 macOS 或 Linux。

### 安装

先用 npm 安装 Gateway，再用 bootstrap 把它接入本机的各个 agent：

```bash
npm install -g acp-gateway-daemon
acp-gateway-bootstrap --install-all --refresh-registry --dry-run
acp-gateway-bootstrap --install-all --refresh-registry
```

Claude Worker 使用你已经安装的 Claude CLI：`CLAUDE_CODE_EXECUTABLE` 不为空时用它指定的路径，否则用 daemon 的 PATH 中绝对路径目录里找到的第一个 `claude`（跳过 Gateway 自身依赖中的副本以及 Claude Agent SDK 附带的二进制文件），再没有则用 `~/.local/bin/claude`；都找不到时，Claude 会被报告为未安装。

最后两条命令中，第一条是只确认安装计划的 dry-run，第二条才是真正的安装。`--install-all` 可能会全局安装或更新 ACP 官方 registry 所指定的 `npx`、`uvx` 包，因此请先在 dry-run 的输出中确认目标和版本。Registry manifest 由 ACP 维护，但实际的包和二进制文件是从各提供方的分发渠道下载的。安装会对你的机器做哪些改动，见[安装会对你的机器做哪些改动](#安装会对你的机器做哪些改动)。

默认情况下，`--install-all` 会询问你要把 Codex、Claude、Grok 中的哪一个作为与用户对话的 **front door**（前台入口）。只有你选择的那一个会注册面向编排器的 Control MCP，而所有被发现的 agent 都会安装只读的 Guide MCP 和 skill。非交互式安装默认选择 Codex，也可以像下面这样显式指定。

```bash
acp-gateway-bootstrap --install-all --front-door codex
acp-gateway-bootstrap --install-all --front-door claude
acp-gateway-bootstrap --install-all --front-door grok
```

#### 从源码安装

如果想直接从 Git checkout 运行（比如需要修改代码），就克隆仓库并链接：

```bash
git clone https://github.com/creverse-ai-lab/agent_gateway.git
cd agent_gateway
npm ci
npm link
acp-gateway-bootstrap --install-all --refresh-registry --dry-run
acp-gateway-bootstrap --install-all --refresh-registry
```

执行 `npm link` 后，同样的命令会出现在 PATH 中，并直接从 checkout 运行。最后两条命令以及 front door 的选择与上面完全相同。

### 第一次委派

安装程序会同时在被发现的 AI 上安装 `agent-delegator` skill。这个 skill 会从你的请求中判断 Worker、模型和权限范围，并引导完成从创建 Gateway 会话、传递任务、查看进度、处理提问和权限请求，到回收结果的全过程。安装之后，你不需要记住 MCP 工具的名字，直接用自然语言向编排器提出任务即可。

例如，你可以对正在对话的编排器 AI 这样说：

```text
让 Claude Sonnet 以只读方式审查这个仓库的认证代码，并整理出结果。

让 Grok 4.5 对当前设计做一次 red-team 安全审查，permission 请求请先向我确认。
```

内部按以下顺序运行：

1. 用 `agent_acp_setup` 确认 provider
2. 用 `agent_acp_session_open` 创建 Worker 会话
3. 如有需要，用 `agent_acp_config` 查询、设置 Worker 支持的模型、模式、推理级别等参数
4. 用 `agent_acp_run` 传递任务
5. 用 `agent_acp_wait` 等到 Worker 完成或需要回应，而不是用 `agent_acp_poll` 轮询
6. 如有需要，用 `agent_acp_permission` 或 `agent_acp_answer` 作出响应
7. 完成后可以复用会话，或用 `agent_acp_session` 结束

默认提供的 `agent-delegator` 是通用场景的起点。如果你有常用的 Worker、默认模型、权限策略、review 顺序或结果格式，可以按自己的工作方式修改已安装的 skill。`acp-gateway-bootstrap --update` 和普通的 `--update-skill` 不会覆盖你修改过的副本。只有想恢复成已安装的 Gateway 自带的默认版本时，才需要显式执行 `--update-skill --force`。

### 权限策略

打开会话时，从以下策略中选择一个。

| 策略 | 用途 |
|---|---|
| `read_only` | 分析、审查等只读任务 |
| `ask` | 修改文件或执行命令之前，需要编排器批准 |
| `auto_approve` | 在用户允许的会话边界内自动批准 |

Control token、编排器标识符（Main ID）和 Gateway socket 路径都会从 ACP Worker 的环境中移除，同时也会阻止向 Worker 会话重新注入 Control MCP，无论是凭名称、安装路径还是环境变量中的身份信息。Worker 自己的 CLI 也无法像 Codex Worker 读取 `~/.codex/config.toml` 那样，从你的 agent 配置中启动它：Control MCP 拒绝在 Worker 的进程树内运行，daemon 也拒绝向运行在其下的任何调用方提供 Control（`WORKER_CONTROL_DENIED`）。在 macOS 和 Linux 上，如果完全无法读取进程树（没有 `/proc`，且 `ps` 不存在或被阻止，Control MCP 连自身进程都读取不到），由于无法区分 Worker 和 Main，两者都会拒绝。Windows 上既没有 `/proc` 也没有 `ps`，因此不会因这一原因拒绝，只能凭 Gateway 为 Worker 设置的 `ACP_GATEWAY_WORKER` 变量，或请求 Control 的 agent CLI 本身是否为 daemon 启动的进程来识别 Worker。daemon 在启动时还会从自身环境中删除 token 和 Main ID，因此它启动的任何进程（包括通过 npm 或 uv 进行的 adapter 更新）都不会继承它们。daemon 环境中的其余部分来自启动它的进程（通常是 front door 或安装程序），会原样传给 Worker 及其终端，包括 API 密钥、云凭据和 `SSH_AUTH_SOCK`，因此通过环境变量登录的 provider 仍能正常工作。

Gateway 代 Worker 进行的文件读写（ACP `fs/read_text_file` 和 `fs/write_text_file`）即使在执行过程中被 Worker 换成符号链接或其他目录，也会留在会话根目录之内，碰不到受保护的路径。读取也不会返回含有 Gateway Control token 的文件，例如 `install.json` 的副本。安装程序替换 `install.json` 时，也会清空仍被硬链接持有的旧文件，但仅限于能做到的情况：在无法以不跟随链接的方式打开文件的 Windows 上不会清空，旧文件无法以写入方式打开时也不会清空。这样的链接仍保留旧内容，但 Gateway 的读取仍会因其中的 token 而拒绝它。在 macOS 和有 `/proc` 的 Linux 上，写入只会在经过检查的目录中创建新文件。在其他环境（没有 `/proc` 的 Linux 及其他系统）中，写入过程中的这种替换仍可能在换入的链接所指向的位置留下一个新的空文件；写入会被拒绝，该文件中不会写入任何内容。由于按名称删除同样可能被这种替换引向别处，Gateway 不会删除该文件。包括 Control MCP 在内的 Gateway 客户端只会把 token 发给同一用户拥有、且路径无法被其他用户篡改的 socket。Gateway 为 Worker 打开的终端在 macOS 上运行于一个拒绝访问受保护路径（`~/.acp-gateway`、状态目录和 socket）的沙箱中；`ps`、`top` 等 setuid 程序无法在其中启动，无法启动的命令会以退出状态 71 结束。在没有这种沙箱的环境中，即使是 `auto_approve`，也会把每个终端先交给编排器处理。批准 Worker 的某条命令，只会放行一次完全相同的命令：逐词相同，环境变量的名称和取值全部相同，工作目录也相同，而且必须是询问编排器时该路径上的那个目录本身，之后放到同一路径上的其他目录不算。批准某次编辑，会为其指明的每个文件各放行一次写入，但前提是该路径仍指向询问编排器时那里的文件；如果当时那里没有文件，这次写入只能新建文件。如果编辑请求向编排器展示了某个文件的 diff，这次写入还必须与这些 diff 应用到该文件后的结果完全一致，内容不同就会重新询问。其他终端或写入会连同命令、参数、工作目录和环境变量（让程序加载或运行其他代码的变量，如 `PATH`、`PYTHONPATH`、`LD_PRELOAD`，以及命令行引用的变量附带取值，其余只有名称），或者路径、大小、内容的 SHA-256 以及内容本身（最多前 2 KiB），一起交给编排器；在那里获批的终端只会在编排器看到的工作目录中运行，写入也只会写进询问编排器时该路径上的文件，当时没有文件的，只会写进它新建的文件。

但这并不能让所有 Worker 都拿不到 token：用自身工具读取文件、不经过 Gateway 的 Worker（实测 Codex 即使在 `read_only` 下也会这样读取）可以读到 `~/.acp-gateway/install.json` 中的 Control token，或 1.8.0 之前的安装程序写入了 token 的 agent 配置，并以 Main 的身份操作。因此，不要把不可信的内容（可能藏有提示词注入的仓库、文档或网页）交给这类 Worker；这类工作请优先使用由 Gateway 中转文件读取或用沙箱加以限制的 provider。Gateway 在某个会话中无法强制执行的项目，会列在 `permission_policy_partial` 警告中。更强的隔离计划在后续版本中提供。

### 更新

更新方式取决于 Gateway 是如何安装的。

**通过 npm 安装** — 先安装新版本，再刷新注册信息并重启 daemon：

```bash
npm install -g acp-gateway-daemon@latest
acp-gateway-bootstrap --update
```

对于 npm 安装，`--update` 自身不会运行 Git 或 npm：它会刷新 ACP registry、adapter 和 MCP 注册，并用 npm 安装的版本重启 daemon。npm 上有新版本发布时，Gateway 的 health check 提醒也会告诉你。

**从源码安装** — 只需执行下面这一条命令：

```bash
acp-gateway-bootstrap --update
```

**由应用管理的 runtime** — 如果 Gateway 是由桌面应用安装的（位于 `~/.acp-gateway/runtime/versions/` 下），则由该应用负责更新。此时 `acp-gateway-bootstrap --update` 不会改动 Gateway 的文件，只刷新注册信息。

更新之后，需要重新连接宿主（Claude/Codex/Grok/Auggie）会话，新的工具和参数才会显示出来。具体行为、skill 更新以及重新连接的步骤，请参阅[运维指南](docs/operations.md)（英文）。

## 工作原理

```mermaid
flowchart LR
    U["用户"] <--> M["编排器 AI<br/>(Main Agent)"]
    M <-->|"Control MCP"| G["ACP Gateway daemon"]
    G <-->|"ACP"| C["Claude Worker"]
    G <-->|"ACP"| X["Grok Worker"]
    G <-->|"ACP"| O["Codex Worker"]
    G <-->|"ACP"| A["其他被发现的 AI Worker"]
    G --- S[("会话·Task·Inbox 状态")]
```

编排器通过 MCP 下达任务，Gateway 通过 ACP 与各个 Worker 通信。Gateway daemon 负责管理 Unix socket、ACP 连接、会话、事件、权限请求以及最小化的恢复状态，因此即使编排器或 MCP 连接重启，也能继续控制正在运行的 Worker。

### 工作流水线

1. **发现与安装** — 安装程序找到本地的 AI，并从 ACP 官方 registry 准备好对应的 agent 和 adapter。
2. **创建任务** — 编排器通过 Control MCP 指定 provider、模型、工作路径和权限策略，打开会话。
3. **运行 Worker** — Gateway 启动对应 provider 的进程，或复用已有的进程和会话。
4. **通过 ACP 传递任务** — prompt、文件操作、tool event 和中间结果都经由 ACP 传递。
5. **处理权限与提问** — Worker 的权限请求或提问经过 Gateway Inbox 转给编排器，编排器的回应再返回给 Worker。
6. **回收与复用结果** — 编排器在 `agent_acp_wait` 中等待，或通过 MCP Task 或 poll 获取状态和结果，必要时可以再次调用或恢复同一个会话。

### 可靠性

Gateway 还会告诉编排器委派出去的工作进展到了哪一步，因此在重启之后或 Worker 长时间没有动静时，编排器无需猜测。

- **会话为何处于当前状态** — 每次状态变化都会记录原因和时间。运行中的 Worker 若一段时间（默认 5 分钟）没有发送任何内容，会被标记为疑似卡住；这只是提示，不会取消任何操作。
- **中断留下了哪些未知** — 因重启或 Worker 丢失而被中断的任务，会说明 Worker 是否可能已经根据 prompt 采取了行动，以及下一步该做什么。`agent_acp_session {action: "check"}` 只读、不启动任何进程，报告会话能否恢复。
- **attention inbox** — `agent_acp_inbox {action: "attention"}` 列出正在等待编排器处理的请求，以及编排器尚未收到的已完成结果；可用 `ack` 将其标记为已读。
- **无需轮询的等待** — 编排器在 `agent_acp_wait` 中等待：它启动的任务一完成（连同结果），或 Worker 有问题要问，这个调用就立即返回；否则会在一个 heartbeat 后返回，其时长按宿主允许单次工具调用的时长确定。AgenLynk 这类应用会把这样等待的编排器显示为正在等待自己的任务（`main_list` 和 `main_status` 事件），而不是空闲。
- **声明任务之间的关联** — run 可以指明它所跟进的任务（`parentTaskId`）以及使用了其结果的任务（`inputTaskIds`）。指定 `scope: "mine"` 时，会话和任务列表只显示发起调用的编排器自己的工作。
- **各编排器只处理自己的工作** — 多个编排器共用 Gateway 时（例如两个 Claude Code 对话，或两个 Codex thread），每个编排器只能查看和操作自己打开的会话及其任务、请求和结果，以及由不标明编排器的工具打开的会话。AgenLynk 这类不标明编排器的应用和管理工具仍然能看到全部内容。以新对话身份回来的编排器，可以在原来的编排器断开连接之后，显式调用 `agent_acp_session_restore`（provider、acpSessionId、cwd）取回之前的会话。这是为了让协同工作的 agent 互不干扰，并不是针对持有 Control token 的进程的安全边界。详见 [Per-Main isolation](docs/management-api.md#per-main-isolation)（英文）。
- **多次恢复失败后隔离** — 恢复连续失败（默认 3 次）后，Gateway 不再自动恢复该会话，而是返回 `SESSION_QUARANTINED` 并附上可选的后续操作；显式恢复成功后即解除隔离。

## 什么是 ACP 和 MCP？

[ACP（Agent Client Protocol）](https://agentclientprotocol.com/)是标准化代码编辑器、IDE 与 AI 编码 agent 之间通信的协议。各个编辑器不必再分别集成 Claude、Codex、Grok 这样的 agent，而是通过 ACP 这一通用规范来传递会话创建、prompt、tool 调用、权限请求、进度事件和结果。

在 ACP 规范中，本地 agent 通常以 JSON-RPC over stdio 的方式运行，远程 agent 则可以使用 HTTP 或 WebSocket 连接。**目前 ACP Gateway 的实现范围是：本地单机上的 ACP agent，以及 Unix socket 通信。** 暂不支持连接远程 agent。

- **ACP** 是用来运行 agent 本身、与其对话并管理任务状态的规范。
- **MCP（Model Context Protocol）** 是 AI 连接外部工具、数据和应用的通用接口。
- **ACP Gateway** 在内部通过 ACP 管理 Worker，并以 MCP 工具的形式向编排器提供这些控制能力。

也就是说，这并不是在 MCP 和 ACP 之间二选一。MCP 是编排器操作 Gateway 的入口，ACP 则是 Gateway 与其他 AI agent 实际协作的通信通道。

目前最新的规范是 [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)。ACP Gateway 并不声称实现了这份规范的全部内容，只支持其中以 task handle 启动长时间任务、之后再查询状态和结果的 **MCP Tasks extension 流程**。目前的本地 stdio MCP 服务器没有应用 stateless HTTP core 或 OAuth/OIDC 认证。关于 MCP 2026-07-28 的全部变更，请参阅 [MCP 官方规范](https://modelcontextprotocol.io/specification/2026-07-28)和 [Anthropic 的介绍](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude)。

## 与直接使用 Agent CLI、简单的 MCP 调用有什么不同？

这里的 **直接使用 Agent CLI**，并不是指人在终端之间来回切换操作，而是指你正在对话的编排器通过 shell tool 运行 `claude`、`grok` 之类的其他 AI CLI 进程，并接收 stdout 结果的方式。**简单的 MCP 调用** 则是把这种 CLI 运行封装成一个 MCP tool 的常见 wrapper 方式。

`O` 表示在通常的基本使用流程中就已支持，`X` 表示需要自己另外实现 daemon、会话存储或双向协议。这并不代表 CLI 或 MCP 协议本身在理论上的局限。

| 功能 | 直接使用 Agent CLI | 简单的 MCP wrapper | ACP Gateway | 实际差异 |
|---|:---:|:---:|:---:|---|
| 运行其他 AI | O | O | O | 三种方式都可以调用 Worker |
| 选择 provider·模型 | O | O | O | CLI 使用各 agent 自己的 flag，Gateway 使用统一的输入 |
| 在同一会话中继续反馈 | O | X | O | CLI 需要编排器自己管理 resume ID，Gateway 通过 session ID 管理 |
| 使用 Worker 内置的子 agent | O | O | O | 可以通过 prompt 请求，但 Gateway 还能回收 child event |
| 同时运行多个 Worker | O | O | O | CLI·wrapper 需要编排器自己管理调用关系 |
| 与连接分离的长时间任务 | X | X | O | Gateway 可以通过 MCP Task handle 稍后重新查询 |
| 查询·重放进度 event | X | X | O | Gateway 可以只重新查询 cursor 之后的新 event |
| 响应 Worker 的权限请求 | X | X | O | Gateway 将请求保存在 Inbox 中，并传达编排器的批准·拒绝 |
| 回答 Worker 的中途提问 | X | X | O | 一次性调用很难在同一次运行中作答，Gateway 通过 elicitation 往返 |
| 取消时确认状态直至 Worker 进程 | X | X | O | Gateway 同时管理 ACP cancel 和子进程的终止 |
| 编排器·MCP 重启后重新连接任务 | X | X | O | 独立的 daemon 会保持 Worker 和会话 |
| 无重复的增量结果回收 | X | X | O | 通过 cursor 和 `includeResult` 只回收所需的数据 |
| 自动清理被搁置的会话 | X | X | O | 应用 idle unload 和 retention GC |
| 结构化的故障诊断·恢复状态 | X | X | O | 将 event、task 状态和 checkpoint 分开查看 |

## 安装会对你的机器做哪些改动

安装软件包以及执行 `acp-gateway-bootstrap --install-all` 实际会做的改动如下。加上 `--dry-run` 时，bootstrap 只输出计划，不做任何实际改动。

- **Gateway 软件包（npm 安装）** — `npm install -g` 会把软件包安装到 npm 的全局 prefix 下：文件位于 `$(npm root -g)/acp-gateway-daemon`，`acp-gateway-*` 命令位于 `$(npm prefix -g)/bin`，下面注册的 MCP 服务器也从这里运行。从源码安装时，则由 `npm link` 把 checkout 链接到相同的位置。
- **安装 ACP agent/adapter** — 从 PATH、常见的 CLI 路径和全局 npm 包中查找已安装的 AI，与 ACP 官方 registry 比对，然后全局安装或更新 registry 所指定的 `npx`、`uvx` 包（`npm install --global` 或 `uv tool install --force`）。registry 中没有的 AI 不会被自动注册。
- **注册 MCP** — 通过各 CLI 的 `mcp add` 命令（Auggie 为 `mcp add-json`）注册两个 MCP 服务器。面向编排器的 Control MCP `agent-acp` 只会注册到你选作 front door 的那一个 CLI（`--front-door`；非交互式安装时为 Codex），只读的 Guide MCP `agent-acp-guide` 则会注册到所有被发现的受支持 CLI（Codex、Claude、Grok、Auggie）。Control MCP 注册时不带 Control token 和 Main ID：服务器在启动时从 `install.json` 读取它们（如果条目的环境变量中设置了 `ACP_GATEWAY_CONTROL_TOKEN` 和 `ACP_GATEWAY_ROOT_ID`，仍以它们为准），因此 agent CLI 的配置和注册条目所用的命令行中都不会出现 token。只有当 `install.json` 不在默认路径时，条目才会带上 `ACP_GATEWAY_INSTALL_STATE`，即它的位置。Control MCP 拥有 Gateway 的全部控制权，所以请只在你信任的本地 agent 上安装。如果已经存在同名但并非由安装程序创建的条目，没有 `--force` 时不会覆盖，而是报错中止。
- **迁移早期安装留下的 token** — 1.8.0 之前，安装程序会把 token 和 Main ID 放进 Control MCP 条目的环境变量中。安装程序能证明由自己注册的条目（所有权检查见[运维指南](docs/operations.md#control-identity-and-token-rotation)（英文））会在不带它们的情况下重新注册；原先启动旧版 Gateway 的条目也会同时改为指向本次安装。其他仍持有 token 的条目（1.7.2 之前注册的、之后环境变量被改动过的，或启动另一个 Gateway 安装的条目）会保持原样并给出警告；如果它所在的配置文件并非只有你可读，安装程序会将其改为只有你可读（Grok CLI 会把自己的配置写成 0644）。使用 `--force` 可以不带 token 重新注册。agent CLI 生成的配置备份（`*.bak`）中可能仍留有旧 token，因此迁移之后安装程序会建议你作废它：在 Gateway 空闲时将其停止（`acp-gateway-admin shutdown_if_idle`），运行 `acp-gateway-bootstrap --rotate-token`，然后重新连接各个宿主会话以及 AgenLynk 这类会保存身份信息的应用，因为它们都只在启动时读取一次。安装程序从不自行更换 token。`--rotate-token` 只替换 `install.json` 中的身份信息：不带 token 的条目会在下次启动时读取新值。只要有一个条目未能更新，这次更换就不会生效，`install.json` 会保留之前的身份信息；安装程序改写的每个条目都会在改写后立即记入 `install.json`。
- **安装 `agent-delegator` skill** — 把 Gateway 自带的 skill 复制到每个被发现的 AI 的 skills 目录。

  | AI | 安装路径 | 用于改变路径的环境变量 |
  |---|---|---|
  | Codex | `~/.codex/skills` | `CODEX_HOME`（设置后为 `$CODEX_HOME/skills`） |
  | Claude | `~/.claude/skills` | `CLAUDE_HOME`（设置后为 `$CLAUDE_HOME/skills`） |
  | Grok | `~/.grok/skills` | `GROK_HOME`（设置后为 `$GROK_HOME/skills`） |
  | Auggie | `~/.augment/skills` | `AUGMENT_HOME`（设置后为 `$AUGMENT_HOME/skills`） |
  | 其他 registry provider | `~/.agents/skills` | 无 |

  如果有多个 provider 使用同一路径，skill 文件只会复制一次。skill 只在首次 `--install-all` 时安装，`--update` 不会碰它。如果已经存在同名但不受安装程序管理的 skill，没有 `--force` 时不会覆盖，而是报错中止。
- **状态文件 `~/.acp-gateway/`** — 会创建以下文件：
  - `install.json`（权限 `0600`）：Control token 和 Main ID（安装程序保存的唯一一份，Control MCP 在启动时读取）、安装程序所注册的 MCP 和 skill 的记录，以及 ACP agent 自动更新和通知的设置
  - `registry.json`：ACP 官方 registry 的 24 小时缓存
  - `providers.json`：被发现的 provider 的运行定义

  daemon 运行之后，同一目录下还会出现会话状态（`state.snapshot.json`、`state.wal.ndjson`）和 `artifacts` 目录。
- **启动 daemon** — 安装完成后，会通过 health check 启动 Gateway daemon 并确认认证状态；如果正在运行的 daemon 版本不同，则会替换为新版本。可以用 `--skip-health-check` 跳过这一步。

Gateway 本身只会在你主动更新时才改变：npm 安装用 `npm install -g`，源码 checkout 用 `acp-gateway-bootstrap --update`，由应用管理的 runtime 则通过该应用更新。安装程序没有卸载命令，所以如果想还原，需要自行删除上述各项；npm 软件包可以用 `npm uninstall -g acp-gateway-daemon` 删除。

## 文档

- [管理 API 契约](docs/management-api.md)（英文）— 引擎设置、provider 策略、安全关闭、任务等待与 Main 状态（`wait`、`main_list`）以及公开 client 的契约（`acp-gateway-daemon/client`；在应用挂载的 runtime 中为 `acp-gateway/client`）
- [Live use cases](docs/live-usecases.md)（韩文）— 用真实的 Claude、Codex、Grok Worker 跑过的使用案例记录
- [运维指南](docs/operations.md)（英文）— 安装程序选项、更新、宿主重新连接、Worker 参数控制、会话与数据管理
- [变更日志](CHANGELOG.md)（英文）— 各版本的变更

## 许可证

Apache License 2.0 —— 详见 [LICENSE](LICENSE)。

---

Dev by 윤치영
