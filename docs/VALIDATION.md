# Validation

## October 25 repository review

Revision `0b6568bd095562584ebd0c60e9f6b972cec7e38a`, reviewed in an isolated worktree. `npm test` passed **164 tests**, the native/renderer build passed, and all **seven** deterministic E2E suites passed. Native readiness, the 11-check capture self-test, and scheduler checks also passed without live audio or recognition. Independent synthetic probes nevertheless reproduced six uncovered behaviors; two additional native findings are based on static control flow. See [the audit](ai/2026-10-25-repository-audit.md) for seven prioritized code findings and a separate deletion-retention caveat. The runtime remains unchanged and these findings are open.

No live microphone, system-audio capture, actual account inference, model download, signing setup, or installation was performed in this review. The installed Claude CLI was queried for status only with a temporary configuration and synthetic token. The probes are defect demonstrations, not new passing acceptance tests.

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
- Grant EventKit access and compare upcoming events with Apple Calendar. Check a reminder while the app is open.
- Exercise the app on Intel and older supported macOS versions. Compilation targets macOS 13, but those combinations have not been separately run.

The app should not be described as full Granola parity or a production-validated transcription system. It implements the requested local core; live service access, OS permission behavior, and transcription quality remain subject to the acceptance checks above.

## Design observations

The home feed and editor now follow the observed Granola hierarchy: narrow sidebar, upcoming-events card, chronological rows, serif title, compact metadata, quiet writing surface, and bottom chat/recording controls. A larger illustrated welcome screen and the first three-pane collection layout were removed. UI-only confirmations were replaced with actual state changes or written export files. Previous summaries and transcripts remain available when AI fails.

No claim of accessibility certification or user research is made. The executed layout and keyboard checks are listed above.
