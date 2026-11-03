# 声学回声消除（AEC）设计

2026-11-02 定稿，已获批准。效果实测见 `docs/ai/echo-accuracy.md`。

## 目标

外放开会时，麦克风会录到扬声器里对方的声音。以前等识别出文字后再按文字删（`app/echo.mjs`、`app/echo-audio.mjs`），中文只去掉约 40%。

现在在识别之前，用会议音频（system 轨）作参考，从麦克风信号里减掉扬声器的声音。文字和音频过滤继续保留，作兜底。

## 选型：WebRTC AEC3

| | WebRTC AEC3 | SpeexDSP（MDF） | Apple Voice Processing |
| --- | --- | --- | --- |
| 延迟 | 自己估计并跟踪 | 不估计，参考必须事先对齐 | 系统内部处理 |
| 外放失真、混响 | 线性滤波加非线性残余抑制 | 弱 | 好 |
| 别的 App 的声音 | 参考是我们喂的系统混音，一定覆盖 | 同左 | 没验证过；这台 Mac 上启动失败（-10875） |
| 存盘和重试 | 能在两条 WAV 上离线重跑 | 同左 | 只能实时 |
| 许可证 | BSD-3-Clause 加 WebRTC PATENTS；abseil-cpp 为 Apache-2.0 | BSD-3-Clause | 系统框架 |

**来源：**

- **webrtc-audio-processing 2.1**：freedesktop 的独立提取版。tarball 的 SHA-256 为 `ae9302824b2038d394f10213cab05312c564a038434269f11dbf68f511f9f9fe`，和官方 `.sha256sum` 一致。
- **abseil-cpp 20240722.0**：2.1 的 meson wrap 指定的版本。SHA-256 为 `f50e5ac311a81382da7fa75b97310e4b9006474f9560ac46f54a9967f07d4ae3`，和 wrap 里写的一致。

**Apple Voice Processing 删除。** 设置里旧的 `on` 值保留兼容，含义等同 `auto`。

## 构建

- **源码子集**放在 `native/vendor/webrtc-audio-processing/` 和 `native/vendor/abseil-cpp/`，只留编 AEC3 必需的文件，附上游 LICENSE、PATENTS 和 `native/vendor/README.md`（版本、URL、SHA-256、怎么重新生成）。
- **重新生成**：`scripts/vendor-aec.mjs` 下载两个 tarball，校验 SHA-256，按固定清单复制子集。
- **C 包装**：`native/aec/stillnote_aec.h` 和 `native/aec/stillnote_aec.cc`，`extern "C"`。Swift 用 `-import-objc-header native/aec/stillnote_aec.h` 调用。
- **编译**：`scripts/build.mjs` 用 `clang++ -std=c++17 -O2 -DNDEBUG` 和 2.1 meson 用的宏（`WEBRTC_POSIX`、`WEBRTC_MAC`、`WEBRTC_APM_DEBUG_DUMP=0` 等）并行编到 `native/bin/aec/`。目标和 swiftc 一样，是当前架构的 macOS 13.0。
  - 已有的 `.o` 比源文件和编译参数都新就跳过。
  - `libtool -static` 打成 `native/bin/libstillnote_aec.a`，swiftc 链接它并加 `-lc++`。
  - arm64 定义 `WEBRTC_HAS_NEON`。x86_64 只编 SSE2，不编 AVX2。
  - 不新增构建工具，CI 不改。
- **许可证**写进 `docs/LICENSING.md`，第三方 LICENSE 文件加进打包的 `extraResources`。

## 对齐和处理

对齐和处理都在 C++ 包装里，实时录音和离线重跑共用同一份代码。

### 接口

```c
typedef struct StillnoteAEC StillnoteAEC;
StillnoteAEC *stillnote_aec_create(int linear_only);       // 16 kHz 单声道
void stillnote_aec_destroy(StillnoteAEC *);
void stillnote_aec_reference(StillnoteAEC *, const float *samples, int count, int64_t index);
void stillnote_aec_capture(StillnoteAEC *, const float *samples, int count, int64_t index);
int  stillnote_aec_pull(StillnoteAEC *, float *out, int capacity, int64_t *index); // 返回样本数
void stillnote_aec_flush(StillnoteAEC *);   // 积压的麦克风全部处理，缺的参考当静音
void stillnote_aec_reset(StillnoteAEC *);   // 先 flush，再换一个全新的 AEC3 实例
void stillnote_aec_stats(StillnoteAEC *, StillnoteAECStats *);
```

### 时间线

`index` 是**时间线样本号**：`round(startOffset * 16000) + writer.frames`，也就是 `AudioTrack.save()` 里 `offset` 乘以 16000。两条轨共用同一个 `start`。只按 index 处理，不按到达顺序，所以实时和离线的结果一致。

### 前瞻

前瞻 D = 250 ms（4000 个样本）。处理 index 为 t 的一个 10 ms 麦克风帧（160 个样本）之前，先把参考信号按 10 ms 帧喂到 t + D：先 `ProcessReverseStream`，再 `ProcessStream`。

这样做是因为 system 轨的起点偏晚：它用的是主线程收到时的 `Date()`。回声在时间线上可能比参考还早，前瞻能让它落回因果范围内。

AEC3 的延迟搜索范围要覆盖 D 加外放延迟（蓝牙音箱可达 300 ms），目标 ≥ 700 ms。不够就调大 `EchoCanceller3Config.delay.num_filters`。

### 缺口和超时

- **参考的缺口**：index 跳过的部分当静音。
- **迟到的参考**：已经处理过的部分，丢掉。
- **超时**：麦克风积压超过 500 ms（8000 个样本）还等不到对应的参考，就按静音参考处理，不再等。
- **麦克风 index 不连续**：先 flush，再从新的 index 接着处理。

### APM 配置

- 打开：`echo_canceller`（mobile_mode = false）、`high_pass_filter`。
- 关闭：降噪、AGC1、AGC2、瞬态抑制。不改变给识别器的人声。
- 用 `AudioProcessingBuilder().SetEchoControlFactory(EchoCanceller3Factory(config))` 传入自定义配置。

### 只用线性输出

`linear_only = 1` 时打开 `export_linear_aec_output`，输出改用 `GetLinearAecOutput`，不经过非线性抑制。这个开关是给评估比较双方同时说话时的人声损失用的。

**实测后默认用完整输出。** 真实扬声器下，线性输出的残余仍被识别出 75–93 个英文词（共 101 个），完整输出是 0。线性只能用在评估里：`transcribe` 的 `echoCancellation: "linear"`、`--aec-file --linear`、`echo-eval.mjs --aec linear`。数字见 `docs/ai/echo-accuracy.md`。

### 统计

统计只有数字：

- 处理的样本数
- 参考缺失的样本数
- 当前估计延迟（ms）
- ERLE 平均值（`GetStatistics`）
- 重置次数
- 处理耗时（线程 CPU 秒）

## 接进 helper（`native/Capture.swift`）

- **`EchoCanceller`**：Swift 小类，包住 C 句柄，`@MainActor`。`deinit` 里销毁。
- **`AudioTrack`**：加一个可选的 `echo` 引用和角色。
  - system 轨在 `save()` 里把写盘的同一块交给 `reference`。
  - 麦克风轨把原始块交给 `capture`，再 `pull` 出处理过的块，依次走 `speech?.append(processed, offset: index / 16000)` 和 `preRoll`。
  - WAV、音量、静音检测都还用原始信号。
- **`pad(to:)`**：开头先调 `echo.reset()`，让积压的音频按顺序进识别器，再补静音、`speech?.skip`。重启和配置变化都会经过这里，回声路径换了就重新收敛。
- **`Capture.start`**：设置不是 `off` 且 system 轨真的开始录了，才把两条轨配对。配对用一个小函数，以后 `streamedRecognition` 加一行就能用上。不碰 `streamedRecognition`，另一个会话正在改它。
- **`started` 事件**：`echoCancellation` 报告 AEC 是否生效。
- **`stop()`**：所有轨 `closeAudio` 之后、`speech.finish()` 之前，先 `flush` 再 `pull` 完，样本数一个不少。
- **统计**：放进 `sourceStats.microphone.aec`。
- **删除** Voice Processing 的代码路径，包括 `allowVoiceProcessing` 和静音 mixer 的连接。

## 存盘和重试

- **`microphone.wav` 存原始麦克风，不存处理后的。**
  - 两条 WAV 都在，处理可以重来，也可以关掉。
  - `echoJudge` 的阈值是在原始回声上调的，继续读原始 WAV 才成立。
  - 双方同时说话时，就算 AEC 压掉了人声，原始录音里还在。
- **`transcribe` 操作**新增 `echoCancellation`，默认 `auto`。两条轨都在且不是 `off` 时：
  - 先离线处理：读 microphone.wav 和 system.wav，按各自的 `startOffset` 换成 index，参考按块喂到前面。
  - 结果写到临时目录里一个 0700 的子目录，文件名带 UUID。识别时用它代替麦克风轨，结束后在 `defer` 里删掉。
  - 麦克风里连续 ≥ 0.1 s 的精确 0，是补的静音，在那里 `reset`，和实时一样。
  - 新、旧两种识别路径都适用。
- **`main.mjs`** 的 `transcribe-recording` 传当前设置。
- **`echoJudge` 不改。**

## 命令行（评估用）

```
StillnoteCapture --aec-file <microphone.wav> --reference <system.wav>
  [--mic-offset s] [--reference-offset s] [--out processed.wav] [--linear] [--no-reset]
```

输出一行 JSON：统计，加上每秒一组 `[秒, 麦克风 dB, 输出 dB, 参考 dB]`。只有数字。

## 设置和界面

- **取值**：`auto`（默认）= 有会议音频就开；`off` = 关；`on` 等同 `auto`。`store.mjs` 的校验不变。
- **界面**：选项改为"开 / 关"，`off` 显示关，其他都显示开。说明改为"识别前去掉扬声器放出的会议声音；保存的录音保持原样。戴耳机仍然最干净。"
- **翻译**：所有语言都补上。

## 评估

- **`echo-eval.mjs --aec on|off`**：传给 `transcribe` 操作。
- **`scripts/aec-eval.mjs`**：只输出数字，文字只留在内存里，临时 WAV 放在 0700 目录、用完即删。
  - **双方同时说话**：在外放很响的录音里取纯回声片段（会议音频在播放，麦克风紧跟它），混入同一个人只自己说话时的声音（会议音频静音时）。分两档：正常音量，和低 8 dB。
    - 比较：人声单独识别、混合后不处理、AEC 完整输出、只用线性输出。
    - 统计：人声的词保留比例、回声词、人声能量保留。
  - **切换设备收敛**：录音里补静音的位置（精确 0）之后，ERLE 随时间的变化。
  - **CPU**：每秒音频的处理耗时。

## 自测（`--self-test`，CI 也跑）

合成测试信号：远端是类语音噪声，经指数衰减的房间冲激响应、120 ms 延迟和 tanh 失真，进入麦克风；中间插入一段近端信号。

- 只有回声时，2 秒后 ERLE ≥ 20 dB。
- 双方同时说话时，近端信号保留：能量差 ≤ 3 dB，相关 ≥ 0.9。
- 无参考时直通：能量差 ≤ 0.5 dB。
- 参考在时间线上晚 100 ms，仍能消掉。
- 参考缺失超时后继续处理，不卡住。
- reset 后 2 秒内重新收敛。
- 样本数守恒，index 连续。

## 风险

- **构建**：源码多几 MB，CI 首次编译多 1–2 分钟。
- **对齐**：SCK 断流时 system 时间线会被压缩，两个时钟也会漂移。靠 AEC3 的延迟跟踪兜底。超出范围时只是没消掉，文字过滤仍在。
- **双方同时说话**：残余抑制可能压掉用户的词，用双讲混合测试把关。
- **实时延迟**：麦克风文字晚约 0.25–0.5 秒出现。
- **重试结果变化**：重试旧会议会用上 AEC，结果和之前不同。
