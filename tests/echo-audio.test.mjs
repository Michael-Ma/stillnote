import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { levels, onlyEcho } from '../app/echo-audio.mjs';
import { echoJudge, trackLevels } from '../app/recordings.mjs';
import { echo, int16, mix, speech, wavFile } from './fixtures/echo-audio.mjs';

// Synthetic audio only: speech-like noise for meeting audio, its echo through the speakers (a
// fifth as loud, 80 ms later), and a voice of the user's own.
const meeting = speech(60, 1, 0.3);
const track = (samples) => ({ start: 0, power: levels(int16(samples)) });
const system = track(mix(60, [{ samples: meeting, to: 50 }]));
const known = [
  [10, 20],
  [35, 45],
];

test('levels are the mean power of every 10 ms', () => {
  const power = levels(Int16Array.from([...Array(160).fill(16384), ...Array(160).fill(0), 1]));
  assert.equal(power.length, 2);
  assert.ok(Math.abs(power[0] - 0.25) < 1e-9);
  assert.equal(power[1], 0);
});

test('the microphone hearing only the speakers is echo, once echo is known nearby', () => {
  const microphone = track(mix(60, [{ samples: echo(meeting, 0.2), to: 50 }]));
  assert.equal(onlyEcho(microphone, system, [25, 25.8], known), true);
  for (let at = 2; at < 48; at += 3.1)
    assert.equal(onlyEcho(microphone, system, [at, at + 0.6], known), true, `at ${at}`);
  // Nothing to calibrate on, or known echo too far away: no verdict, nothing goes.
  assert.equal(onlyEcho(microphone, system, [25, 25.8], []), false);
  assert.equal(onlyEcho(microphone, system, [25, 25.8], [[0, 0.3]]), false);
  assert.equal(onlyEcho(microphone, system, [25, 25.8], [[56, 59]]), false);
});

test('a voice of the user’s own over the echo is not echo, even a quieter one', () => {
  for (const level of [0.12, 0.06, 0.03]) {
    const microphone = track(
      mix(60, [
        { samples: echo(meeting, 0.2), to: 50 },
        { at: 30, samples: speech(1, 2, level) },
      ]),
    );
    assert.equal(onlyEcho(microphone, system, [30, 31], known), false, `voice at ${level}`);
    assert.equal(onlyEcho(microphone, system, [30.2, 30.6], known), false, `part at ${level}`);
  }
});

test('the user alone, or meeting audio silent, is never echo', () => {
  const microphone = track(
    mix(60, [
      { samples: echo(meeting, 0.2), to: 50 },
      { at: 52, samples: speech(2, 2, 0.06) },
    ]),
  );
  assert.equal(onlyEcho(microphone, system, [52, 53], known), false);
  assert.equal(onlyEcho(microphone, system, [55, 56], known), false);
});

test('a quiet echo goes on loudness alone, and the user still stands out above it', () => {
  const quiet = echo(meeting, 0.005);
  const microphone = track(
    mix(60, [
      { samples: quiet, to: 50 },
      { at: 30, samples: speech(1, 2, 0.06) },
    ]),
  );
  assert.equal(onlyEcho(microphone, system, [25, 25.8], known), true);
  assert.equal(onlyEcho(microphone, system, [30, 31], known), false);
});

test('after the input restarts, as on another device, echo from before it calibrates nothing', () => {
  // Speakers, then the input restarts (exact silence) and goes on hearing the speakers.
  const parts = [
    { samples: echo(meeting, 0.2), to: 24.3 },
    { samples: echo(meeting, 0.15), from: 25 },
  ];
  const restarted = track(mix(60, parts, [[24.3, 25]]));
  assert.equal(onlyEcho(track(mix(60, parts)), system, [33, 34], [[10, 20]]), true);
  assert.equal(onlyEcho(restarted, system, [33, 34], [[10, 20]]), false);
  assert.equal(onlyEcho(restarted, system, [33, 34], [[26, 29]]), true);
  // A stretch that holds the restart says nothing either.
  assert.equal(onlyEcho(restarted, system, [24, 25.5], [[10, 20]]), false);
  // Speakers, then headphones: the user's quiet voice there stays, whatever was known before.
  const headphones = track(
    mix(
      60,
      [
        { samples: echo(meeting, 0.2), to: 24.3 },
        { samples: echo(meeting, 0.01), from: 25 },
        { at: 30, samples: speech(1, 2, 0.02) },
      ],
      [[24.3, 25]],
    ),
  );
  for (const references of [
    [[10, 20]],
    [[26, 29]],
    [
      [10, 20],
      [26, 29],
    ],
  ])
    assert.equal(onlyEcho(headphones, system, [30, 31], references), false);
});

test('audio not recorded yet says nothing', () => {
  const microphone = track(mix(30, [{ samples: echo(meeting, 0.2) }]));
  assert.equal(onlyEcho(microphone, system, [29.8, 30.5], known), false);
  assert.equal(onlyEcho(microphone, system, [5, 5], known), false);
});

test('a track being recorded is read as it grows, and only helper tracks are read', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-echo-audio-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'microphone.wav');
  const first = mix(1, [{ samples: speech(1, 3, 0.2) }]);
  writeFileSync(path, wavFile(first).subarray(0, 44 + 16000 * 2 - 100));
  const read = trackLevels(path, 0.25);
  const before = read();
  assert.equal(before.start, 0.25);
  assert.equal(before.power.length, 99, 'a frame not yet whole waits');
  appendFileSync(path, wavFile(first).subarray(44 + 16000 * 2 - 100));
  appendFileSync(path, Buffer.alloc(320 * 50));
  const after = read();
  assert.equal(after.power.length, 150);
  assert.deepEqual(Array.from(after.power.subarray(0, 100)), Array.from(levels(int16(first))));
  assert.ok(after.power.subarray(100).every((v) => v === 0));
  const other = join(dir, 'other.wav');
  writeFileSync(other, Buffer.alloc(1000));
  assert.equal(trackLevels(other)(), null);
});

test('a recording’s own tracks say whether the microphone heard only the speakers', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-echo-judge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The microphone's track starts later than meeting audio's, as real ones do.
  writeFileSync(join(dir, 'system.wav'), wavFile(mix(60, [{ samples: meeting, to: 50 }])));
  writeFileSync(
    join(dir, 'microphone.wav'),
    wavFile(mix(59.5, [{ samples: echo(meeting, 0.2).subarray(8000), to: 49.5 }])),
  );
  let tracks;
  const judge = echoJudge(dir, () => tracks);
  assert.equal(judge([25, 25.8], known), false, 'before the tracks start, nothing goes');
  tracks = [
    { source: 'microphone', startOffset: 0.5 },
    { source: 'system', startOffset: 0 },
  ];
  assert.equal(judge([25, 25.8], known), true);
  assert.equal(judge([55, 56], known), false);
  rmSync(join(dir, 'system.wav'));
  assert.equal(echoJudge(dir, () => tracks)([25, 25.8], known), false);
});
