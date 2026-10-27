# Testing Stillnote

The deterministic desktop suite exercises the real Electron window, renderer, preload,
IPC handlers, SQLite store, export/import handlers, and saved-audio playback. A test-only
adapter replaces the native capture process and ChatGPT transport with synthetic fixtures.
It never opens a real microphone, system-audio stream, calendar, browser login, or account.
These tests establish application behavior; they do not measure native recognition quality.

## Repeatable commands

```sh
npm test
npm run build
npm run test:native-scheduler # after npm run build; no speech/device permission
npm run test:native-lifecycle # delayed/failing/pending models, raw WAV persistence and language fallback
node scripts/e2e.mjs
node scripts/e2e.mjs --suite notebook --no-build
node scripts/e2e.mjs --suite capture --no-build
node scripts/e2e.mjs --suite ai --no-build
node scripts/e2e.mjs --suite recovery --no-build
node scripts/e2e.mjs --suite calls --no-build
node scripts/e2e.mjs --suite reminders --no-build
node scripts/e2e.mjs --suite meeting-end --no-build
node scripts/e2e.mjs --suite language --no-build
node scripts/native-audio-test.mjs
node scripts/native-audio-test.mjs --long
# Explicit opt-in: can prompt for macOS Speech Recognition permission.
node scripts/native-audio-test.mjs --recognize
node scripts/native-audio-test.mjs --long --recognize
node scripts/native-audio-test.mjs --long --recognize --streamed
node scripts/native-audio-test.mjs --long --recognize --streamed --dual-source
```

The default command rebuilds the app. Use `--no-build` only after building the current
sources. Electron requires a logged-in desktop session. The runner uses the installed
`playwright` library and requires no separate browser download. `--output <directory>`
selects an artifact location; otherwise each run receives `output/e2e/<timestamp>/`.
Any failed suite or build returns a nonzero exit status. Independent suites continue after
a failure so one invocation can collect several actionable failures.

Each run writes `report.json` with execution status, durations, assertions covered, error
stacks, and explicit flags for untested real services/devices. Suite folders contain
screenshots, renderer errors, renderer/native event logs, and the scenario configuration.
The notebook suite also retains its Markdown export and JSON backup as inspectable
evidence. A failure screenshot is captured whenever its window is available.

Each suite creates a separate directory under the OS temporary directory and confirms the
app's reported `dataDir` before doing work. The runner deletes that disposable database
and fixture audio after shutdown; report files remain. It does not use `.data`, a packaged
app's notebook, or existing account credentials. Audio elements are muted when testing
the playback clock, so synthetic tones do not play through the user's speakers.

Unit/IPC regressions also exercise changed or unreadable Claude auth, rejected custom/managed routing, actual read-only MCP CJK search, expired Auto partials at Stop, retry cancellation acknowledgements and forced helper replacement, stale-process output, and delayed reminder stop/start ordering. The native lifecycle check injects model factories and candidate failures without using Speech services; both synthetic audio sources must persist while initialization is pending and Stop must complete before those factories return.

## Coverage and boundaries

| Suite | What it verifies | Boundary |
| --- | --- | --- |
| `language` | English/简体中文 selection, persistence, and localized panel text | No transcription-quality measurement |
| `reminders` | Calendar reminders, real panel renderer, primary/menu actions, settings and no automatic recording until acted on | Calendar and external links use fixtures; macOS Spaces/full-screen behavior is not established |
| `calls` | Fixed Start URLs, calendar Join paths, note reuse, floating/in-app detection prompts, detection preferences | No real call app, real microphone activity or account |
| `meeting-end` | Countdown/Keep recording, panel and editor clearing, automatic/manual stop, saved trim metadata, Resume, Only ask and Chinese labels | Compressed fixture timing and synthetic sound; not evidence that real meetings end reliably |
| `capture` | Start/stop/close, WAV structure, playback and seeking, session metadata, retries, sparse coverage, failed-start recovery | Native capture and speech are substituted |
| `recovery` | Repair of interrupted canonical WAVs, persisted durations/transcripts, playback after restart | Synthetic interruption, not an OS power-loss durability test |
| `images` | Pasting and dropping images into My notes, block display, Backspace/Undo, the viewer, refused fake images and dropped PDFs, search, restart, Markdown export and backup | Synthetic paste/drop events; the real clipboard and Finder drags are not driven |
| `notebook` | Autosave, folders, stars, Markdown export, backup/import/restore, CJK search, Trash, immediate-close persistence, compact chat | Native file pickers are stubbed |
| `ai` | Failed/empty/incomplete streams, cancellation, prior-text preservation, retries, revisions and citations | No real authentication, plan access, quota or model-quality claim |

Unit and IPC tests cover the production detector thresholds, setting changes, panel sender/frame validation, stale panel actions, and staged multi-track trimming. Failure injection rejects a second-track replacement after the first one has changed, then checks byte-for-byte restoration. Recovery tests reconstruct incomplete and committed trim journals. The meeting-end E2E waits for both renderers to clear after Keep recording; delivery to the editor does not prove the panel has rendered its own update.


The fixture adapter feeds fragmented SSE bytes through the production `consumeResponse`
parser. Capture fixtures emit realistic line-delimited native events, and create valid
16-bit mono 16 kHz WAV files. Native file creation is synthetic; the application still
finalizes recording metadata and resolves playback through its actual media path.
The `recovery` suite separately seeds an interrupted session in its disposable database,
writes a canonical WAV with stale zero-length header fields, and launches the real app.
It verifies startup repair, interruption status, duration recovery, preserved notes and
transcript, decoded playback, and an additional restart without damage.

JSON backups disclose `audioIncluded: false` and exclude raw audio and local audio paths.
Backup tests verify that contract. Playback after reopening the same data directory is a
separate guarantee from transporting audio to another machine; JSON restore does not
restore playable audio files.

## Real call-end check

The `meeting-end` suite proves the logic with fixtures; this checks the installed app against real CoreAudio. Launch `/Applications/Stillnote.app` (or the packaged copy) through LaunchServices as an isolated scripted instance (`STILLNOTE_DATA_DIR` set to a temporary folder, `STILLNOTE_DISABLE_CLAUDE=1`, `STILLNOTE_MOCK_KEYCHAIN=1`) and add `STILLNOTE_WATCH_REAL_MICROPHONE=1`, which lets a scripted run watch the real microphone; drive it over `--remote-debugging-port`. Start a recording (meeting audio makes macOS's `replayd` hold an input throughout, as in a real call), then hold the microphone from another app for more than a minute, for example `ffmpeg -f avfoundation -i :0 -t 75 -f null -`. About ten seconds after it lets go, the window receives `meeting-end { reason: 'call' }`, and `meeting-end-stopped` follows when the 60-second countdown runs out. Keep the room quiet: speech or sound in meeting audio postpones the prompt, as it should. Close the instance by its PID.

## Test adapter contract

`STILLNOTE_TEST_ADAPTER` is accepted only by an unpackaged app with `NODE_ENV=test` and
an explicit `STILLNOTE_DATA_DIR`. It names an absolute module exporting
`createTestAdapter({dataDir})`, which supplies `createNative`, `createAuth`, `createClaude`, and optional calendar/panel/timing fixtures. The adapter
writes a ready marker; the runner refuses to proceed unless that marker exists. This
prevents an outdated build from accidentally using real capture or authentication.

`createNative()` returns a child-process-shaped object with `stdin`, `stdout`, `stderr`,
and lifecycle events. The app sends the production command protocol: `start` with
`audioDir`, `recordingId`, `locale`, and `systemAudio`; `stop`; and `transcribe` with saved
track paths. Fixtures emit `started`, `audio-level`, `partial`, `segment`, `warning`,
`error`, `stopped`, and retranscription completion events. A `stopped` event includes
`audio.tracks` with source, file name, duration, sample rate, channel count, and byte count.

`createAuth()` supplies account status, model discovery, and a `respond()` implementation.
`STILLNOTE_E2E_SCENARIO_FILE` configures response modes and native sessions. Fixtures
persist their own invocation counters across app restart in the disposable directory.
To add a regression, add an assertion to the appropriate suite and, when necessary, a
new scenario mode in `tests/e2e/adapter.mjs`. Avoid adding production IPC that exists
solely for tests. Never make this adapter available to a packaged build.

## Native prerecorded-speech acceptance

`node scripts/native-audio-test.mjs` creates local synthetic speech with macOS `say` and
passes it through the native `--audio-self-test` path. It tests the actual native audio
writer using known input, without accessing a microphone, network, or Speech permission.
Its report and synthetic audio remain in `output/native-audio/<run>/report.json`.
The optional `--recognize` flag exercises on-device file recognition. On macOS 26+ it launches the helper directly without legacy Speech authorization; older macOS uses a dedicated test app with its own Speech usage description. `--streamed` additionally feeds prerecorded PCM through the production live recognition windows in real time, exercising chunk scheduling and finalization without opening a microphone. `--long` repeats the fixture to span more than 60 seconds. `--dual-source` drives microphone and system channels together and scores each independently. It reproduces the concurrency failure that single-source tests missed. These modes may prompt for Speech Recognition permission.
It is deliberately excluded from the automatic deterministic suite. Synthetic recognition acceptance requires token-level WER ≤15% for each source. Keyword recall and word-count ratios are reported as diagnostics, not additional pass thresholds. WER is token Levenshtein edit distance divided by reference token count; normalization extracts lowercase ASCII English words and removes punctuation. Brand spellings and word boundaries are not rewritten, so “time stamps” versus “timestamps” and “Still note” versus “Stillnote” count as errors. Reports include the edit distance, token counts, and scoring definition. This small synthetic fixture is a regression test, not a general accuracy benchmark.
Every native audio run also converts the synthetic fixture to 48 kHz stereo AIFF, matching common microphone/system formats, then verifies native normalization to 16 kHz mono WAV with preserved duration and non-silent signal. Those metrics appear under `stereoNormalization`; recognition uses the original case.

The macOS synthesis service must be available: some sandboxed environments can make
`say` exit successfully while writing zero frames. The runner rejects that output.
Use a normal desktop terminal or an authorized execution environment when this occurs;
TTS service access is separate from Speech Recognition permission.

Run native acceptance separately and record its date, macOS version, app build, device,
locale, installed on-device language, permission state, and fixture provenance. A native
helper ready/self-test result or a passing synthetic suite is not a passing speech test.
Use self-authored or licensed prerecorded speech with an exact reference transcript.
Keep files local and do not use private meeting recordings without authorization.

1. **File recognition baseline.** Pass a known WAV to the native saved-audio transcription
   operation. Verify nonempty segments, source labels, increasing bounded timestamps,
   no repeated phrase at task boundaries, and explicit completion/failure. Include an
   English fixture, Chinese fixture, long pauses, a 60–120 second sample crossing task
   rotation, and silence. Unsupported locale/permission errors must be visible and leave
   the existing transcript intact.
2. **Capture path.** With the user knowingly granting microphone/speech/system permissions,
   play the prerecorded reference from a different app. In headphones mode capture system
   audio and separately speak into the microphone; in speaker mode repeat to evaluate
   echo. Confirm both source meters, per-source WAV files, playable duration, and source
   labels. Capture and file-recognition baselines should be compared to locate missing
   speech in device capture versus recognition.
3. **Stop and resume.** Stop during a spoken sentence, wait for finalization, restart the
   app, play every source, and retry transcription from saved files. Capture a second session
   into the same note. Verify no lost final sentence, duplicated old transcript, replaced
   audio file, or timestamp reset into the previous session.
4. **Degradation and recovery.** Deny each permission separately, select an unavailable
   language, disconnect a device, interrupt system capture, and try a silent recording.
   Each case must show the actual source state, retain any captured audio, allow a retry,
   and preserve rough notes and existing reviewed summaries.
5. **AI after recognition.** Review the transcript against the reference before enhancing.
   Complete a real connected-account enhancement and cited chat only with explicit account
   authorization. Check source fidelity and evidence gaps; a polished summary does not
   establish that the original speech was captured completely.

For each speech fixture report word error rate (WER) for English or character error rate
(CER) for Chinese against a documented normalization, plus missing-reference spans,
repeated spans, longest gap, recorded-vs-expected duration, transcription latency, and
whether final words survived stop/restart. Set quality thresholds before a release;
there is no universal accuracy threshold that a synthetic test can establish. Retain the
reference, recognized transcript, recording metadata, and local audio paths together as
the evidence for each acceptance result. Label unexecuted cases as pending.

## Native scheduler regression

`npm run test:native-scheduler` exercises the production Swift scheduler with a substituted async worker, not a substituted queue. It verifies maximum concurrency of one, FIFO progress across sources, the 24-job backlog bound, pending-job cancellation, active cancellation without duplicate completion, and recovery for the next job. It invokes no speech-recognition requests or audio devices and runs in CI after the native build. This complements, rather than replaces, the real dual-source acceptance test.

## Demo video and still screenshots

Run `npm run demo` from a checkout with dependencies installed, a supported Swift/Xcode toolchain, and `ffmpeg` plus `ffprobe` on PATH. The wrapper builds current sources, launches the unpackaged app with isolated fixture data, captures its real UI, and produces:

- `docs/images/demo.mp4`: shareable H.264 video with fixture labeling.
- `docs/images/demo-preview.gif`: lightweight README preview.
- `docs/images/demo-poster.png`: poster frame.
- `docs/images/demo-reminder.png` and `demo-meeting-end.png`: real panel captures used by the compositor.

Panel overlays use timing collected during capture; the panels themselves are static screenshots, so their displayed countdown is illustrative. A persistent label discloses fictional data, synthetic audio/recognition/AI, compressed end detection, and compositing. The command removes raw MP4/timing intermediates on success; `.gitignore` also excludes them. A failed run may leave disposable `.test-data-*` or intermediate files for inspection. Do not use personal meetings as presentation fixtures.

`npm run screenshots` continues to generate the README's separate still images. Its older `--demo` GIF mode is retained for compatibility; the current video and README preview are generated by `npm run demo`. Neither command establishes live-device capture or account inference. Inspect the rendered frames and decode the finished video before publishing regenerated media.

## Setup without touching an existing installation

`bash scripts/setup-mac.sh --test` runs prerequisite checks, dependency installation, packaging, the packaged-app smoke test, then `npm run test:install`. It never calls the normal Applications installation step. For an already-built checkout, run `npm run test:install` directly.

The install test creates its own `stillnote-install-test-*` directory under the OS temporary directory. It invokes the production installer twice there, then launches only that temporary executable with an explicit disposable `STILLNOTE_DATA_DIR`, mock keychain, and Claude discovery disabled. It seeds notes, a folder, a summary, a transcript, preferences and two synthetic WAVs; creates another note through the actual packaged UI; replaces the bundle; and checks persistence plus audio byte equality and the local playback protocol. If an installed Stillnote exists, its bundle is read only to test upgrading from it; its notebook is never opened. The current installed app's archive checksum must remain unchanged.

Test installations reject non-temporary roots and symlink escapes, never quit or reopen the production app, and remove only their own temporary files after success. Failures retain disposable evidence. The normal installer also restores the previous bundle if its final rename fails. These tests cover local installation and a seeded current-schema notebook, not every historical data migration, actual microphone capture, or real provider authentication.
