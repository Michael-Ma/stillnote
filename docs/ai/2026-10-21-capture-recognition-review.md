# 录音与识别审查（2026-10-21）

结论先说：转录不准主要有三个来源，按影响从大到小：

1. **录到的声音本身就有问题**：默认输入设备是耳机孔麦克风，而且中途换设备会让录音静默中断。
2. **识别引擎太旧**：用的是 `SFSpeechRecognizer`，在这台 Mac 上只有 en-US 能本地识别。
3. **音频被硬切成 10 秒片段**，并且没有标点、没有自定义词汇。

macOS 26 自带的 `SpeechAnalyzer` / `SpeechTranscriber` 能同时解决第 2、3 点，实测效果明显更好。

## 一、证据

### 1. 你已有录音的信号统计

只读了音量和计数，没有读转录内容。

| 段 | 时长 | 麦克风 RMS / 峰值 | 系统音频 | 转录字数 |
|---|---|---|---|---|
| 1–5 | 7–49 秒 | 0.0002 / 0.002–0.02（≈ 静音） | unavailable（当时未授权） | 0 |
| 6 | 20 秒 | 0.0035 / 0.065（只有 3.3 秒有声音） | 在录，但 RMS 一直是 0 | 57 |

当前默认输入设备是 **External Microphone**，也就是耳机孔。插着不带麦克风的有线耳机时，macOS 仍然会选它，录到的就是静音。识别器拿到静音，自然什么也识别不出来。

### 2. 引擎能力（本机实测）

- `SFSpeechRecognizer` 支持本地识别的语言：`en-US`、`en-ID`、`en-PH`、`en-SA`。**en-GB、zh-CN、zh-TW、ja-JP 都不支持。**
  - 选 zh-CN 会直接报“无法本地识别”。
  - 中文会议只能硬选 en-US，结果必然很差。
- `SpeechTranscriber`（macOS 26）支持 30 种语言，包括 zh-CN、zh-TW、zh-HK、粤语、日语、韩语。
  - 本机目前只装了英文模型。其他语言可以在 App 内通过 `AssetInventory` 下载，不用去系统听写设置。
  - 不需要语音识别权限弹窗。

### 3. 准确率实测（合成英文会议语音，35 秒，112 个词）

| 方案 | 干净音频 WER | 低音量加噪声 WER | 速度 |
|---|---|---|---|
| SpeechTranscriber 整段流式 | **2.7%** | **7.1%** | 35 秒音频约 1 秒处理完 |
| 同一引擎、按 10 秒硬切（模拟现在的分段方式） | 3.6% | 9.8% | — |

- 硬切导致丢失的词正好落在切点上，例如第 20 秒处的 “for”、第 30 秒处的 “Sam will”。
- SpeechTranscriber 自带标点、大小写，按句切分，并且每句都有时间戳。
- 旧引擎的错词率没有直接测：从命令行调用旧引擎会触发系统授权弹窗，所以只单独测量了“硬切”这一个因素。

## 二、问题清单（录音与识别）

| # | 严重度 | 位置 | 问题 | 后果 |
|---|---|---|---|---|
| R1 | 高 | `Capture.swift` start/tap | 总是使用系统默认输入，不能选设备，也不检测静音 | 耳机孔 / 虚拟设备 / 静音时整场会议没有转录，而且没有提示 |
| R2 | 高 | `Capture.swift` 无 `AVAudioEngineConfigurationChange` 处理 | 输入硬件的采样率或声道数改变时（例如插拔耳机，或 AirPods 进会议后切到通话模式），AVAudioEngine 会自动停止 | 麦克风静默中断，之后的内容全部丢失 |
| R3 | 高 | `SpeechScheduler.recognizer`、`transcribe` | 用 `SFSpeechRecognizer` + `requiresOnDeviceRecognition` | 本机只有 en-US 可用；中文或混合语言会议必然不准 |
| R4 | 中 | `SpeechChannel.append`（10 秒）、`transcribe`（30 秒） | 固定长度硬切，片段之间没有重叠，也没有上下文 | 切点处丢词；一个片段塞进 10 秒内的多句话 |
| R5 | 中 | `recognizeFile` | 没有 `addsPunctuation`、`contextualStrings`、`taskHint` | 没有标点；人名、术语识别差 |
| R6 | 中 | 麦克风未开启 voice processing | 没有回声消除和降噪 | 用外放时麦克风会录进远端声音，转录重复、混乱 |
| R7 | 低 | `AudioTrack.process` 的 `AVAudioConverter` | 立体声转单声道时没有设 `downmix = true` | 系统音频只保留左声道 |
| R8 | 低 | 实时转录 | 片段要攒满 10 秒才送去识别 | 实时转录延迟 10 秒以上 |
| R9 | 低 | 系统音频 | RMS 全为 0 时没有提示 | 用户以为录到了会议音频，实际没有 |

## 三、改进方案（建议顺序）

1. **先修录音质量**（R1、R2、R9，改动小、收益大）：
   - Settings 里可以选输入设备，并显示当前设备名。
   - 录音开始约 5 秒内检测麦克风或系统音频是否静音，静音就在 dock 上明确提示，并给出“切换到 MacBook 麦克风”的按钮。
   - 监听设备变化，自动重启 engine 继续录，并记一条警告。
2. **换识别引擎**（R3、R4、R5、R8）：
   - macOS 26 及以上用 `SpeechAnalyzer` + `SpeechTranscriber`，流式输入、不再切片，句级片段带时间戳。
   - 语言模型在 App 内一键下载；会议标题、参会人等作为上下文传给识别器（具体 API 待确认）。
   - macOS 13–15 保留旧引擎作为回退，同时补上 `addsPunctuation`、`contextualStrings`，并改为按静音切分、片段之间留重叠。
   - “重新转录”同样走新引擎，整段识别。
3. **音质增强**（R6、R7）：
   - 检测到输出设备是外放时，给麦克风开 voice processing（回声消除和降噪），并把对其他声音的压低降到最小。
   - 系统音频开启 `downmix`。
4. **测试**：
   - 把 `scripts/native-audio-test.mjs` 的通过标准改成 WER 阈值。
   - 增加 10 秒切点、低音量、中文（下载语言模型后）的测试样本。
   - 在 CI 中用合成语音跑 SpeechTranscriber。

## 四、其余代码的问题（存储、IPC、AI、界面）

**看过没问题的部分**：
- SQL 都是参数化查询，FTS 查询词有逐个转义。
- IPC 有发送方校验和 channel 白名单。
- CSP 很严格，Markdown 不渲染原始 HTML。
- 调用 Claude CLI 时禁用了所有工具，开了 safe-mode，prompt 走 stdin。
- OAuth 的 PKCE、state、nonce 校验正确。
- 备份恢复会先校验全部内容再写入。

我抽查确认了标 ✔ 的几条。

| # | 严重度 | 位置 | 问题 | 后果 |
|---|---|---|---|---|
| B1 ✔ | 高 | `store.mjs` `update()` | summary 只要有变化就往 `versions` 压一条，Enhanced 编辑时每次自动保存都算 | 改二十几次之后，原始 AI 摘要就被挤出历史记录 |
| B2 ✔ | 中 | `store.mjs` context、`ui.jsx` ask | “All my notes” 聊天把所有会议都塞进上下文，超过 35 万字符直接报错 | 笔记一多，全局聊天就不能用了 |
| B3 | 中 | `ui.jsx` 加载分支 | `state` 加载失败时一直停在 “Opening your notebook…” | 没有错误信息，也没有重试 |
| B4 ✔ | 中 | `main.mjs` close | 关窗口要等界面回复 `finish-close`，没有超时 | 界面卡住或保存失败时，窗口关不掉 |
| B5 ✔ | 中 | `claude-code.mjs` `respond()` | 只在开头检查取消，之后 `refresh`/`locate` 期间按 Stop 会被漏掉 | Claude 进程照样跑完，消耗额度并阻塞后续请求 |
| B6 | 低 | `ui.jsx` cleanError | 取消或超时时显示原始的 “AbortError: …” | 错误提示难看 |
| B7 | 低 | `ui.jsx` enhance/ask | `busyRef` 在 `await` 之后才设置 | 双击会发出两次请求，并清掉第一次的流式文字 |
| B8 | 低 | `ui.jsx` ask | 回答返回时不检查当前 scope | 切换笔记后，回答会出现在错误的对话里 |
| B9 | 低 | `ui.jsx` auto-enhance | 自动 Enhance 会把正在别的笔记里打字的人切走 | 打断输入 |
| B10 | 低 | `main.mjs` import | 导入超过 200 万字符的文本时，先建了笔记再报错 | 留下一条空笔记 |
| B11 | 低 | `store.mjs` backup/restore | 备份包含 `claudePath`/`provider`，恢复时会写回 | 来路不明的备份可以指定要执行的程序路径 |
| B12 | 低 | `ui.jsx` dialog | 从文本框拖选到背景外松开鼠标，会关掉弹窗 | 粘贴的转录内容丢失 |

**值得做的性能和体验改进**：
- FTS 删除按 UNINDEXED 的 id 列，每次写入都要全表扫描。
- 每收到一个转录片段，都把整条会议发给界面；启动时会一次性加载全部转录。
- 每次 AI 请求都会重新拉一遍模型列表。
- ChatGPT 遇到 401 时不会刷新 token 再重试。
- 没装 Claude 时，每次窗口获得焦点都会启动一次 login shell 去找它。

## 五、建议的实施顺序

1. **录音可靠性 + 高中危 bug**：R1、R2、R9、B1、B3、B4、B5。改动集中，能立刻减少“没录上 / 丢内容”。
2. **换识别引擎**：R3、R4、R5、R8，加上语言模型下载和新引擎的“重新转录”。这是准确率提升最大的一步。
3. **音质和其余问题**：R6、R7、B2、B6–B12，以及上面的性能改进。
