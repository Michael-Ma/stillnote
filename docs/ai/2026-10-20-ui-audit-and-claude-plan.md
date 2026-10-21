# Stillnote：UI/UX 评估 + Claude 订阅接入方案（待批准）

日期：2026-10-20 · 截图来自隔离的假数据（`docs/ai/ui-audit/`），1280×860 与 1024×700 两种窗口。

## 一、现状评估

整体方向是对的：安静的纸张底色、衬线标题、首页 → 文档 → 底部 dock 的结构清楚。问题主要集中在**可读性**、**主操作不突出**、**状态信息占位过大**，以及 CSS 迭代累积导致很难继续改。

### P0：直接影响使用

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| 1 | **录音入口太弱**。这是会议笔记 App 最核心的操作，但只是 dock 左侧一个没有文字的波形圆钮，视觉权重跟“Chat”一样甚至更低。 | `02-new-note-empty.png`、`07` | 新笔记里用带文字的主按钮“● Start recording”；录音中 dock 变成录音条（时长、电平、Finish）。 |
| 2 | **转录覆盖率警告占位过大**。琥珀色大卡片钉在 tabs 上方，所有 tab（包括 Enhanced）都显示，把正文往下推了约 120px。 | `07`、`08`、`10` | 缩成标题下一行可关闭的提示条；详细说明和“重试转录”放到 Recordings tab 里。 |
| 3 | **AI 未连接的状态藏得太深**。只在聊天输入框里用 10px 灰字写“Connect ChatGPT in Settings”。发送按钮看起来像能点。侧栏底部“Stillnote · Local ⌄”也不显示连接状态。 | `10`、`11` | 在聊天和 Enhanced 的空状态里直接放“连接 AI”的按钮；侧栏底部显示当前 AI provider 和连接状态。 |
| 4 | **录音播放用的是浏览器原生 `<audio>`**，跟整体视觉不搭。麦克风和会议音频是两个互不联动的播放器。转录时间戳不能点击跳转。 | `09-recordings-saved-audio.png` | 自定义播放器：一个播放头同时播两路（可各自静音），点击转录时间戳跳到对应位置。 |
| 5 | **空白新笔记没有引导**。4 个 tab 全显示（3 个是空的），“Enhance notes”在空笔记上也是可点的。 | `02` | 渐进展示：没有转录或录音时隐藏或弱化对应 tab。Enhance 在没有内容时禁用，并说明原因。 |

### P1：视觉系统

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| 6 | **字号整体太小**。`style.css` 里有 51 处 10px、16 处 9px、8 处 8px。macOS 正文基准是 13px。tab、元信息、聊天建议都只有 10–11px。 | CSS 统计 | 统一字号阶梯，例如 11 / 12 / 13 / 15 / 20 / 28 / 36，正文不低于 13px。 |
| 7 | **次要文字对比度不达标**。`--muted #777e77` 在背景上只有 3.89:1，在侧栏上 3.67:1，低于 WCAG AA 的 4.5:1，而且多用在小字号上。Enhanced 正文是偏灰的橄榄绿，读起来吃力。 | 对比度计算 | muted 色加深到 4.5:1 以上；正文改用 ink 色，绿色只用于强调。 |
| 8 | **噪音元素多**。首页每行都有锁图标（全部都是本地笔记，信息量为 0）。字母头像用随机浅色。“Quick note”在顶栏和空状态里重复出现。返回按钮是 ← 加房子两个图标。 | `03` | 去掉无信息的锁图标；头像改成中性色或参与人数；返回键只用一个图标。 |
| 9 | **元信息像表单**。“With …”和文件夹都是带边框的输入框，破坏了“文档”的感觉。 | `07` | 平时看起来是文字，hover 或聚焦时才出现输入框（chip 样式）。 |
| 10 | **Settings 是一个长滚动弹窗**。标题是“Make yourself at home.”，账号、录音、数据混在一起，用复选框而不是开关，说明文字很长。 | `12` | 改成左侧分栏的偏好设置（AI、Capture、Notebook、About），AI 页用 provider 卡片（ChatGPT / Claude），见第二部分。 |
| 11 | **聊天面板浪费空间**。“LOOKING AT”是 9px 大写字。空状态用了很大的衬线标题和大片留白，建议问题的字很小。1024 宽时编辑区被压窄。用户消息是整行绿色色块，角色标签是“YOU / STILLNOTE”大写小字。 | `10`、`11`、`14` | scope 改成输入框上方的 chip；用紧凑的消息气泡；窄窗口时聊天面板改为覆盖层。 |
| 12 | **没有深色模式**。CSS 里没有任何 `prefers-color-scheme`。作为 macOS 原生体验的 App，这是明显的缺口。 | grep | 先建立 token 层，再加深色主题。 |
| 13 | 浮动 dock 后面没有渐隐遮罩，正文滚动时直接从 dock 下面穿过，文字和 dock 撞在一起。 | `07`、`08` | 在 dock 后面加一个渐变背景。 |

### P2：工程层面（不先处理，重设计很难做）

- `app/style.css` 有 2781 行，**384 种硬编码颜色**，只有 20 处用了 `var()`，**70 个选择器被重复定义**（例如 `.note-editor` 3 次、`.prose h3` 5 次），`@media` 断点块也重复了 3 组。这是多轮“在后面覆盖前面”留下的结果。
- `app/ui.jsx` 有 1644 行，基本都在一个 `App` 组件里。

## 二、UI 重设计方案（分步，每步可回退）

1. **方向稿（先不改代码）**：做 2 个 HTML 方向稿，覆盖首页、文档 + 录音中、Settings / AI provider。方向 A：保留现在的纸张感，修正可读性和层级。方向 B：更接近 macOS 原生（侧栏毛玻璃、系统字号、深色模式优先）。你选一个再动手。
2. **Token 层**：新建 `app/tokens.css`（颜色、字号、间距、圆角，含深色），把硬编码颜色和字号迁移过去，删掉重复的选择器。这一步只重构、尽量不改外观，用前后截图对比确认。
3. **拆组件**：把 `ui.jsx` 拆成 `Sidebar`、`Editor`、`Dock`、`ChatPanel`、`SettingsDialog`，行为不变，E2E 全绿后再继续。
4. **按方向稿逐屏落地**：文档页和录音 dock（P0 #1 #2 #5）→ 首页 → 聊天 → Settings → 播放器（#4）→ 深色模式。每一屏单独提交，附截图。

**测试**：每一步都跑 `npm test`、`npm run test:ui`、`npm run test:e2e`。E2E 用 role 和 name 定位元素，改文案时同步更新测试。截图用现有的 `npm run screenshots`，再加上本次的审计截图脚本。

**风险**：E2E 依赖按钮名称，文案改动会造成大量测试修改；CSS 重构可能带来视觉回归，所以第 2 步先做“外观不变”的迁移。

## 三、Claude 订阅支持

### 政策结论（2026-10-20 已核对官方原文）

| 做法 | 是否允许 | 依据 |
|---|---|---|
| App 自己实现 claude.ai OAuth 登录，或保存 `claude setup-token` 生成的 token | **不允许** | [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)：第三方开发者不得在自己的应用里提供 Claude.ai 登录，也不得收集、存储或中转 Claude.ai 的凭据或 session token，登录必须走 Anthropic 自己的流程。 |
| 用 Agent SDK 加订阅 token 做成产品功能 | **不允许**（除非事先获批） | 同上，以及 [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) |
| **调用用户本机安装、未修改、已经登录的 `claude` CLI（`claude -p`）** | **允许** | Legal 页的例外条款：不妨碍终端用户用自己的订阅登录未修改的 Claude Code 程序。[Support 文章](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)（10/7 更新）原话是 “You can still use … `claude -p`, and third-party apps with your subscription limits”。用量计入用户自己的订阅额度。 |

注意事项：
- Pro/Max 的额度是按“普通的个人使用”设计的。Anthropic 保留在不提前通知的情况下执法的权利。
- **命名**：不能把 “Claude Code” 或 Anthropic 用作自己的功能名，也不能用它们的 logo。可以用纯文字如实说明，例如“使用本机的 Claude Code”。
- 另一条官方路线是 Console 的 API key（10/7 起 Max/Team 订阅包含每月 API credits）。这和项目“免 API key”的定位不符，作为可选的后续项。

### 方案：新增 “Claude（通过本机 Claude Code）” provider

**原则**：Stillnote 永远不读 `~/.claude`、钥匙串或任何 Claude 凭据。登录由用户自己在终端执行 `claude auth login`，走 Anthropic 官方流程。Stillnote 只负责启动这个程序。

1. **Provider 抽象**：新建 `app/providers/`。现有的 `ChatGPT` 类已经有 `load / status / signIn / disconnect / models / respond` 这套接口，原样迁移过去。`main.mjs` 里的 `auth` 改成按设置 `provider` 选择当前 provider。这一步行为不变，现有测试全绿。
2. **`ClaudeCode` provider**（依赖注入 `spawn`、二进制查找、`env`，方便测试）：
   - **找程序**：打包后的 GUI App 拿不到 shell 的 PATH，所以依次查找 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.claude/local`，最后用 `zsh -lc 'command -v claude'` 兜底。Settings 里允许手动填路径。
   - **状态**：调用 `claude auth status --json`，读取 `loggedIn`、`authMethod`、`subscriptionType`（本机实测会返回 `"authMethod":"claude.ai"`、`"subscriptionType":"max"`）。只有 `authMethod` 是 `claude.ai` 时才显示“使用订阅”，否则提示“不是订阅登录，可能按 API 计费”。
   - **调用**：`claude -p --output-format stream-json --verbose --include-partial-messages --model <sonnet|opus|haiku> --tools "" --safe-mode --no-session-persistence --max-turns 1 --system-prompt <instructions>`。
     - prompt 从 stdin 传入（上限 10MB，现有上下文上限 35 万字符，够用）。
     - cwd 设成一个空目录，避免读到项目的 CLAUDE.md。
     - 移除 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_AUTH_TOKEN` 环境变量，防止悄悄走 API 计费。
     - 不能用 `--bare`：bare 模式不读 OAuth，订阅登录会失效。
   - **流式解析**：从 `stream_event` 里的 `text_delta` 取增量文本，最后的 `result` 事件判断成功或失败，沿用现有“完成后才提交”的语义。“Not logged in”和 “session/weekly limit” 映射成友好的提示。取消时 kill 子进程。
   - **模型**：没有非交互的模型列表命令，所以用固定别名 `sonnet`、`opus`、`haiku`。
3. **UI**：Settings 的 AI 区域改成两张 provider 卡片：ChatGPT 是现有流程；Claude 卡片显示检测状态、“在终端登录”按钮（打开终端执行 `claude auth login`）和模型选择。所有 “ChatGPT plan”、“sent to OpenAI” 文案改为按当前 provider 显示。
4. **文档**：更新 README、ARCHITECTURE、隐私说明。

**测试**：
- 单元测试：用一个假的 `claude` 脚本（Node 写的，输出固定的 stream-json），覆盖成功、分包、未登录、额度用尽、中途断开、空结果、非零退出码、取消。
- E2E：扩展现有 test adapter，加入 Claude provider。
- **一次真实冒烟调用**：用你本机的 Claude Code 发一个很短的请求，确认事件格式（会消耗极少量订阅额度），**需要你同意**。

**风险**：
- CLI 参数会随版本变化（例如 `--safe-mode` 比较新）。启动时检测版本或 `--help`，不支持就给出明确提示。
- 每次调用要启动一个进程，有 1–3 秒开销。
- 政策将来可能收紧。provider 抽象让它可以单独关掉，不影响 ChatGPT。

## 四、建议顺序

1. Claude provider（第三部分的 1→4）。范围清楚，可以和下面第 2 步并行。
2. UI 方向稿（第二部分的第 1 步），你选定方向后再做 token、拆组件、逐屏落地。

Settings 的 provider 卡片先做一个最小可用版本，在 UI 重设计时再统一视觉。

## 五、进展（2026-10-20）

已完成，均未提交：

- **UI 按 Granola 重做**：
  - token 化的 `style.css`，包含深色主题。
  - 组件拆分为 Sidebar、NoteView、Dock、TranscriptSheet、ChatPanel、SettingsDialog、AiConnect。
  - P0 的 1–5 项和 P1 的 6–13 项都已处理。
  - 新增 `own-lines.mjs`：生成内容为灰色，自己写过的要点为黑色。
- **Claude provider**：
  - 新增 `app/providers/claude-code.mjs`，只调用本机的 `claude -p`，不读取任何凭据。
  - 自动检测本机的 Claude Code；首次手动使用即记为“已选择”。
  - 一键登录或安装，失败时可退回到 Terminal。
  - Settings 里显示订阅额度用量。
  - 聊天输入框里可以跨 provider 切换模型。
- **测试**：单元 47 个、UI smoke、E2E 4 个场景，外加一次真实的 Claude 调用。

## 六、下一步可改进（按价值排序）

1. **My notes 改成富文本编辑器**：支持 `-` 列表、`#` 标题、粘贴保留格式。Granola 的笔记区是块编辑器，现在是纯 textarea，这是和 Granola 差距最大的一处。
2. **转录与音频联动**：点时间戳跳到对应音频位置，播放时高亮当前句。
3. **会议自动开始**：日历会议开始前 1 分钟弹 macOS 通知，点 “Start now” 新建笔记并直接开始录音（可在设置里关闭）。
4. **模板菜单改成 Granola 式弹出菜单**：每个模板带图标，并有 “Regenerate”，替换现在的原生 select。
5. **⌘K 搜索改为命令面板浮层**，同时能跳转到笔记和执行动作。
6. **聊天历史列表**：Granola 的 Chat 页可以查看过往对话。
7. **首次启动引导**：依次授权麦克风、连接日历、选择 AI，各一步。
8. **Claude 的细节**：Enhance 默认用 Sonnet、聊天默认用 Haiku；周额度超过 90% 时在聊天里提示；不开终端的 `claude auth login` 需要你本人实测一次（会影响你现有的登录，所以没有自动测）。
