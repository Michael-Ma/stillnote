import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  openSync,
  ftruncateSync,
  closeSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, context } from '../app/store.mjs';
import {
  recordingDirectory,
  inspectRecordingTracks,
  repairRecordingTracks,
  resolveRecordingTrack,
  audioResponse,
  assessCoverage,
} from '../app/recordings.mjs';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'stillnote-recordings-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const meetingId = randomUUID(),
    recordingId = randomUUID();
  const dir = recordingDirectory(dataDir, meetingId, recordingId);
  mkdirSync(dir, { recursive: true });
  return { dataDir, meetingId, recordingId, dir };
}

function wav({
  seconds = 1,
  sampleRate = 16000,
  channels = 1,
  bits = 16,
  encoding = 1,
  advertisedBytes,
  extraChunk = false,
  trailingChunk = false,
} = {}) {
  const blockAlign = (channels * bits) / 8;
  const audio = Buffer.alloc(Math.floor(seconds * sampleRate) * blockAlign, 0x11);
  const format = Buffer.alloc(24);
  format.write('fmt ');
  format.writeUInt32LE(16, 4);
  format.writeUInt16LE(encoding, 8);
  format.writeUInt16LE(channels, 10);
  format.writeUInt32LE(sampleRate, 12);
  format.writeUInt32LE(sampleRate * blockAlign, 16);
  format.writeUInt16LE(blockAlign, 20);
  format.writeUInt16LE(bits, 22);
  const data = Buffer.alloc(8);
  data.write('data');
  data.writeUInt32LE(advertisedBytes ?? audio.length, 4);
  const junk = Buffer.alloc(10);
  junk.write('JUNK');
  junk.writeUInt32LE(2, 4);
  const body = Buffer.concat([
    Buffer.from('WAVE'),
    format,
    ...(extraChunk ? [junk] : []),
    data,
    audio,
    ...(audio.length % 2 ? [Buffer.alloc(1)] : []),
    ...(trailingChunk ? [junk] : []),
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

const request = (range, method = 'GET') =>
  new Request('https://stillnote.invalid/audio', {
    method,
    headers: range ? { Range: range } : {},
  });

test('recording directories allow only UUID identifiers and never path traversal', (t) => {
  const { dataDir, meetingId, recordingId, dir } = fixture(t);
  assert.equal(dir, join(dataDir, 'recordings', meetingId, recordingId));
  for (const bad of ['../outside', '/tmp', '', 'microphone.wav', null, {}, 'a'.repeat(36)]) {
    assert.throws(() => recordingDirectory(dataDir, bad, recordingId), /Invalid recording/);
    assert.throws(() => recordingDirectory(dataDir, meetingId, bad), /Invalid recording/);
  }
});

test('WAV inspection measures actual PCM frames and ignores unadvertised arbitrary files', (t) => {
  const { dir } = fixture(t);
  const mic = wav({ seconds: 1.25, sampleRate: 48000, channels: 2 });
  writeFileSync(join(dir, 'microphone.wav'), mic);
  writeFileSync(
    join(dir, 'system.wav'),
    wav({ seconds: 2, sampleRate: 16000, bits: 32, encoding: 3, extraChunk: true }),
  );
  writeFileSync(join(dir, 'secret.wav'), wav());
  const tracks = inspectRecordingTracks(dir, [
    { source: 'microphone', duration: 900, startOffset: 1.5 },
  ]);
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks[0], {
    source: 'microphone',
    fileName: 'microphone.wav',
    duration: 1.25,
    sampleRate: 48000,
    channels: 2,
    bytes: mic.length,
    startOffset: 1.5,
  });
  assert.equal(tracks[1].duration, 2);
  assert.equal(tracks[1].sampleRate, 16000);
  assert.equal(tracks[1].startOffset, undefined);
});

test('WAV inspection recovers crashed stale data lengths without changing files', (t) => {
  const { dir } = fixture(t);
  for (const advertisedBytes of [0, 8000, 0xffffffff]) {
    const file = wav({ seconds: 2, advertisedBytes });
    file.writeUInt32LE(36, 4);
    writeFileSync(join(dir, 'microphone.wav'), file);
    const tracks = inspectRecordingTracks(dir);
    assert.equal(tracks[0].duration, 2);
    assert.deepEqual(readFileSync(join(dir, 'microphone.wav')), file);
  }
});

test('WAV inspection excludes trailing chunks, padding and incomplete frames', (t) => {
  const { dir } = fixture(t);
  writeFileSync(join(dir, 'microphone.wav'), wav({ seconds: 1, trailingChunk: true }));
  assert.equal(inspectRecordingTracks(dir)[0].duration, 1);
  writeFileSync(join(dir, 'microphone.wav'), wav({ seconds: 1 / 1000, sampleRate: 1000, bits: 8 }));
  assert.equal(inspectRecordingTracks(dir)[0].duration, 0.001);
  const partial = Buffer.concat([wav({ seconds: 1, advertisedBytes: 0 }), Buffer.from([0xff])]);
  writeFileSync(join(dir, 'microphone.wav'), partial);
  assert.equal(inspectRecordingTracks(dir)[0].duration, 1);
});

test('WAV inspection rejects malformed headers, unsupported encodings and empty audio', (t) => {
  const { dir } = fixture(t);
  const invalid = [
    Buffer.from('not audio'),
    wav({ seconds: 0 }),
    wav({ encoding: 6 }),
    wav({ sampleRate: 0 }),
  ];
  const wrongAlign = wav();
  wrongAlign.writeUInt16LE(100, 32);
  invalid.push(wrongAlign);
  const truncatedFormat = wav();
  truncatedFormat.writeUInt32LE(0xffffffff, 16);
  invalid.push(truncatedFormat);
  for (const bytes of invalid) {
    writeFileSync(join(dir, 'microphone.wav'), bytes);
    assert.deepEqual(inspectRecordingTracks(dir), []);
  }
  assert.deepEqual(inspectRecordingTracks(join(dir, 'missing')), []);
});

test('recovery repairs only Stillnote canonical WAV headers', (t) => {
  const { dir } = fixture(t);
  const broken = wav({ seconds: 2, advertisedBytes: 0 });
  broken.writeUInt32LE(36, 4);
  const foreign = wav({ seconds: 2, advertisedBytes: 0, extraChunk: true });
  writeFileSync(join(dir, 'microphone.wav'), broken);
  writeFileSync(join(dir, 'system.wav'), foreign);
  const tracks = repairRecordingTracks(dir);
  const repaired = readFileSync(join(dir, 'microphone.wav'));
  assert.equal(repaired.readUInt32LE(4), repaired.length - 8);
  assert.equal(repaired.readUInt32LE(40), repaired.length - 44);
  assert.deepEqual(repaired.subarray(44), broken.subarray(44));
  assert.deepEqual(readFileSync(join(dir, 'system.wav')), foreign);
  assert.equal(tracks[0].duration, 2);
});

test('track resolution requires owned metadata and rejects symlink escapes', (t) => {
  const { dataDir, meetingId, recordingId, dir } = fixture(t);
  const track = { source: 'microphone', fileName: 'microphone.wav' };
  const recording = { id: recordingId, tracks: [track] };
  writeFileSync(join(dir, 'microphone.wav'), wav());
  assert.equal(
    resolveRecordingTrack(dataDir, meetingId, recording, 'microphone'),
    realpathSync(join(dir, 'microphone.wav')),
  );
  assert.throws(() => resolveRecordingTrack(dataDir, meetingId, recording, 'system'), /not found/);
  assert.throws(() => resolveRecordingTrack(dataDir, meetingId, recording, '__proto__'), /Unknown/);
  assert.throws(
    () =>
      resolveRecordingTrack(
        dataDir,
        meetingId,
        { ...recording, tracks: [{ ...track, fileName: '../secret' }] },
        'microphone',
      ),
    /not found/,
  );
  const outside = join(dataDir, 'outside.wav');
  writeFileSync(outside, wav());
  rmSync(join(dir, 'microphone.wav'));
  symlinkSync(outside, join(dir, 'microphone.wav'));
  assert.throws(() => resolveRecordingTrack(dataDir, meetingId, recording, 'microphone'), /Unsafe/);
  assert.deepEqual(inspectRecordingTracks(dir), []);
  const other = join(dataDir, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'microphone.wav'), wav());
  rmSync(dir, { recursive: true });
  symlinkSync(other, dir);
  assert.throws(() => resolveRecordingTrack(dataDir, meetingId, recording, 'microphone'), /Unsafe/);
});

test('audio responses stream full files and standards-compliant single byte ranges', async (t) => {
  const { dir } = fixture(t),
    path = join(dir, 'microphone.wav');
  const bytes = wav();
  writeFileSync(path, bytes);
  let response = await audioResponse(path, request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  for (const [range, start, end] of [
    ['bytes=0-43', 0, 43],
    ['bytes=44-', 44, bytes.length - 1],
    ['bytes=-25', bytes.length - 25, bytes.length - 1],
    ['bytes=10-9999999', 10, bytes.length - 1],
    ['bytes=-9999999', 0, bytes.length - 1],
  ]) {
    response = await audioResponse(path, request(range));
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.equal(response.headers.get('content-length'), String(end - start + 1));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
});

test('audio responses handle invalid ranges, HEAD, empty files and unsupported methods', async (t) => {
  const { dir } = fixture(t),
    path = join(dir, 'microphone.wav');
  const bytes = wav();
  writeFileSync(path, bytes);
  for (const range of [
    'bytes=999999-',
    'bytes=20-10',
    'bytes=-0',
    'bytes=-',
    'bytes=0-1,4-5',
    'items=0-4',
    'bytes=9007199254740992-',
    'bytes=abc-def',
  ]) {
    const response = await audioResponse(path, request(range));
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`);
    assert.equal(response.headers.get('content-length'), '0');
    assert.equal(await response.text(), '');
  }
  let response = await audioResponse(path, request('bytes=0-1', 'HEAD'));
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  response = await audioResponse(path, request(undefined, 'POST'));
  assert.equal(response.status, 405);
  writeFileSync(path, Buffer.alloc(0));
  response = await audioResponse(path, request());
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  response = await audioResponse(path, request('bytes=0-'));
  assert.equal(response.status, 416);
});

test('large audio can be streamed and cancelled before reading the complete file', async (t) => {
  const { dir } = fixture(t),
    path = join(dir, 'microphone.wav');
  const fd = openSync(path, 'w');
  ftruncateSync(fd, 64 * 1024 * 1024);
  closeSync(fd);
  const response = await audioResponse(path, request());
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.ok(first.value.byteLength > 0 && first.value.byteLength < 1024 * 1024);
  await reader.cancel();
});

test('coverage flags the sparse 62-second recording without treating silence as a definite failure', () => {
  const sourceStats = { microphone: { rms: 0.02 } };
  const result = assessCoverage([{ text: 'a'.repeat(30) }], 62, sourceStats);
  assert.equal(result.lowCoverage, true);
  assert.equal(result.transcriptCharacters, 30);
  assert.equal(result.audioDuration, 62);
  assert.deepEqual(result.sourceStats, sourceStats);
  assert.match(result.reasons[0], /check coverage/);
  assert.equal(assessCoverage([{ text: 'a'.repeat(200) }], 62).lowCoverage, false);
  assert.equal(assessCoverage([], 5).lowCoverage, false);
  assert.equal(assessCoverage([], 60).lowCoverage, true);
  assert.equal(assessCoverage([], -1).audioDuration, 0);
  const chinese = assessCoverage([{ text: '这是中文会议内容'.repeat(15) }], 62);
  assert.equal(chinese.lowCoverage, false);
  assert.equal(chinese.transcriptCharacters, 120);
  assert.equal(assessCoverage([{ text: 'one two, three' }], 0).transcriptWords, 3);
});

test('recording transcripts preserve manual text, other sessions and prior retry versions', (t) => {
  const { dataDir } = fixture(t),
    store = new Store(dataDir);
  t.after(() => store.close());
  const note = store.create({ notes: 'Keep these rough notes.' });
  const first = randomUUID(),
    second = randomUUID();
  store.append(note.id, { text: 'Manual transcript', timestamp: 0 });
  store.beginRecording(note.id, { id: first, locale: 'zh-CN' });
  store.append(note.id, {
    text: 'Later window',
    timestamp: 10,
    recordingId: first,
    segmentId: 'window-b',
    source: 'microphone',
  });
  store.append(note.id, {
    text: 'Earlier window',
    timestamp: 1,
    recordingId: first,
    segmentId: 'window-a',
    source: 'system',
  });
  store.append(note.id, {
    text: 'Corrected earlier window',
    timestamp: 1,
    recordingId: first,
    segmentId: 'window-a',
    source: 'system',
  });
  store.finishRecording(note.id, first, { status: 'completed', duration: 12, tracks: [] });
  store.beginRecording(note.id, { id: second });
  store.append(note.id, {
    text: 'Second session',
    timestamp: 13,
    recordingId: second,
    source: 'microphone',
  });
  store.finishRecording(note.id, second, { status: 'completed', duration: 2, tracks: [] });
  let saved = store.get(note.id);
  assert.deepEqual(
    saved.transcript.map((segment) => segment.text),
    ['Manual transcript', 'Corrected earlier window', 'Later window', 'Second session'],
  );
  assert.equal(saved.duration, 14);
  assert.equal(saved.recordings[0].locale, 'zh-CN');
  assert.equal(saved.recordings[1].locale, 'en-US');
  const retry = [{ text: 'Recovered first recording', timestamp: 2, source: 'microphone' }];
  saved = store.replaceRecordingTranscript(note.id, first, retry, assessCoverage(retry, 12));
  assert.deepEqual(
    saved.transcript.map((segment) => segment.text),
    ['Manual transcript', 'Recovered first recording', 'Second session'],
  );
  assert.deepEqual(
    store.transcriptVersions(note.id)[0].segments.map((segment) => segment.text),
    ['Corrected earlier window', 'Later window'],
  );
  assert.equal(saved.notes, 'Keep these rough notes.');
  // The retry's replaced transcript can be restored; restoring again undoes it.
  const firstSession = () => store.get(note.id).recordings.find((r) => r.id === first);
  assert.ok(firstSession().previousAt);
  assert.equal(firstSession().edited, false);
  const recovered = store.get(note.id).transcript.find((s) => s.recordingId === first);
  store.editSegment(note.id, recovered.id, { text: 'Recovered, corrected by hand' });
  assert.equal(firstSession().edited, true, 'a hand correction marks the recording');
  const restored = store.restoreTranscript(note.id, first);
  assert.deepEqual(
    restored.transcript.filter((s) => s.recordingId === first).map((s) => s.text),
    ['Corrected earlier window', 'Later window'],
  );
  assert.equal(firstSession().edited, false, 'the restored version was not edited');
  const undone = store.restoreTranscript(note.id, first);
  assert.deepEqual(
    undone.transcript.filter((s) => s.recordingId === first).map((s) => s.text),
    ['Recovered, corrected by hand'],
  );
  assert.equal(firstSession().edited, true, 'and the edit mark comes back with it');
  assert.throws(() => store.restoreTranscript(note.id, second), /no earlier transcript/);
  saved = store.replaceRecordingTranscript(note.id, first, retry, assessCoverage(retry, 12));
  assert.throws(() => store.replaceRecordingTranscript(note.id, first, [], {}), /preserved/);
  assert.deepEqual(store.get(note.id), saved);
  assert.throws(
    () => store.replaceRecordingTranscript(note.id, first, [{ text: 500 }], {}),
    /preserved/,
  );
  assert.deepEqual(store.get(note.id), saved);
  const reopened = new Store(dataDir);
  assert.deepEqual(reopened.get(note.id).recordings, saved.recordings);
  reopened.close();
});

test('JSON backups and AI context exclude recording files; imported metadata cannot grant playback', (t) => {
  const { dataDir } = fixture(t),
    store = new Store(dataDir);
  t.after(() => store.close());
  const note = store.create(),
    recordingId = randomUUID();
  store.beginRecording(note.id, { id: recordingId });
  store.append(note.id, { text: 'Human transcript evidence', recordingId, timestamp: 0 });
  store.finishRecording(note.id, recordingId, {
    status: 'completed',
    duration: 60,
    tracks: [{ source: 'microphone', fileName: 'microphone.wav', path: '/private/raw-audio.wav' }],
    diagnostics: { secretPath: '/private/raw-audio.wav' },
  });
  const backup = store.backup();
  const serialized = JSON.stringify(backup);
  assert.equal(backup.audioIncluded, false);
  assert.ok(
    !serialized.includes('microphone.wav') && !serialized.includes('/private/raw-audio.wav'),
  );
  const ai = context([store.get(note.id)]);
  assert.ok(ai.includes('Human transcript evidence'));
  assert.ok(!ai.includes('recordings') && !ai.includes('/private/raw-audio.wav'));
  const importedId = randomUUID();
  backup.meetings[0].id = importedId;
  backup.meetings[0].recordings = [
    {
      id: recordingId,
      status: 'completed',
      tracks: [{ source: 'microphone', fileName: 'microphone.wav' }],
    },
  ];
  backup.meetings[0].audioPath = '/private/raw-audio.wav';
  assert.equal(store.restore(backup), 1);
  const imported = store.get(importedId);
  assert.deepEqual(imported.recordings, []);
  assert.equal(imported.audioPath, undefined);
  assert.equal(imported.transcript[0].recordingId, undefined);
});
