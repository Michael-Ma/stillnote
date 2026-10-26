# Diagnosing incomplete transcripts

A summary such as “only brief, disconnected fragments” can accurately describe the text received by the model while still indicating a broken or poorly configured capture/recognition path. Empty rough notes are valid: the transcript alone should be enough when it contains the conversation.

Stillnote adds observable checkpoints between audio input, recognition, persistence, and enhancement. It does not use the quality of an AI summary as proof that audio capture succeeded.

See [architecture](ARCHITECTURE.md) for the native/main/renderer boundaries and [testing](TESTING.md) for repeatable regression checks.

## What changed

- Microphone and system audio are written independently of recognition, before speech models finish preparing. Recognition permission or language availability can fail without discarding captured audio.
- Each source is normalized to 16 kHz mono PCM. Those same normalized samples are written to WAV and supplied to live recognition.
- WAV headers are checkpointed every second and finalized on stop. Interrupted sessions are detected on restart, and canonical WAV headers can be repaired from actual sample bytes.
- macOS 26+ uses a continuous `SpeechAnalyzer` / `SpeechTranscriber` stream for each source/language candidate (two candidates per source in Auto). The normalized audio is converted to the analyzer's preferred format only when necessary. Volatile results become `partial` events; finalized phrases become `segment` events with stable IDs and recording-relative phrase timestamps. No fixed recognition windows are used. Meeting vocabulary hints are supplied through `AnalysisContext`.
- macOS 13–25 retains the shared serial `SFSpeechRecognizer` scheduler (24 queued jobs). It cuts after at least 8 seconds when a 300 ms quiet run occurs, with a 15-second hard cap. Requests enable punctuation, dictation mode, and contextual strings. The earlier concurrent **legacy** recognizers interfered; that finding does not establish whether concurrent modern analyzers interfere.
- Modern recognition does not request Speech Recognition authorization. Missing language assets produce a warning directing the user to download the language in Settings; audio continues. `languages` reports supported/installed locales, and `install-language` uses `AssetInventory` with progress limited to four events per second. Legacy language installation points to macOS Dictation settings.
- `devices` enumerates CoreAudio input UIDs, names, default status, and transport. `start.inputDevice` selects the input before installing the tap; a missing UID falls back to the default with a warning. `started.sources.microphone.device` identifies the selected input.
- Microphone configuration changes trigger engine/tap recreation. A watchdog also checks for a stopped engine or missing callbacks and retries failed restarts every two seconds. Gaps are padded with silence using the new buffer's capture time, preserving the recording timeline. Successful restarts emit `device-changed` and a warning; failed restarts report an unavailable microphone visibly while retrying.
- Each source emits `source-silent` after six seconds below peak 0.003 (including absent buffers), once until signal returns. `source-signal` rearms the warning. This measures signal, not whether speech is intelligible.
- Echo cancellation is opt-in (`on`); `off` and the older `auto` value capture normally. On this MacBook Pro (macOS 26.6), AVAudioEngine voice processing failed to start (`-10875`) and its teardown could reset the input mid-recording, so it never runs unless chosen. When `on` fails, the helper warns once and falls back to ordinary capture. `started` reports the actual Boolean and recognition engine.
- AVAudioEngine also posts configuration changes for benign reasons, including its own start. The helper restarts the input only when the device or format really changed (or the engine stopped), announces only a new device, and stops rebuilding after three restarts in ten seconds.
- Stereo normalization explicitly downmixes both channels and uses maximum sample-rate-converter quality.
- Finishing drains copied audio callbacks and converter tails, then closes analyzer input and finalizes through its end. Modern finalization waits at most 30 seconds and preserves the latest volatile phrases as `partial: true` segments on failure or timeout. Cancellation of a stalled Speech service is not awaited beyond that deadline. The reported recording duration excludes this wait.
- Per-source input meters show captured signal, not recognition accuracy. Microphone and system-audio availability are tracked separately.
- A sparse-transcript heuristic flags cases such as a roughly one-minute recording yielding only a few dozen characters. It is a diagnostic prompt, not a claim that speech definitely occurred throughout the recording.
- Automatic enhancement is skipped when coverage is sparse and there are no substantial rough notes. The recording and transcript remain inspectable.

Version 0.1 discarded audio. Its historical audio cannot be recovered, and the exact cause of missing speech cannot be established from saved transcript fragments alone. Possible causes include input availability, recognition configuration/language, or recognition lifecycle behavior. The new artifacts allow these to be distinguished.

## How to test a meeting

1. Confirm the **Meeting language** in Settings matches the speech you intend to record and its assets are installed. Select the intended input device; an unused headset jack can remain the macOS default and record silence.
2. Start a short meeting. Check the microphone and system-audio source states and input meters. A moving meter establishes signal, not intelligible speech.
3. Finish the recording and open **Recordings**. Listen to each source separately; seek to the parts corresponding to missing transcript text.
4. If the audio is missing or silent, investigate device routing and macOS permissions before retrying recognition.
5. If the audio is clear but the transcript is sparse, confirm the language and on-device language installation, then choose **Retry transcription**.
6. On macOS 26+, retry analyzes each whole saved track with contextual hints and phrase timestamps; progress `completed`/`total` is measured in audio seconds. Older macOS retains on-device file requests in bounded chunks. It replaces only that recording session's transcript after successful nonempty completion, preserving other sessions, manual transcript text, and a prior transcript version. Failure or empty recognition preserves the previous transcript.
7. Review the recovered transcript before enhancing notes again. Retry does not automatically regenerate or overwrite your reviewed summary.

Headphones help separate your microphone from another app's playback. Voice processing can reduce speaker echo but its actual effectiveness still needs testing on the selected hardware. The app labels input sources, not individual remote speakers.

## Storage and privacy

Audio files are local PCM WAVs under the app's data directory, `recordings/<meeting-id>/<session-id>/microphone.wav` and `system.wav`. They are retained for playback and debugging and never included in model context or uploaded to OpenAI or Anthropic. With meeting-end handling enabled, a completed recording can have its trailing audio shortened; see the trimming details below. The local media protocol only resolves known recording tracks and supports byte ranges for seeking; it does not expose arbitrary filesystem paths or run a network server.

JSON backups disclose `audioIncluded: false`. They include notebook notes and chats but exclude raw audio and prior transcript-version rows. Imports cannot claim access to existing local recording files. Copy the whole data folder separately if audio preservation is required.

## Reusable evidence

See [TESTING.md](TESTING.md) for deterministic desktop E2E suites, the native audio writer test, and opt-in on-device recognition. The default native test uses synthesized speech; `--long` uses a 60+ second fixture. On macOS 26+, `--recognize` launches the helper directly; it needs no legacy Speech authorization. On older macOS it retains the dedicated test app and its Speech usage description. `--streamed` exercises the production stream with realtime PCM pacing; `--streamed --dual-source` feeds the same fixture to two concurrent production channels. Acceptance requires WER ≤15% **for each source**, with keyword recall and word-count ratios retained only as diagnostics. WER is lowercase English token Levenshtein distance divided by reference word count. Streaming tests also reject recognition errors/timeouts, duplicate finalized IDs, and out-of-range phrase timestamps.

```sh
npm run build
native/bin/StillnoteCapture --self-test
native/bin/StillnoteCapture --scheduler-self-test
native/bin/StillnoteCapture --capture-self-test
npm run test:native-lifecycle
node scripts/native-audio-test.mjs --recognize
node scripts/native-audio-test.mjs --recognize --streamed
node scripts/native-audio-test.mjs --recognize --streamed --dual-source
node scripts/native-audio-test.mjs --long --recognize --streamed --dual-source
```

The scheduler self-test passes with maximum concurrency 1, 13 successful jobs, 13 cancellations, a 24-job backlog bound, and 5 silence-boundary checks, without speech or hardware access. As rechecked on October 26, 2026, the capture self-test passes 12 checks for silence/recovery notifications, gap padding and calendar color conversion using the production WAV writer (20,000 padded frames; 228,000 total frames). The audio acceptance script runs those capture invariants before generating speech. The separate native lifecycle self-test passes 19 checks for delayed/cancelled model setup, candidate fallback and single-language failure detail. These counts describe the current helper; the October 21 observations below are historical.

## Verification in the restricted worktree (2026-10-21)

The macOS 13-target build succeeds against Xcode SDK 27. Runtime Speech and hardware acceptance are **not established** in this sandbox: `say` exits successfully but produces zero audio frames, CoreAudio returns no inputs, and SpeechTranscriber returns no supported/installed locales. This differs from the unsandboxed measurements in the review. Do not interpret the sandbox's empty lists as this Mac's language or device inventory.

Actual JSON responses to stdin operations here:

```json
{"type":"devices","inputs":[]}
{"type":"languages","engine":"speechTranscriber","supported":[],"installed":[]}
```

Whole-file, streamed, and dual-source transcription must be rerun outside this sandbox; no WER or successful concurrent-analyzer result can be claimed here. The implementation uses independent modern analyzers; whether they interfere remains a required release acceptance check. If the dual-source test fails while single-source passes, do not infer that the legacy scheduler test proves modern concurrency safe.

Generated non-speech PCM does work here: a 3-second 16 kHz mono tone and a 3-second 48 kHz stereo tone with signal **only on the right** each normalize to 48,000 mono frames / 96,044 WAV bytes. RMS is approximately 0.21579 and 0.10790 respectively, confirming the right channel survives downmix. These checks establish conversion and WAV integrity, not recognition quality.

Live microphone/device selection, unplug/replug recovery, echo cancellation effectiveness, system audio, asset downloading, and older-macOS execution still require a normal app session. The unit suite in this sandbox passes 45/47 tests; the two OAuth tests fail because binding `127.0.0.1` is denied (`listen EPERM`).

![Recording playback controls using fictional E2E fixtures](images/recordings.png)

## Meeting-end prompts and trimmed audio

The end detector combines transcript activity, sustained sound, other apps' microphone use, and the calendar event's end. The exact thresholds and settings are in the [README](../README.md#meetings-reminders-and-stopping). If it prompts too soon, choose Keep recording; Off disables prompting and preserves the full captured WAVs. “Only ask” still permits trimming when you stop manually.

A successfully removed tail is absent from the saved audio and cannot be restored by Retry. Trimming keeps ten seconds after the last transcript or sustained-sound endpoint and removes at least 60 seconds; very brief untranscribed sounds can be classified as silence. For a capture-quality investigation, turn meeting-end handling Off before recording so the comparison uses every captured sample.

Trims now prepare all shortened tracks before replacing originals. A failed replacement rolls back the affected files, and startup repairs an interrupted trim journal before measuring recovered durations. A read-only second source must leave the first source unchanged. Inspect `diagnostics.trailingSilenceRemoved` and the stop notice to distinguish a deliberate successful trim from an interrupted capture.
