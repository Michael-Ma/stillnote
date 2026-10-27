import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { meetingEndDetector, sustainedSound, trailingCut } from '../app/meeting-end.mjs';
import {
  inspectRecordingTracks,
  lastSound,
  trimRecordingTail,
  repairRecordingTracks,
} from '../app/recordings.mjs';

const s = 1000,
  min = 60 * s;

test('a call app letting go of the microphone ends the meeting once everyone is quiet', () => {
  const end = meetingEndDetector();
  end.start(0, { microphone: true });
  end.heard(9 * min);
  assert.equal(end.check(9 * min), null);
  end.microphone(false, 10 * min);
  assert.equal(end.check(10 * min + 9 * s), null, 'not before 10 s of quiet');
  assert.equal(end.check(10 * min + 10 * s), 'call');
  // Someone speaking afterwards (the call app let go while muted) means it is not over.
  end.heard(10 * min + 40 * s);
  assert.equal(end.check(10 * min + 45 * s), null);
  assert.equal(end.check(10 * min + 50 * s), 'call');
  // Taking the microphone again (switching devices, unmuting) withdraws it.
  end.microphone(true, 11 * min + 20 * s);
  assert.equal(end.check(11 * min + 30 * s), null);
});

test('muting, a brief microphone switch or a short voice memo is not the end of a call', () => {
  const memo = meetingEndDetector();
  memo.start(0);
  memo.heard(1 * min);
  memo.microphone(true, 2 * min);
  memo.microphone(false, 2 * min + 20 * s);
  assert.equal(memo.check(4 * min), null, 'a 20 s use of the microphone is not a call');

  const call = meetingEndDetector();
  call.start(0, { microphone: true });
  call.heard(5 * min);
  // Switching microphones: released for a few seconds and taken again continues the same hold.
  call.microphone(false, 5 * min);
  call.microphone(true, 5 * min + 5 * s);
  assert.equal(call.check(6 * min), null);
  // A call app that stays on the microphone while everyone is muted waits for the long silence.
  assert.equal(call.check(5 * min + 19 * min), null);
  assert.equal(call.check(5 * min + 20 * min), 'quiet');
});

test('the calendar meeting having ended counts after two minutes of quiet', () => {
  const end = meetingEndDetector();
  end.start(0, { end: 30 * min });
  end.heard(31 * min);
  assert.equal(end.check(32 * min), null, 'still talking after the scheduled end');
  assert.equal(end.check(33 * min), 'calendar');
  // A meeting that went quiet before its scheduled end is over when the end comes.
  const early = meetingEndDetector();
  early.start(0, { end: 30 * min });
  early.heard(25 * min);
  assert.equal(early.check(29 * min), null);
  assert.equal(early.check(30 * min), 'calendar');
  // An event moved later in the calendar is followed.
  early.calendar(45 * min);
  assert.equal(early.check(31 * min), null);
});

test('silence alone counts only after someone spoke, and only after ten minutes', () => {
  const end = meetingEndDetector();
  end.start(0);
  assert.equal(end.check(30 * min), null, 'waiting for people to join is not the end');
  end.heard(31 * min);
  assert.equal(end.check(40 * min), null);
  assert.equal(end.check(41 * min), 'quiet');
});

test('keep recording answers the prompt: each signal needs to happen again', () => {
  const end = meetingEndDetector();
  end.start(0, { microphone: true, end: 30 * min });
  end.heard(20 * min);
  end.microphone(false, 20 * min);
  assert.equal(end.check(21 * min), 'call');
  end.dismiss(21 * min);
  assert.equal(end.check(25 * min), null, 'the release was answered');
  assert.equal(end.check(32 * min), 'calendar', 'the calendar end has not been answered yet');
  end.dismiss(32 * min);
  assert.equal(end.check(41 * min), null, 'silence counts again from the answer');
  assert.equal(end.check(42 * min), 'quiet');
  // A new call that ends prompts again.
  const again = meetingEndDetector();
  again.start(0, { microphone: true });
  again.microphone(false, 5 * min);
  again.dismiss(6 * min);
  again.microphone(true, 7 * min);
  again.microphone(false, 9 * min);
  assert.equal(again.check(9 * min + 30 * s), 'call');
});

test('the trailing silence is cut ten seconds after the last speech, only when it is long', () => {
  assert.equal(trailingCut({ duration: 600, speech: 400, sounds: [380, 300] }), 410);
  assert.equal(trailingCut({ duration: 600, speech: 400, sounds: [500] }), 510, 'sound wins');
  assert.equal(trailingCut({ duration: 460, speech: 400 }), null, 'under a minute is kept');
  assert.equal(trailingCut({ duration: 600, speech: 0, sounds: [0, 0] }), null, 'nothing heard');
  assert.equal(trailingCut({ duration: 0, speech: 10 }), null);
});

// A helper track (16 kHz mono 16-bit) whose seconds have the given RMS levels.
function track(levels) {
  const audio = Buffer.alloc(levels.length * 32000);
  levels.forEach((level, second) => {
    for (let i = 0; i < 16000; i++)
      audio.writeInt16LE(Math.round((i % 2 ? level : -level) * 32767), (second * 16000 + i) * 2);
  });
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + audio.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(audio.length, 40);
  return Buffer.concat([header, audio]);
}
const quiet = (n) => Array(n).fill(0.001),
  speech = (n) => Array(n).fill(0.05);

test('the last sustained sound ignores clicks and stops reading at the last speech', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-end-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'microphone.wav');
  // Speech until 100 s, then quiet with a click at 150 s and two loud seconds at 200 s.
  const levels = [...speech(100), ...quiet(50), 0.2, ...quiet(49), 0.2, 0.2, ...quiet(98)];
  writeFileSync(file, track(levels));
  assert.equal(lastSound(file), 100);
  assert.equal(lastSound(file, { after: 120 }), 0, 'nothing sustained after 120 s');
  writeFileSync(file, track(quiet(90)));
  assert.equal(lastSound(file), 0);
  writeFileSync(file, Buffer.from('not a wav'));
  assert.equal(lastSound(file), null);
});

test('trimming cuts both tracks at the same moment and leaves a valid file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-end-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'microphone.wav'), track([...speech(60), ...quiet(240)]));
  // Meeting audio started two seconds into the recording.
  writeFileSync(join(dir, 'system.wav'), track([...speech(50), ...quiet(248)]));
  const offsets = [
    { source: 'microphone', startOffset: 0 },
    { source: 'system', startOffset: 2 },
  ];
  assert.equal(trimRecordingTail(dir, offsets, 70), 230);
  const tracks = inspectRecordingTracks(dir, offsets);
  assert.deepEqual(
    tracks.map((x) => [x.source, x.duration, x.startOffset]),
    [
      ['microphone', 70, 0],
      ['system', 68, 2],
    ],
  );
  const header = readFileSync(join(dir, 'system.wav')).subarray(0, 44);
  assert.equal(header.readUInt32LE(4), 36 + 68 * 32000);
  assert.equal(header.readUInt32LE(40), 68 * 32000);
  assert.equal(trimRecordingTail(dir, offsets, 200), 0, 'never lengthens or rewrites');
});

test('an untranscribed source counts as speaking only with sustained sound', () => {
  const sound = sustainedSound();
  let heard = false;
  // A click every few seconds over room noise.
  for (let t = 0; t < 20_000; t += 500) heard ||= sound(t % 3000 ? 0.002 : 0.3, t);
  assert.equal(heard, false);
  // Four seconds of talking.
  for (let t = 20_000; t < 24_000; t += 500) heard = sound(0.05, t);
  assert.equal(heard, true);
  assert.equal(sound(0.001, 40_000), false, 'and it fades');
});

test('a second-track replacement failure restores both original WAVs byte for byte', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-trim-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = track([...speech(10), ...quiet(90)]);
  for (const fileName of ['microphone.wav', 'system.wav'])
    writeFileSync(join(dir, fileName), original);
  let replacements = 0;
  assert.throws(
    () =>
      trimRecordingTail(dir, [], 20, {
        replace: (from, to) => {
          if (++replacements === 4) throw new Error('Injected second-track rename failure');
          renameSync(from, to);
        },
      }),
    /second-track rename/,
  );
  for (const fileName of ['microphone.wav', 'system.wav'])
    assert.deepEqual(readFileSync(join(dir, fileName)), original);
  assert.deepEqual(readdirSync(dir).sort(), ['microphone.wav', 'system.wav']);
});

test('unsupported second-track audio cannot leave the first track partly trimmed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-trim-format-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = track([...speech(10), ...quiet(90)]);
  writeFileSync(join(dir, 'microphone.wav'), original);
  writeFileSync(join(dir, 'system.wav'), 'unsupported track');
  assert.throws(() => trimRecordingTail(dir, [], 20), /unsupported recording track/);
  assert.deepEqual(readFileSync(join(dir, 'microphone.wav')), original);
  assert.equal(readFileSync(join(dir, 'system.wav'), 'utf8'), 'unsupported track');
});

for (const committed of [false, true]) {
  test(`startup repairs a ${committed ? 'committed' : 'partially replaced'} trim journal`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'stillnote-trim-recovery-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const transaction = mkdtempSync(join(dir, '.trim-'));
    const original = track([...speech(10), ...quiet(90)]);
    const shortened = track([...speech(10), ...quiet(10)]);
    writeFileSync(join(transaction, 'microphone.wav.original'), original);
    writeFileSync(join(dir, 'microphone.wav'), shortened);
    writeFileSync(join(dir, 'system.wav'), committed ? shortened : original);
    if (committed) {
      writeFileSync(join(transaction, 'system.wav.original'), original);
      writeFileSync(join(transaction, 'committed'), '');
    }
    const restored = repairRecordingTracks(dir);
    assert.deepEqual(
      restored.map((item) => item.duration),
      committed ? [20, 20] : [100, 100],
    );
    assert.deepEqual(readdirSync(dir).sort(), ['microphone.wav', 'system.wav']);
    for (const fileName of ['microphone.wav', 'system.wav'])
      assert.deepEqual(readFileSync(join(dir, fileName)), committed ? shortened : original);
  });
}
