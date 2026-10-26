# Validation

## Current review — October 26, 2026

Reviewed latest main `06f81f9` (floating reminder panels, meeting-end detection/trimming, and single-language retry errors), following the merge of [PR #1](https://github.com/Michael-Ma/stillnote/pull/1). This follow-up fixes a reproduced trim failure and updates the maintained documentation and demo.

| Check | Observed result |
| --- | --- |
| Unit and IPC suite | `npm test`: **203 passed**, including four new trim rollback/recovery cases. |
| Build and formatting | `npm run build`, `npm run format:check`, and `git diff --check` passed. Build used macOS SDK 27; existing Lucide `use client` bundler warnings remain. |
| Desktop E2E | **All eight passed:** language, reminders, calls, meeting-end, recovery, notebook, capture, AI. The final run used the real renderer, panels, main/preload, SQLite and playback paths with synthetic device/provider transports. |
| Native lifecycle | **19 checks passed**, without live audio or speech recognition. |
| Native capture invariants | **12 checks passed**, including canonical WAV output, gap padding, signal events and calendar colors. |
| Native scheduler | Passed serial concurrency, cancellation/backlog checks and **five silence-boundary checks**. |
| New demo | `npm run demo` completed in the separate demo worktree. The final H.264 MP4 is **43.21 seconds, 1280 × 880, 900,950 bytes**. Sampled frames were inspected and a complete `ffmpeg` decode reported no errors. |

The original trim path shortened the microphone WAV before trying to open the system WAV. With a read-only second track, it raised `EACCES` and left 30 seconds of microphone audio beside 100 seconds of system audio. The fix stages every shortened track, retains originals until all replacements commit, and rolls back or recovers an interrupted replacement. Tests verify byte-for-byte restoration after a second-track rename failure, rejection of an unsupported second track, and incomplete/committed journal recovery. Successful trimming retains its existing heuristic and can still remove brief untranscribed sounds; Off preserves the full captured files.

The first E2E run also exposed a cross-renderer assertion race: the editor had cleared its meeting-end prompt before the panel rendered its own clearing event. The test now waits for both. The final eight-suite run passed.

The demo uses fictional notes and synthetic audio, recognition, calendar and AI. Meeting-end waits are compressed; floating panels are real screenshots composited into the screencast, with an illustrative countdown. Neither the video nor the deterministic tests establish live transcription accuracy, real provider access, or native placement across displays/full-screen apps/Spaces. No personal notebook, live microphone/system audio, real calendar, account inference, language download, signing or installation was exercised in this review. See [TESTING.md](TESTING.md) for repeatable commands.

## Historical October 20 validation

The results below describe the earlier implementation on an Apple Silicon Mac. In particular, the serial legacy recognition results do not certify the later SpeechTranscriber/Auto-language path.

## Executed

| Area | Result and evidence |
| --- | --- |
| Storage and search | Passed persistence across database reopen, folder assignment, transcript correction, indexed search, CJK substring search, Trash exclusion, and restore checks. |
| Revision safety | Passed separate rough-note preservation and prior-summary retention checks. |
| Backup and restore | Passed round-trip meeting/message/source/template restore, duplicate prevention, and invalid-import rejection before mutation. |
| AI context and streaming | Passed bounded-context rejection, fragmented/CRLF SSE decoding, and rejection of failed, empty, or incomplete responses. |
| OAuth | Passed synthetic PKCE callback flow, invalid state/nonce/audience/subject rejection, issued-client reuse after exchange failure, plan-scope enforcement, and serialized/checkpointed refresh. No real account was used. |
| Unit suite | `npm test`: 26 tests passed. |
| Real desktop UI | `npm run test:ui`: creation, editing/autosave, transcript entry, folder assignment, star, search, Trash/restore, Markdown export, settings/Escape, disconnected-account recovery, immediate-close saving, and compact layout passed. No renderer errors were observed. |
| Visual inspection | Rendered and inspected Home, editor, chat, settings, and a 1024×768 layout. Documentation images show fictional fixtures at 1280×860. The Home screenshot's calendar events are test fixtures, not a connected user calendar. |
| Recording media | Passed canonical WAV validation, stale-header recovery, safe track resolution, byte-range/HEAD behavior, cancellation, sparse coverage, session-specific retry preservation, and backup/model-context exclusion. |
| Reusable E2E | Four suites passed: notebook, capture/playback, AI failure/retry, and interrupted-session recovery. Real renderer/IPC/SQLite/media paths; device/provider transports use synthetic fixtures. |
| Native audio writer | Actual 22.024-second and 66.502-second synthesized speech inputs were preserved as non-silent 16 kHz mono PCM WAV files with matching durations and sample counts. A separate 48 kHz stereo case also passed downmix/resampling with matching duration. These writer checks validate normalization/storage, not speech accuracy. |
| Native recognition | Actual on-device saved-file transcription passed a 66.502-second synthetic fixture. The earlier 0.2 single-source live test also passed, but missed the dual-source failure. Current live recognition results are in the dual-source regression below; the earlier 6.9% WER result is not certification of the current meeting path. |
| Dual-source regression | The old design produced zero transcript segments and 44 recognition errors on each source in a 22.024-second synthetic test. The serial scheduler passed 22.024-second and 66.502-second dual-source tests. In the long test, each source produced 164 words for 159 reference words, 8.8% WER, and zero recognition errors/timeouts. These are per-source synthetic results, not real-meeting accuracy guarantees. |
| Native scheduler | Production queue with a substituted worker passed serial concurrency, FIFO, backlog, pending/active cancellation, and continuation checks without speech/device access. |
| Native helper | Swift compilation succeeded. `--self-test` returned ready and enumerated 63 recognizer locales. Locale enumeration does not establish that all of them are installed for on-device recognition. |
| App bundle | macOS arm64 packaging and ad-hoc signature verification succeeded. `npm run test:package` launched the packaged app, saved a note through its real preload/IPC/store path, and started the bundled helper in self-test mode. |
| Runtime dependencies | `npm audit --omit=dev` reported zero vulnerabilities at the time checked. This is a package audit result, not a security certification. |

Desktop tests use separate `.test-data-*` directories. The import/export tests stub the native file pickers while exercising the real export handler and verifying the written Markdown. Documentation screenshots populate an isolated presentation fixture. Neither is a production demo mode.

## Still requires an acceptance test

- Complete **Continue with ChatGPT** with an eligible account; discover a model; finish an enhancement and a cited chat response.
- Grant microphone and speech permissions, confirm the on-device language is installed, and transcribe actual speech.
- Grant system-audio permission and verify both sides of a meeting using the packaged app. Check headphone/speaker echo and relative input levels.
- Record a longer meeting across recognizer task rotations and check gaps, repeated words, pauses, overlapping speakers, and device changes.
- Grant EventKit access and compare upcoming events with Apple Calendar. Check the floating reminder without stealing focus, including another display, full-screen calls and macOS Spaces.
- Verify meeting-end prompts against real call/mute/permission behavior and long pauses. Use Off when capturing acceptance reference audio; separately evaluate which tails the trimming heuristic removes.
- Exercise the app on Intel and older supported macOS versions. Compilation targets macOS 13, but those combinations have not been separately run.

The app should not be described as full Granola parity or a production-validated transcription system. It implements the requested local core; live service access, OS permission behavior, and transcription quality remain subject to the acceptance checks above.

## Design observations

The home feed and editor now follow the observed Granola hierarchy: narrow sidebar, upcoming-events card, chronological rows, serif title, compact metadata, quiet writing surface, and bottom chat/recording controls. A larger illustrated welcome screen and the first three-pane collection layout were removed. UI-only confirmations were replaced with actual state changes or written export files. Previous summaries and transcripts remain available when AI fails.

No claim of accessibility certification or user research is made. The executed layout and keyboard checks are listed above.
