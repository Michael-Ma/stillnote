# Validation

Last checked: October 20, 2026, on an Apple Silicon Mac. This record distinguishes executed checks from code paths that still require the user's account or OS permissions.

## Executed

| Area | Result and evidence |
| --- | --- |
| Storage and search | Passed persistence across database reopen, folder assignment, transcript correction, indexed search, CJK substring search, Trash exclusion, and restore checks. |
| Revision safety | Passed separate rough-note preservation and prior-summary retention checks. |
| Backup and restore | Passed round-trip meeting/message/source/template restore, duplicate prevention, and invalid-import rejection before mutation. |
| AI context and streaming | Passed bounded-context rejection, fragmented/CRLF SSE decoding, and rejection of failed, empty, or incomplete responses. |
| OAuth | Passed synthetic PKCE callback flow, invalid state/nonce/audience/subject rejection, issued-client reuse after exchange failure, plan-scope enforcement, and serialized/checkpointed refresh. No real account was used. |
| Unit suite | `npm test`: 13 tests passed. |
| Real desktop UI | `npm run test:ui`: creation, editing/autosave, transcript entry, folder assignment, star, search, Trash/restore, Markdown export, settings/Escape, disconnected-account recovery, immediate-close saving, and compact layout passed. No renderer errors were observed. |
| Visual inspection | Rendered and inspected Home, editor, chat, settings, and a 1024×768 layout. Documentation images show fictional fixtures at 1280×860. The Home screenshot's calendar events are test fixtures, not a connected user calendar. |
| Native helper | Swift compilation succeeded. `--self-test` returned ready and enumerated 63 recognizer locales. Locale enumeration does not establish that all of them are installed for on-device recognition. |
| App bundle | macOS arm64 packaging and ad-hoc signature verification succeeded. `npm run test:package` launched the packaged app, saved a note through its real preload/IPC/store path, and started the bundled helper in self-test mode. |
| Runtime dependencies | `npm audit --omit=dev` reported zero vulnerabilities at the time checked. This is a package audit result, not a security certification. |

Desktop tests use separate `.test-data-*` directories. The export test stubs the native save-file picker while exercising the real export handler and verifying the written Markdown. Documentation screenshots populate an isolated presentation fixture. Neither is a production demo mode.

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
