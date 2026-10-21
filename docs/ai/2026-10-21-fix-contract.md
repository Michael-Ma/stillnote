# Fix contract (2026-10-21)

Shared interface for the three parallel workstreams that fix the issues in
[2026-10-21-capture-recognition-review.md](2026-10-21-capture-recognition-review.md).
Each workstream owns a disjoint set of files. Code must match this contract exactly, so the
branches merge without renegotiation. Where a workstream needs something outside its files, it
relies on this contract instead of editing the other workstream's files.

| Workstream | Owns |
| --- | --- |
| **N — native** | `native/Capture.swift`, `native/Info.plist`, `scripts/build.mjs`, `scripts/native-audio-test.mjs`, `docs/CAPTURE-DIAGNOSTICS.md` |
| **M — main process** | `app/main.mjs`, `app/store.mjs`, `app/recordings.mjs`, `app/auth.mjs`, `app/stream.mjs`, `app/providers/**`, `app/preload.cjs`, `tests/*.test.mjs` (except `tests/ui-logic.test.mjs`), `tests/e2e/adapter.mjs`, `docs/ARCHITECTURE.md` |
| **U — renderer** | `app/ui.jsx`, `app/components/**`, `app/style.css`, `app/ai-view.mjs`, `app/own-lines.mjs`, `app/format.mjs`, `tests/ui-logic.test.mjs`, `tests/e2e/{harness,notebook,ai,capture,recovery}.mjs`, `scripts/smoke.mjs`, `docs/DESIGN.md` |

## 1. Settings keys (validated in `store.mjs` by M, edited in Settings by U)

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `inputDevice` | string (CoreAudio device UID) or `null` | `null` | `null` follows the macOS default input. |
| `echoCancellation` | `'auto'` \| `'on'` \| `'off'` | `'auto'` | `auto` enables voice processing only when the default output is built-in speakers. |
| `locale` | BCP-47 string matching `/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/` | `'en-US'` | Recognition language, e.g. `zh-CN`, `en-GB`, `yue-CN`. |

`inputDevice`, `provider` and `claudePath` are machine-specific. They are excluded from JSON backups and never restored.

## 2. Native helper protocol (N implements; M consumes; M mocks it in `tests/e2e/adapter.mjs`)

JSON lines over stdin/stdout, as today. Existing ops and events keep their current shape unless extended here.

### Ops (stdin)

- `start`: existing fields plus
  - `inputDevice`: UID or `null`
  - `context`: `string[]`, ≤ 100 items, each ≤ 100 chars. These are vocabulary hints such as names and terms.
  - `echoCancellation`: `'auto'|'on'|'off'`
- `transcribe`: existing fields plus `context` (same as above).
- `devices` → emits `{ "type": "devices", "inputs": [{ "uid", "name", "isDefault": bool, "transport": "built-in"|"usb"|"bluetooth"|"virtual"|"aggregate"|"other" }] }`.
- `languages` → emits `{ "type": "languages", "engine": "speechTranscriber"|"legacy", "supported": ["en-US", ...], "installed": ["en-US", ...] }`.
  - `speechTranscriber` is used on macOS 26 and later.
  - `legacy` lists the `SFSpeechRecognizer` locales that support on-device recognition, as both supported and installed.
- `install-language` `{ "locale" }`:
  - Emits `{ "type": "language-progress", "locale", "fraction": 0..1 }`, at most 4 per second.
  - Then emits `{ "type": "language-installed", "locale", "installed": [...] }`.
  - On failure, emits `{ "type": "error", "op": "install-language", "locale", "message" }`.
  - With the legacy engine it fails with a message pointing to macOS Dictation settings.

### Events (stdout)

- `started` gains:
  - `"engine": "speechTranscriber"|"legacy"`
  - `"echoCancellation": bool`
  - `sources.microphone.device: { "uid", "name" }`
- `{ "type": "source-silent", "recordingId", "source": "microphone"|"system", "device": "<name or empty>" }`
  - Emitted once after ≥ 6 s with peak < 0.003 since the recording started, or since the last `source-signal`.
- `{ "type": "source-signal", "recordingId", "source" }` is emitted when signal returns after `source-silent`.
- `{ "type": "device-changed", "recordingId", "source": "microphone", "device": { "uid", "name" } }`
  - Emitted after the helper restarts the input automatically following an `AVAudioEngineConfigurationChange` or a device loss.
  - Also emit a `warning`.
  - The microphone WAV stays time-aligned: write silence for the gap.
- `partial` / `segment`: same fields as today (`recordingId`, `segmentId`, `source`, `speaker`, `text`, `timestamp`, `partial`).
  - With `speechTranscriber` there is one segment per finalized phrase, and `segmentId` is stable per phrase.
  - Volatile results are `partial` events with the phrase's `segmentId`.
  - `timestamp` is the phrase start in seconds, relative to the recording start (same base as today).

## 3. IPC (M implements and adds to `preload.cjs`; U calls)

| Channel | Arguments | Returns |
| --- | --- | --- |
| `audio-devices` | — | `{ inputs: [...] }` (from `devices`, 10 s timeout) |
| `languages` | — | `{ engine, supported, installed }` |
| `install-language` | `locale` | `{ engine, supported, installed }` when complete. While it runs, the renderer receives `{ type: 'language-progress', locale, fraction }`. |

### Renderer events

M forwards these unchanged:
- `source-silent`, `source-signal`, `device-changed`, `language-progress`.
- `device-changed` is also merged into `state.recording.sources.microphone.device`.

### State additions

- `state.recording.engine`
- `state.recording.echoCancellation`
- `state.recording.sources.microphone.device`

### `update` patch flag

`update(id, patch)` accepts `patch.snapshotSummary === true`. It keeps the previous summary as a version even when the change comes from the renderer.
- U sets it for **“Use as enhanced notes”** and **“Restore this version”**.
- Plain autosave edits of the summary never create versions, except one snapshot of an AI-written summary the first time the user edits it (M tracks `summarySource: 'ai'|'edited'`).
- AI enhancement always snapshots the previous summary.

### `ai` result

Chat results gain `context: { included: number, total: number }`.
- M ranks meetings for `all`/folder scopes and fills the 350k budget instead of failing.
- U shows “Used N of M notes” under the answer when `included < total`.

## 4. Context hints (M builds; passed to `start` and `transcribe`)

From the meeting, deduplicated and limited to the bounds above:
- title words
- each participant name (split on `,`, `&`, ` and `)
- the folder name
- up to 50 distinctive terms from the rough notes: capitalized words ≥ 3 letters, and CJK runs of 2–8 characters

## 5. Verification each workstream runs before handing back

- `npm test` and `npm run build` pass, and `npm run format:check` passes for owned files.
- **N**: the native scheduler self-test, the audio self-test, and a SpeechTranscriber file transcription of a `say`-generated WAV with WER < 10%.
- **M**: unit tests for every bug fixed, and the E2E adapter answers the new ops.
- **U**: unit tests for new pure helpers. Electron E2E is run by the integrator.
