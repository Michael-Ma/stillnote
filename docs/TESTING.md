# Testing Stillnote

The deterministic desktop suite exercises the real Electron window, renderer, preload,
IPC handlers, SQLite store, export/import handlers, and saved-audio playback. A test-only
adapter replaces the native capture process and ChatGPT transport with synthetic fixtures.
It never opens a real microphone, system-audio stream, calendar, browser login, or account.
These tests establish application behavior; they do not measure native recognition quality.

## Repeatable commands

```sh
npm test
npm run test:native-scheduler # after npm run build; no speech/device permission
node scripts/e2e.mjs
node scripts/e2e.mjs --suite notebook --no-build
node scripts/e2e.mjs --suite capture --no-build
node scripts/e2e.mjs --suite ai --no-build
node scripts/e2e.mjs --suite recovery --no-build
node scripts/e2e.mjs --suite calls --no-build
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

## Coverage and boundaries

| Suite               | What it verifies                                                                                                                                                                                                                                                                               | What it cannot establish                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `notebook`          | Editing/autosave, transcript entry, folders, star, export bytes, backup, duplicate restore, invalid-import atomicity, transcript import, Trash/restore, CJK search, immediate-close persistence, compact chat layout                                                                           | Every native file-picker interaction; OS dialogs are replaced but real handlers write/read files                                |
| `capture`           | Start/stop state, closing during capture, per-source WAV structure, persisted session metadata/transcripts, decoded audio playback before/after restart, latest-partial flush once, empty/failed recognition retaining audio, sparse coverage, retry, failed-start recovery, multiple sessions | Native device access, actual audio content, speech accuracy, diarization, echo, real-time continuity, native writer correctness |
| `ai`                | Failed/empty/incomplete stream rejection, cancellation, unchanged prior summary/notes, retry, revisions, citations and persistence                                                                                                                                                             | OAuth, real plan eligibility, usage limits, model quality, remote network reliability                                           |
| `calls`             | Start Google Meet/Zoom opens the fixed address and records a new note, remembered service, Join & record only for linked events, reminder join copy and click, one detection prompt per call (notification and in-app), none while or after recording, detection off, Chinese labels           | Real browser/Zoom launch, real macOS notifications and their permission, real microphone activity from other apps               |
| Existing unit tests | Store validation/search/revisions, SSE parser, synthetic OAuth protocol checks                                                                                                                                                                                                                 | Full desktop flow or actual provider behavior                                                                                   |
| Packaged smoke test | Packaged app launch, preload/store path and bundled native self-test                                                                                                                                                                                                                           | Microphone capture or recognition quality                                                                                       |

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

## Test adapter contract

`STILLNOTE_TEST_ADAPTER` is accepted only by an unpackaged app with `NODE_ENV=test` and
an explicit `STILLNOTE_DATA_DIR`. It names an absolute module exporting
`createTestAdapter({dataDir})`, which returns `{createNative, createAuth}`. The adapter
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
The optional `--recognize` flag exercises on-device file recognition through a dedicated macOS test app with its own Speech usage description. `--streamed` additionally feeds prerecorded PCM through the production live recognition windows in real time, exercising chunk scheduling and finalization without opening a microphone. `--long` repeats the fixture to span more than 60 seconds. `--dual-source` drives microphone and system channels together and scores each independently. It reproduces the concurrency failure that single-source tests missed. These modes may prompt for Speech Recognition permission.
It is deliberately excluded from the automatic deterministic suite. Synthetic recognition acceptance requires at least 70% keyword recall, 75–150% of reference word count, and token-level WER ≤25%. WER is token Levenshtein edit distance divided by reference token count; normalization changes case and punctuation only. Brand spellings and word boundaries are not rewritten, so “time stamps” versus “timestamps” and “Still note” versus “Stillnote” count as errors. Reports include the edit distance, token counts, and scoring definition. This small synthetic fixture is a regression test, not a general accuracy benchmark.
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
