# Diagnosing incomplete transcripts

A summary such as “only brief, disconnected fragments” can accurately describe the text received by the model while still indicating a broken or poorly configured capture/recognition path. Empty rough notes are valid: the transcript alone should be enough when it contains the conversation.

Version 0.2 adds observable checkpoints between audio input, recognition, persistence, and enhancement. It does not use the quality of an AI summary as proof that audio capture succeeded.

## What changed

- Original microphone and system audio are written independently of recognition. Recognition permission or language availability can fail without discarding captured audio.
- Each source is normalized to 16 kHz mono PCM. Those same normalized samples are written to WAV and supplied to live recognition.
- WAV headers are checkpointed every second and finalized on stop. Interrupted sessions are detected on restart, and canonical WAV headers can be repaired from actual sample bytes.
- Recognition windows rotate after 40 seconds of audio. An ended window can deliver its final result while the next window begins; it is not immediately cancelled or invalidated. Each window has a stable segment ID, preventing one window's final result from deleting another's latest partial.
- Finishing waits for recognition finalization, with a bounded fallback preserving the last partial. The reported recording duration excludes this wait.
- Per-source input meters show captured signal, not recognition accuracy. Microphone and system-audio availability are tracked separately.
- A sparse-transcript heuristic flags cases such as a roughly one-minute recording yielding only a few dozen characters. It is a diagnostic prompt, not a claim that speech definitely occurred throughout the recording.
- Automatic enhancement is skipped when coverage is sparse and there are no substantial rough notes. The recording and transcript remain inspectable.

Version 0.1 discarded audio. Its historical audio cannot be recovered, and the exact cause of missing speech cannot be established from saved transcript fragments alone. Possible causes include input availability, recognition configuration/language, or recognition lifecycle behavior. The new artifacts allow these to be distinguished.

## How to test a meeting

1. Confirm the **Meeting language** in Settings matches the speech you intend to record.
2. Start a short meeting. Check the microphone and system-audio source states and input meters. A moving meter establishes signal, not intelligible speech.
3. Finish the recording and open **Recordings**. Listen to each source separately; seek to the parts corresponding to missing transcript text.
4. If the audio is missing or silent, investigate device routing and macOS permissions before retrying recognition.
5. If the audio is clear but the transcript is sparse, confirm the language and on-device language installation, then choose **Retry transcription**.
6. Retry reads the saved audio in bounded chunks. It replaces only that recording session's transcript after successful nonempty completion, preserving other sessions, manual transcript text, and a prior transcript version. Failure or empty recognition preserves the previous transcript.
7. Review the recovered transcript before enhancing notes again. Retry does not automatically regenerate or overwrite your reviewed summary.

Use headphones when separating your microphone from another app's playback; otherwise the microphone may also pick up the remote audio. The app labels input sources, not individual remote speakers.

## Storage and privacy

Audio files are local PCM WAVs under the app's data directory, `recordings/<meeting-id>/<session-id>/microphone.wav` and `system.wav`. They are retained for playback and debugging and never included in the model's context or uploaded to OpenAI. The local media protocol only resolves known recording tracks and supports byte ranges for seeking; it does not expose arbitrary filesystem paths or run a network server.

JSON backups disclose `audioIncluded: false`. They preserve notebook content and history but do not transport raw audio. Imports cannot claim access to existing local recording files. Copy the whole data folder separately if audio preservation is required.

## Reusable evidence

See [TESTING.md](TESTING.md) for deterministic desktop E2E suites, the native audio writer test, and opt-in on-device recognition. The default native test uses synthesized speech; `--long` uses a 60+ second fixture. The `--recognize` mode runs through a dedicated macOS test app with a Speech usage description, because a terminal-launched helper may inherit a host without the required privacy declaration. macOS permission remains a user decision.

![Recording playback controls using fictional E2E fixtures](images/recordings.png)
