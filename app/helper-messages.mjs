// Translates the native helper's messages (written in English in native/Capture.swift) into the
// interface language. Fixed sentences are listed with msg() so the i18n coverage test sees them;
// sentences with a part filled in (a language, a device, an Apple error) are matched by shape.
// Unknown messages pass through unchanged. Pure.
import { languageName } from './format.mjs';

const msg = (text) => text;
const fixed = new Set([
  msg('No language could transcribe this audio. The existing transcript was preserved.'),
  msg('Allow Calendar access in System Settings → Privacy & Security.'),
  msg('Already recording or finishing a recording.'),
  msg('Audio normalization failed.'),
  msg('Cannot create the local recording file.'),
  msg('File transcription finalization timed out. Retry from the saved audio.'),
  msg('Finish the current operation before retrying transcription.'),
  msg('Install this language in macOS Dictation settings, then retry.'),
  msg('Invalid recording track.'),
  msg('Microphone audio unit is unavailable.'),
  msg('Microphone input format is unavailable.'),
  msg('No compatible speech audio format is available.'),
  msg('No display is available for system-audio capture.'),
  msg('On-device transcription timed out. The recording is preserved.'),
  msg('Recording reached the WAV size limit.'),
  msg('Recording requires a valid local audio directory and session ID.'),
  msg('Speech audio conversion failed'),
  msg('Speech framework unavailable.'),
  msg('System-audio capture stopped while starting.'),
  msg('This language is not supported by on-device transcription.'),
  msg('Transcription is falling behind; retry from the saved recording after the meeting'),
  msg('Unknown native operation.'),
  msg('Unsupported input audio format.'),
  msg(
    'Meeting audio isn’t being recorded because macOS hasn’t allowed Stillnote to capture it; your microphone is still recording. Turn on Stillnote in Screen & System Audio Recording, then quit and reopen Stillnote. If it’s already on, remove it with − and allow it again.',
  ),
  msg('Recognition finalization timed out. The latest partial and original audio are preserved.'),
  msg('The selected microphone is missing. Using the default input device.'),
  msg(
    'Transcription is falling behind. Audio is still being saved; retry transcription from the recording after the meeting.',
  ),
  msg(
    'Speech Recognition permission is unavailable. Audio is still saved; enable permission and retry transcription later.',
  ),
  msg('The microphone keeps resetting. Check the input device in Settings › Recording.'),
  msg('Microphone permission denied.'),
  msg('Wait for the transcription retry to finish, then start recording.'),
  msg('Allow Microphone access for Stillnote in System Settings → Privacy & Security.'),
  msg('No microphone input is available. Connect a microphone; capture will retry automatically.'),
  msg('Allow Speech Recognition for Stillnote in macOS Settings, then retry. Audio is preserved.'),
  msg(
    'Transcription stopped because it was taking too long. The existing transcript was preserved.',
  ),
]);

// [shape, translate(match, t)]
const shaped = [
  [
    /^Download the (\S+) language in Settings to enable transcription\. Audio is still saved\.$/,
    (m, t) =>
      t(
        'Download the {language} language in Settings to enable transcription. Audio is still saved.',
        {
          language: languageName(m[1], t.locale),
        },
      ),
  ],
  [
    /^On-device recognition is unavailable for (\S+)\. Audio is still saved\.$/,
    (m, t) =>
      t('On-device recognition is unavailable for {language}. Audio is still saved.', {
        language: languageName(m[1], t.locale),
      }),
  ],
  [
    /^On-device recognition is unavailable for (\S+)\. Audio will still be saved\. Install the language in macOS Dictation settings, then retry transcription\.$/,
    (m, t) =>
      t(
        'On-device recognition is unavailable for {language}. Audio will still be saved. Install the language in macOS Dictation settings, then retry transcription.',
        { language: languageName(m[1], t.locale) },
      ),
  ],
  [
    /^On-device recognition is unavailable for (\S+)\. Install the language in macOS Dictation settings, then retry\.$/,
    (m, t) =>
      t(
        'On-device recognition is unavailable for {language}. Install the language in macOS Dictation settings, then retry.',
        { language: languageName(m[1], t.locale) },
      ),
  ],
  [
    /^Cannot select microphone (.+) \((-?\d+)\)\.$/,
    (m, t) => t('Cannot select microphone {device} ({status}).', { device: m[1], status: m[2] }),
  ],
  [
    /^Cannot save (microphone|system) audio: (.*)$/s,
    (m, t) =>
      m[1] === 'system'
        ? t('Cannot save meeting audio: {error}', { error: m[2] })
        : t('Cannot save microphone audio: {error}', { error: m[2] }),
  ],
  [
    /^Microphone capture continues, but system audio is unavailable: (.*)\. Check Screen & System Audio Recording permission\.$/s,
    (m, t) =>
      t(
        'Microphone capture continues, but system audio is unavailable: {error}. Check Screen & System Audio Recording permission.',
        { error: m[1] },
      ),
  ],
  [
    /^System audio stopped: (.*)\. Microphone capture continues\.$/s,
    (m, t) => t('System audio stopped: {error}. Microphone capture continues.', { error: m[1] }),
  ],
  [
    /^Recognition: (.*)\. Original audio is preserved\.$/s,
    (m, t) => t('Recognition: {error}. Original audio is preserved.', { error: m[1] }),
  ],
  [
    /^(You|Meeting audio) recognition: (.*)\. Original audio is preserved\.$/s,
    (m, t) =>
      t('{speaker} recognition: {error}. Original audio is preserved.', {
        speaker: t(m[1]),
        error: m[2],
      }),
  ],
  [
    /^Microphone restart failed: (.*)\. Retrying in two seconds\.$/s,
    (m, t) => t('Microphone restart failed: {error}. Retrying in two seconds.', { error: m[1] }),
  ],
  [
    /^Microphone input restarted on (.+)\. The capture gap is padded with silence\.$/,
    (m, t) =>
      t('Microphone input restarted on {device}. The capture gap is padded with silence.', {
        device: m[1],
      }),
  ],
  [
    /^Echo cancellation could not (?:be enabled|start): (.*)\. Continuing without it\.$/s,
    (m, t) =>
      t('Echo cancellation could not start: {error}. Continuing without it.', { error: m[1] }),
  ],
  [
    /^(.*) Using the default input device\.$/s,
    (m, t) => t('{error} Using the default input device.', { error: m[1] }),
  ],
];

export function helperMessage(message, t) {
  if (typeof message !== 'string' || !message) return message;
  if (fixed.has(message)) return t(message);
  for (const [shape, translate] of shaped) {
    const match = message.match(shape);
    if (match) return translate(match, t);
  }
  return message;
}
