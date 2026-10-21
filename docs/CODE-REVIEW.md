# Capture/transcription follow-up review

Reviewed October 20, 2026. Scope: the native capture and recognition lifecycle, session routing in the Electron main process, stored recording/retry boundaries, and whether the acceptance tests exercised the real two-source meeting path.

The earlier work included integration review, unit/E2E checks, and a single-source synthetic speech test. That was insufficient: the single-source test did not exercise microphone and system recognition simultaneously. A passing summary or UI test was not evidence that this path worked.

## Findings and corrections

| Finding | Evidence | Correction |
| --- | --- | --- |
| **P1: two live recognition tasks repeatedly interfered in the tested app/environment** | A 22.024-second prerecorded fixture was fed to both production source channels. Both retained valid, non-silent audio, but each reported 44 recognition errors and the combined result had zero segments. The earlier single-source fixture passed. | Continuous capture and raw WAV persistence remain per-source. A single shared `SpeechScheduler` now performs on-device inference serially on roughly 10-second chunks. The queue is bounded, reports recognition backlog, and supports cancellation without dropping the raw recording. |
| **P2: system callbacks were routed by the current session instead of their originating stream** | Static review found that a delayed output/error callback could access the current `tracks["system"]` or label an error with the new recording ID. | Hold the active stream before starting it; accept callbacks only when the originating stream matches it. Stale stream errors/data are ignored. |
| **P2: final audio delivery relied on a fixed 50 ms sleep** | Static review found no guarantee that all already-copied buffers had reached the main actor before WAV finalization. | Stop the sources, drain the serial source callback queue and pending copied-buffer group, then close the WAV files. No guessed sleep determines completion. |
| **P2: helper-only audio exclusion did not exclude the host app's player** | The native helper is a separate process from the Electron audio player. Excluding only its own process does not identify the host. | ScreenCaptureKit also excludes the parent/Stillnote application, so playing a saved note does not intentionally feed that app's output back into system capture. |

The concurrency finding is an observed failure of this implementation on this Mac, not a claim that Apple documents a universal prohibition on every form of concurrent recognition. The remediation removes the conflicting requests from this app's design. Apple's API documentation establishes that recognition is asynchronous and that callers manage task finalization/cancellation: [SFSpeechRecognizer](https://developer.apple.com/documentation/Speech/SFSpeechRecognizer).

## Controlled before/after results

The test supplies synthesized speech directly to the production audio/recognition channels, without opening a live microphone or system-audio device. The same reference is supplied to each source, so each is evaluated independently.

| Case | Duration | Microphone | System audio |
| --- | --- | --- | --- |
| Previous concurrent live-task design | 22.024 s | No text; 44 recognition errors | No text; 44 recognition errors |
| Serial scheduler | 22.024 s | 54 words for 53 reference words; 9.4% WER | 54 words for 53 reference words; 9.4% WER |
| Serial scheduler, longer test | 66.502 s | 164 words for 159 reference words; 8.8% WER; zero recognition errors/timeouts | 164 words for 159 reference words; 8.8% WER; zero recognition errors/timeouts |

WER uses lowercase/punctuation-normalized token Levenshtein distance; brand spellings and word boundaries are not silently corrected. Counts can exceed the reference when the recognizer splits words. This small fixture establishes regression coverage, not a general accuracy benchmark.

The deterministic scheduler self-test additionally verifies one active recognition worker, FIFO progress, bounded backlog, pending/active cancellation, no duplicate completion, and subsequent job progress. It runs in CI without granting speech or device access.

## Remaining evidence boundaries

- The historical failed meeting has no retained audio. This reproduced recognition failure is a concrete plausible explanation, but the exact contribution of language, input routing, noise, or task lifecycle in that original meeting cannot be reconstructed.
- Live physical microphone/system routing, device changes, screen-capture failures, echo, overlapping speakers, mixed languages, and long meetings still require real-device acceptance checks. A synthetic dual-source test does not establish those outcomes.
- Saved audio is normalized 16 kHz mono PCM captured before recognition, not a bit-perfect copy of the original hardware format.
- Transcription now updates in roughly 10-second batches. Slower devices may queue work; raw audio remains available for review/retry if recognition falls behind.
- The late-callback and drain corrections are supported by code review, compilation, and integration checks; physical ScreenCaptureKit failure/restart transitions have not been exhaustively fault-injected.

The selected Conversation Fold icon is also applied in this update; it is independent of these audio fixes.
