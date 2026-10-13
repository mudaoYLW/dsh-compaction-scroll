# dsh-compaction-scroll

为 DeepSeek Harness 增加「笔记 + 原始历史找回 + 显式换窗」，并提供独立的 **Minimal Notes** 模式。借鉴 Codex 实验性上下文管理，不调用 OpenAI 私有 notes/history 后端，也不另调模型生成压缩摘要。

兼容基线：npm 官方 `latest` 的 **DeepSeek Harness 0.2.0-rc.2**。不是旧 checkout 的 0.1.x，也没有选择 `alpha` 标签。包声明了精确的 DSH host peer，默认安装检查会拒绝其他宿主版本；升级宿主前需重新验证。Node.js ≥22.19。

## 本地安装

先确保 `dsh --version` 输出 `0.2.0-rc.2`。如需安装该版本：

```sh
npm install -g @deepseek-ai/dsh@0.2.0-rc.2
```

`dsh plugin` 需要 PATH 中有 pnpm；若尚未安装，先运行 `npm install -g pnpm@10`。

在本项目目录执行，创建独立的 Web profile，不改已有 profile：

```sh
dsh --profile scroll-notes --from-default-profile web --dump-config
dsh plugin --profile scroll-notes add "$PWD"
dsh --profile scroll-notes
```

在 Web 界面**新建会话**，选择 **Minimal Notes**。包只增加模式，不替换内置 minimal，不修改默认模式，也不向工作目录写笔记文件。最新版本的 minimal 通过持久 shell 完成编码；本模式保留该组合并增加下面的工具。

已有 Web profile 可只执行 `dsh plugin --profile <你的profile> add "$PWD"` 后重新启动。必须是 Web-backed profile；普通 base/headless profile 没有模式注册服务。也可 `npm pack` 后通过 `dsh plugin ... add /绝对路径/dsh-compaction-scroll-0.1.0.tgz` 安装，无构建脚本。

也可直接从 GitHub 安装到已初始化的 Web profile（纯 ESM，无需编译）：

```sh
dsh plugin --profile scroll-notes add github:mudaoYLW/dsh-compaction-scroll
```

仓库地址：https://github.com/mudaoYLW/dsh-compaction-scroll 。需要固定版本时，在安装地址后追加 `#<提交 SHA>`。

卸载：`dsh plugin --profile scroll-notes remove dsh-compaction-scroll`。先结束使用该模式的会话；恢复该模式的旧会话仍需要安装此包。

## 工作方式

1. 模型用 `scroll_notes_write` / `scroll_notes_append` 保存虚拟笔记。成功工具结果及笔记正文进入 Harness 原始 Session 日志；正文的唯一权威来源是日志，投影只缓存可重建的事件引用和计数。
2. 接近工作预算时，插件注入一次提醒，要求保存 `handoff.md`：当前目标、用户约束、已验证进展、未完成步骤和证据 event seq。
3. 模型在后续响应中**单独调用** `new_context({})`。没有当前窗口的新笔记、笔记为空/过长、与其他工具同批调用，或交接无法装入新窗口预算，都会作为工具错误拒绝，模型仍可修正交接。
4. 下一请求边界先 flush 日志，再用 Harness 的 `surfaceOp: replace` 替换模型可见历史，保留头部系统提示，并在启用 runtime context 时补入当前快照。新窗口直接收到完整交接、最新用户输入的有界摘录和历史读取指引。替换记录持久化成功后才继续请求模型。
5. 原始历史不删除。通过 `scroll_history` 检索和精确读取旧 event；重启、恢复和 fork 从已提交日志重建笔记。已接受的换窗按原笔记路径和修订恢复；若恢复时不再满足换窗条件，会记录拒绝并取消该请求，不会反复卡住会话。已提交的换窗不会重复执行。

笔记是**会话私有**数据；fork 继承其日志切点内的笔记，之后各自独立。不是跨会话长期记忆。历史检索仅限当前会话（含继承的历史），不会扫描其他工作区。

| 工具 | 参数与用途 |
| --- | --- |
| `scroll_notes_write` | `{path, text}`，完整替换笔记 |
| `scroll_notes_append` | `{path, text}`，原样追加，不自动补换行 |
| `scroll_notes_read` | `{path, start_line?, stop_line?, offset?, limit?}`，行号从 1 开始、闭区间；字符分页作用于所选行范围 |
| `scroll_notes_list` | `{prefix?, offset?, limit?}`，分页列出笔记 |
| `scroll_history` | `{operation, window_id?, seq?, query?, offset?, limit?}`；operation 为 `windows`、`list`、`search`、`read` |
| `new_context` | `{}`，先保存交接，再独占一轮工具调用 |
| `get_context_remaining` | `{}`，查询配置的工作预算剩余量，不等同于模型最大上下文 |

历史窗口 ID 是 checkpoint event seq，初始窗口为 `-1`。搜索是大小写敏感的字面子串，覆盖正文/可见 reasoning，不是向量检索。`read` 按 UTF-16 字符偏移分页返回原始 event JSON 文本，拼接 `text` 即可恢复原文；其他 history 操作按条目分页。使用返回的 `next_offset`，不要根据页长猜偏移。旧事件含当时的工具输出和笔记元数据，可能含敏感信息；保护好 Harness 的会话存储目录。

这里的原文是**进入日志的工具结果**，不是进程产生过的完整 stdout。宿主 bash 工具在入日志前截断的内容不能由本插件恢复；通用 spill 外置和本插件的分页读取也不是同一种机制。

### 后台子代理

Minimal Notes 使用宿主原生 `spawn` continuable 子代理，额外提供四个工具，不加入 fork、workflow 或模型选择工具：

| 工具 | 参数与用途 |
| --- | --- |
| `subagent` | `{description, prompt, run_in_background?}`，默认后台运行并返回子代理 ID；设为 `false` 等待一次性结果 |
| `send_message` | `{agent_id, message}`，向子代理发送补充任务/指令；收到回执不代表任务完成 |
| `interrupt_agent` | `{agent_id}`，请求中断当前执行；不是同步终止，也不停止后代 |
| `list_agents` | `{scope?}`，查看 `children`（默认）或 `descendants`；running/inactive 不代表成功/失败 |

后台完成或失败会自动通知父会话；空闲的常驻子代理可用 `send_message` 继续工作。子代理继承父会话的模式及模型路由，但**不继承父会话的聊天历史、笔记和交接**；委派提示必须自包含。文件系统仍共享，应明确文件归属，避免同时修改同一文件。权限、递归深度及并发上限沿用宿主策略，不由本插件放宽。

模式保留宿主 runtime context：子代理能看到实际 sandbox/approval 策略及固定委派权限说明，换窗后仍保留当前快照。这些提示同样计入预算；子代理需要审批的操作由宿主自动拒绝，应将权限不足报告给父代理，而不是反复重试。

父会话换窗不终止子代理。换窗前将未完成任务的子代理 ID、职责和待回收结果写入交接；换窗后查状态、接收结果，不要重复委派。四个工具的定义也计入上下文预算；有子代理能力不等于应当将简单任务拆开。


## 配置与安全边界

模式注册插件 `preset-minimal-notes` 的 Config 会传给该模式的运行插件。可通过 Harness 插件配置界面调整，重新创建使用新配置的会话。自定义 Cordis composition 也可直接挂载 `dsh-compaction-scroll` 并传 Config；需要 `tools`、`sessions`、`sessionPersistence`、`sessionProjections`、`systemPrompt`、`tokenMeter` 服务以及实际 Session 写入者。

| 配置 | 默认值 | 含义 |
| --- | ---: | --- |
| `contextBudgetTokens` | 64000 | 工作窗口预算，必须留在实际模型上限以内 |
| `reminderTokens` | 8000 | 剩余量低于此值时提醒整理交接 |
| `checkpointPath` | `handoff.md` | 按字面值使用的交接路径；`$&`、`{{...}}` 不会被当作替换符或模板执行 |
| `maxCheckpointChars` | 16000 | 交接最大字符数，正文不会被静默截断 |
| `maxNoteBytes` | 65536 | 单条笔记 UTF-8 字节上限 |
| `maxNotes` | 64 | 每会话笔记数量上限 |
| `maxTotalNoteBytes` | 262144 | 所有当前笔记正文总字节上限 |
| `maxResults` | 20 | 列表/历史检索单页条数上限 |
| `maxOutputChars` | 12000 | 历史 JSON 响应上限、笔记读取字符页上限、最新用户输入摘录上限 |

- 预算来自 Harness token meter 的实际 usage 与估计，可能有误差，也不能预知下一次超大工具输出。预估会计入即将使用的提示和工具定义；请求发往模型前，再对已组装的完整请求（含提醒）做最终检查。请为真实模型输出留足余量。
- **预算耗尽时停止，不用旧交接强制清空历史。** 被拒绝或中断的输入保留原消息身份，恢复后继续使用，不重复插入，也不自行忙循环重试；显式取消的排队输入不会被恢复。若仍超预算，需要提高预算后继续。配置更新如何作用于已挂载会话取决于宿主的 preset revision 生命周期。
- 笔记写入的工具结果在下一安全边界和正常会话关闭时 flush；换窗前强制确认持久化。保存/flush 失败不执行未提交的替换；替换后 flush 失败则阻止下一次模型调用。持久化的未入模输入引用支持崩溃恢复，但永久存储故障不能保证写下任何新字节。
- 不能与同一作用域的旧自动 compactor 混用。内置 Web 的宿主 compactor 默认禁用，standard 模式自己的配置不受影响；插件会在加载和每次请求边界检查继承的 `compaction` 服务，发现冲突便停止。
- `new_context` 不结束任务、不切换 Session ID、不关闭 shell、不删除工作文件，也不做跨会话记忆。只支持直接模型工具调用，不支持藏在 PTC/nested transport 内调用。

## 开发验证

```sh
npm install
npm test
```

离线验证采用已发布 Harness 的真实 agent-loop、工具执行器、token meter 和 JSONL 持久化，仅模型输出由脚本提供，不消耗 API 额度。这不能证明 DeepSeek 在真实长任务中一定遵循交接提示。不要整体省略宿主的 optional dependencies：JSONL 文件锁等实际能力也使用平台原生包。

子代理回归使用真实 preset registry、spawn provider、持久 shell、sandbox 和 approval 服务，覆盖父会话换窗后的结果回收、父子同名笔记隔离，以及前台委派结果返回。POSIX shell 场景实际读取共享工作区文件，并验证子代理继承父会话的只读覆盖、审批策略固定为 `never`、子代理换窗后权限快照仍在且写入被拒绝，原文件不变。该 shell 场景在 Windows 跳过；本地验证平台为 macOS，未据此宣称 Windows/Linux、真实模型委派质量或远端部署已验证。消息续跑、任务列表和中断另经离线 smoke 验证。

本地实测可要求模型先记录一个工具结果，保存交接并换窗，随后用 `scroll_history` 找回精确原文；再重启 Harness，恢复会话读取笔记。检查它继续原任务，而不是只输出交接摘要后停止。
