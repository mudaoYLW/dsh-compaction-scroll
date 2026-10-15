# dsh-compaction-scroll

为 DeepSeek Harness 增加「持久笔记 + 原始历史找回 + 显式换窗」，提供独立的 **Minimal Notes** 模式。借鉴 Codex 实验性上下文管理，不调用 OpenAI 私有后端，不另调模型生成压缩摘要。

已验证组合：**DeepSeek Harness 0.2.0-rc.2 + Cordis 4.0.4**，Node.js ≥22.19。核心运行时声明精确 peer；升级宿主需重新验证，不自动跟随 npm latest。

## 安装

先确认 `dsh --version` 为 `0.2.0-rc.2`；需要时执行 `npm install -g @deepseek-ai/dsh@0.2.0-rc.2`。`dsh plugin` 需要 PATH 中有 pnpm，可用 `npm install -g pnpm@10` 安装。

在项目目录创建独立 Web profile，不改已有 profile：

```sh
dsh --profile scroll-notes --from-default-profile web --dump-config
dsh plugin --profile scroll-notes add "$PWD"
dsh --profile scroll-notes
```

新建会话并选择 **Minimal Notes**。本包不替换内置 minimal、不修改默认模式、不向工作目录写笔记文件。已有 Web profile 可只执行 `dsh plugin --profile <你的profile> add "$PWD"` 后在安全时机重启；普通 base/headless profile 没有模式注册服务。

也可重新 `npm pack` 后安装生成的 tarball，或从 GitHub 安装：

```sh
dsh plugin --profile scroll-notes add github:mudaoYLW/dsh-compaction-scroll
```

仓库：https://github.com/mudaoYLW/dsh-compaction-scroll 。固定版本时追加 `#<提交 SHA>`。纯 ESM，无构建步骤。

**核心依赖必须共用宿主副本。** Cordis、`dsh-tools`、`dsh-llm`、`dsh-scope`、`dsh-system-prompt`、`dsh-token-meter` 仅作为运行时 peerDependencies。不要为消除 profile 的 missing-peer 提示另装 Harness 核心包，也不要开启自动 peer 安装；同版本的两份模块仍可能因内部 Symbol 不同而出现 `.prepare` 调度错误。

升级不要复用旧 `.tgz`。安装新包后可执行 `dsh plugin --profile <你的profile> prune` 清理失去依赖的包；其他插件仍依赖的私有核心副本需先修正依赖声明。确认依赖后在安全时机重启，验收实际 shell 和笔记读写；刷新页面不替换进程中已加载的模块。

卸载：`dsh plugin --profile scroll-notes remove dsh-compaction-scroll`。先结束使用该模式的会话；恢复该模式的旧会话仍需要安装此包。

## 工作方式

1. 模型通过 `scroll_notes_write` / `scroll_notes_append` 保存会话私有虚拟笔记。正文记录在 Harness Session 日志，投影只保存可重建的引用与计数。
2. 接近工作目标时提供**软提醒**。默认目标 64K、提醒阈值 56K；超过目标仍可请求模型、执行命令、读写笔记及使用子代理。插件不设置额外硬限制，不改模型路由或输出额度。
3. 交接记录目标、约束、已验证进展、下一步、未完成子任务 ID 和证据索引，细节放其他笔记。交接写入超出字符上限时直接拒绝，保留旧笔记。成功写入后，模型**单独调用** `new_context({})`。
4. `new_context` 要求当前窗口的新交接、独占本次工具调用；成功工具结果表示换窗请求已登记，不表示已经换窗。下一请求边界检查笔记修订和工具结算，并且只在这里校验新窗口大小：通过宿主完整 `systemPrompt.assemble` 获取当前提示与工具定义（包括 complete persona 的最终覆盖），计入交接、保留的运行时上下文和本轮新输入，不计入将被撤掉的预算提醒。校验拒绝保留旧上下文并取消这次换窗，不锁住后续请求。
5. 提交换窗前先 flush 原日志，再用宿主 `surfaceOp: replace` 替换模型可见历史，保留头部系统提示和当前 runtime context。新窗口收到完整交接、最新人工输入的有界摘录及原始 event seq；换窗记录 flush 成功后才继续请求模型。
6. 原始历史不删除，按需检索和精确读取。重启及 fork 从日志重建笔记；已提交的换窗不重复执行。已接受但未提交的换窗按原路径和修订处理，条件不再满足则拒绝一次。

软提醒通过宿主 runtime-context 注入和去重，依据**已提交上下文**的 token meter 用量；不能提前拦住一次超大输入或输出。禁用 runtime-context 后不会注入提醒，预算查询工具仍可用。提醒只是建议，模型未必及时执行。

新窗口校验使用宿主公开的启发式消息与工具定义估算，不继承旧正文的 usage 校准差额。普通预算查询和提醒仍使用宿主实际 usage（含缓存输入）与估算，未修改原生计量状态；换窗后的新回复落盘后按新窗口的 usage 继续校准。新窗口估算不是供应商精确分词，不能替代真实模型容量限制。

### 职责与限制

- 插件只管理笔记、历史读取和显式换窗；入队、接纳、重试、输出配置、取消与父子任务结算由宿主负责。没有第二套队列、恢复次数、分批重放或内部派发拦截。
- 工作目标不是模型窗口。请在实际模型容量内给输出和突发工具结果留空间；真正达到供应商窗口限制仍可能失败，插件不会用旧交接强制重置，也不保证无限运行或无损语义记忆。
- 存储错误停止受影响请求。换窗前原始记录必须已持久化；替换后 flush 失败不等于内存已回滚，恢复以持久日志为准。插件不额外重放宿主已认领的失败输入，永久存储故障不能保证新数据落盘。
- 笔记是会话私有数据，不是用户级或项目级日记。原生 fork 继承切点内的笔记后各自独立；spawn 子代理从自己的新历史开始。
- `new_context` 不结束任务、不切换 Session ID、不关闭 shell、不删除工作文件。仅支持直接模型工具调用，不支持嵌套工具传输。
- 不能与同一作用域的自动 compactor 混用；加载和请求边界会检查继承的 `compaction` 服务。本包不改变其他模式。
- 换窗校验额外调用一次公开的提示组装 API；不拦截宿主内部派发，也不改变原生请求。自定义提示、变量及工具定义 provider 应无副作用，并在同一请求边界返回稳定结果；依赖组装调用次数改变内容的扩展不受支持。

## 工具

| 工具 | 参数与用途 |
| --- | --- |
| `scroll_notes_write` | `{path, text}`，完整替换虚拟笔记 |
| `scroll_notes_append` | `{path, text}`，原样追加，不自动补换行 |
| `scroll_notes_read` | `{path, start_line?, stop_line?, offset?, limit?}`，1-based 闭区间行号，字符分页作用于选中范围 |
| `scroll_notes_list` | `{prefix?, offset?, limit?}`，分页列出笔记 |
| `scroll_history` | `{operation, window_id?, seq?, query?, offset?, limit?}`；operation 为 `windows`、`list`、`search`、`read` |
| `new_context` | `{}`，先保存交接，再独占一轮工具调用 |
| `get_context_remaining` | `{}`，返回 `tokens_left`、`used_tokens`、`budget_tokens`、`reminder_threshold_tokens`、`over_budget`、`soft_limit`、`baseline` |

历史窗口 ID 是 checkpoint event seq，初始窗口为 `-1`。搜索为大小写敏感的字面子串，不是向量检索。`read` 按 UTF-16 字符偏移分页返回原始 event JSON 文本，拼接 `text` 可恢复原文；其他操作按条目分页。使用返回的 `next_offset`。

可找回的原文是**进入日志的结果**，不是进程产生的完整 stdout。宿主 bash 在入日志前已截断的部分无法恢复；本插件不接管通用工具输出截断或 spill。日志和笔记可能含敏感信息，应保护宿主会话存储目录。

### 原生子代理

Minimal Notes 保留宿主持久 shell，增加原生 spawn continuable 子代理能力：

| 工具 | 参数与用途 |
| --- | --- |
| `subagent` | `{description, prompt, run_in_background?}`，默认后台返回 ID，设为 false 等待结果 |
| `send_message` | `{agent_id, message}`，补充任务；回执不代表完成 |
| `interrupt_agent` | `{agent_id}`，请求中断当前执行，不同步终止或停止后代 |
| `list_agents` | `{scope?}`，默认 children，可选 descendants；活动状态不代表成功 |

子代理继承模式和模型路由，但不继承父会话聊天、笔记或交接；委派提示必须自包含。共享文件系统需明确文件归属。权限、审批、递归与并发限制沿用宿主，不由插件放宽。runtime context 保留实际权限提示，包括子代理换窗后。

父会话换窗不终止子代理。换窗前保存子代理 ID、职责和待回收结果，换窗后继续接收原生通知，不重复委派。插件不再暂存通知、重写终态或恢复暂停的子任务。

## 配置与迁移

`preset-minimal-notes` 的 Config 传给运行插件，可在宿主插件配置界面调整。已有会话须确认重新挂载后的实际配置，不假定修改 preset 会立即更新运行中的实例。自定义 composition 需要 `tools`、`sessions`、`sessionPersistence`、`sessionProjections`、`systemPrompt`、`tokenMeter` 和实际 Session 写入者。

| 配置 | 默认值 | 含义 |
| --- | ---: | --- |
| `contextBudgetTokens` | 64000 | 软工作目标，不是请求硬上限 |
| `reminderTokens` | 8000 | 距软目标的提醒余量；新窗口必须小于两者之差 |
| `checkpointPath` | handoff.md | 虚拟交接路径，按字面值使用 |
| `maxCheckpointChars` | 16000 | 交接全文 UTF-16 字符上限；写入/追加提前校验 |
| `maxNoteBytes` | 65536 | 单条笔记 UTF-8 字节上限 |
| `maxNotes` | 64 | 当前笔记数量上限 |
| `maxTotalNoteBytes` | 262144 | 当前笔记正文总字节上限 |
| `maxResults` | 20 | 列表与历史检索单页条数上限 |
| `maxOutputChars` | 12000 | 历史 JSON 响应上限、笔记读取字符页上限、最新人工输入摘录上限 |

**从旧恢复版迁移：** 删除配置中的 `recoveryReserveTokens`、`recoveryMaxSteps`、`recoveryOutputTokens`；这些设置和 `recovery_phase` 等状态字段已移除。旧笔记、交接和原始历史继续可读，旧恢复状态不再控制运行。旧日志中暂存或已接纳的证据可按原 event seq 用 `scroll_history read` 读取，包括空 `agent/inbox/spliced` 的元数据；不自动重新注入模型，也不加入普通 list/search 的重复结果。遗留控制载体在新输入边界过滤，不重写历史。原有未完成工作应先检查日志与子任务实际状态，再明确续接。

## 开发验证

```sh
npm install
npm test
DSH_PACKED_RUNTIME=1 DSH_PACKED_HOST="$PWD" node --test test/packed-runtime.test.js
```

回归使用已发布 Harness 的真实 agent-loop、工具执行器、JSONL、token meter、preset、spawn、sandbox 和 approval；仅模型输出由脚本提供，不消耗 API。覆盖笔记配额、历史精确分页、连续换窗和重启、换窗失败与突发输入、软目标以上工具执行及原生子代理完成/中断。换窗预算回归覆盖提示/工具定义突然增大、complete persona 覆盖、紧预算下撤掉提醒但保留真实运行时策略，以及带供应商 usage/缓存输入时的换窗和后续预算校准。Chat/Trajectory 的 steering 分类使用宿主实际投影定义验证，不等于浏览器视觉验收。

额外打包验证会创建 tarball 并安装到临时独立 profile，使用官方解析器核对宿主依赖身份，执行真实 `bash` 和笔记读写。`DSH_PACKED_HOST` 指向已有 Harness 安装所在项目，省略则安装独立宿主；依赖需要注册表或完整缓存，可用 `npm_config_offline=true` 禁止联网。不要整体省略宿主 optional dependencies，文件锁等能力依赖平台原生包。

本地 smoke 已执行“超软目标输入 → shell 写文件 → 保存交接 → 换窗 → 读取原始历史 → shell 继续读取文件”。验证平台为 macOS，POSIX 测试在 Windows 跳过；不据此声称远端已部署、其他平台或真实模型长任务质量已验证。真实模型仍需实测能否及时写好交接、按需找回证据并继续原任务。
