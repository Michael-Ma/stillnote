// Synthetic meeting audio and the microphone beside it, for the speaker-echo checks: speech-like
// noise in syllables, its echo through the speakers, a voice of the user's own, and the exact
// silence an input restart writes. Nothing here is anyone's real audio.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const rate = 16000;

// Seeded so every run hears the same thing.
function random(seed) {
  let state = seed >>> 0;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

// Syllables of 120–280 ms with gaps of 30–120 ms, in noise, `level` loud at their peak.
export function speech(seconds, seed, level) {
  const next = random(seed),
    out = new Float32Array(Math.round(seconds * rate));
  let at = 0;
  while (at < out.length) {
    const length = Math.round((0.12 + 0.16 * next()) * rate);
    for (let i = 0; i < length && at + i < out.length; i++)
      out[at + i] = level * Math.sin((Math.PI * i) / length) * (next() * 2 - 1);
    at += length + Math.round((0.03 + 0.09 * next()) * rate);
  }
  return out;
}

// `meeting` played back through the speakers: `gain` as loud, `delay` seconds later.
export function echo(meeting, gain, delay = 0.08) {
  const out = new Float32Array(meeting.length),
    shift = Math.round(delay * rate);
  for (let i = shift; i < out.length; i++) out[i] = gain * meeting[i - shift];
  return out;
}

// Each of `parts` added in, from `at` seconds: `{ at, samples }`; then a faint noise floor, and
// exact silence over every `restarts` [from, to].
export function mix(seconds, parts, restarts = [], seed = 99) {
  const next = random(seed),
    out = new Float32Array(Math.round(seconds * rate));
  for (const { at = 0, samples, from = 0, to = Infinity } of parts) {
    const start = Math.round(at * rate);
    for (let i = 0; i < samples.length && start + i < out.length; i++) {
      const t = (start + i) / rate;
      if (t >= from && t < to) out[start + i] += samples[i];
    }
  }
  for (let i = 0; i < out.length; i++) out[i] += 0.0005 * (next() * 2 - 1);
  for (const [from, to] of restarts) out.fill(0, Math.round(from * rate), Math.round(to * rate));
  return out;
}

export const int16 = (samples) =>
  Int16Array.from(samples, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767));

// A track as the helper writes it: 16 kHz mono 16-bit PCM after a 44-byte header.
export function wavFile(samples) {
  const pcm = int16(samples),
    buffer = Buffer.alloc(44 + pcm.length * 2);
  buffer.write('RIFF');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(pcm.length * 2, 40);
  Buffer.from(pcm.buffer).copy(buffer, 44);
  return buffer;
}

// A call where the headphones come out: meeting audio talks throughout but for two pauses. The
// microphone hears only the user until 12 s, then the input restarts on the Mac's own microphone,
// which hears the speakers a fifth as loud. Writes both tracks into `dir` and returns the phrases
// the recognizer would give (`rows`), the helper's events while recording, and the transcript that
// should be left (`expected`, as [source, text]).
export function headphonesOut(dir) {
  const meeting = speech(40, 1, 0.3);
  writeFileSync(
    join(dir, 'system.wav'),
    wavFile(
      mix(40, [
        { samples: meeting, to: 6 },
        { samples: meeting, from: 9.5, to: 24 },
        { samples: meeting, from: 27 },
      ]),
    ),
  );
  const played = echo(meeting, 0.2);
  writeFileSync(
    join(dir, 'microphone.wav'),
    wavFile(
      mix(
        40,
        [
          { at: 6, samples: speech(2.5, 2, 0.06) },
          { samples: played, from: 12.7, to: 24 },
          { at: 24.2, samples: speech(2.3, 3, 0.06) },
          { samples: played, from: 27 },
        ],
        [[12, 12.7]],
      ),
    ),
  );
  const row = (source, segmentId, text, at) => {
    const words = text.split(' ');
    return {
      source,
      segmentId,
      speaker: source === 'microphone' ? 'You' : 'Meeting audio',
      text,
      timestamp: at,
      end: +(at + words.length * 0.32).toFixed(3),
      runs: words.map((word, i) => [
        +(at + i * 0.32).toFixed(3),
        +(at + (i + 1) * 0.32).toFixed(3),
        0.9,
        (i ? ' ' : '') + word,
      ]),
    };
  };
  const partial = (source, segmentId, text, at) => {
    const { runs, ...rest } = row(source, segmentId, text, at);
    return { type: 'partial', ...rest, partial: true };
  };
  const plan = 'We should look at the launch plan before Friday.';
  const own = 'Sounds good, I can take that one.';
  const said = 'We looked at the numbers for the new release and they seem fine.';
  const thanks = 'Okay, sounds good to everyone.';
  const later = 'Let me check the numbers and get back to you.';
  const rows = [
    row('system', 'sys-1', plan, 0.5),
    row('microphone', 'mic-1', own, 6),
    // The echo, with a word either side that the microphone heard of it.
    row('microphone', 'mic-2', `So, ${said} Okay then.`, 13.6),
    row('system', 'sys-2', said, 14),
    row('system', 'sys-3', thanks, 20),
    row('microphone', 'mic-3', 'Okay sounds good.', 20.05),
    row('microphone', 'mic-4', later, 24.2),
  ];
  const segment = (i) => ({ type: 'segment', ...rows[i] });
  const events = [
    segment(0),
    segment(1),
    {
      type: 'device-changed',
      source: 'microphone',
      device: { uid: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone' },
    },
    partial('system', 'sys-2', 'We looked at the numbers for the new', 14),
    partial('microphone', 'mic-2', 'So, we looked at the numbers for the new', 13.6),
    segment(2),
    segment(3),
    segment(4),
    segment(5),
    partial('microphone', 'mic-4', 'Let me check the numbers', 24.2),
    segment(6),
  ];
  const expected = [
    ['system', plan],
    ['microphone', own],
    ['system', said],
    ['system', thanks],
    ['microphone', later],
  ];
  return { rows, events, expected };
}
