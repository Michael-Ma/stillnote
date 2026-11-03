import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  aggregateScores,
  convergence,
  cpuTotals,
  mixBlock,
  numbersOutput,
  options,
  pcmWav,
  scoreWords,
  selectBlocks,
  signalSums,
  zeroRuns,
} from '../scripts/aec-eval.mjs';
import { aecMode, recognizeTracks, sessions } from '../scripts/echo-eval.mjs';

const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const fixture = (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'stillnote-eval-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

function envelopes(own = false) {
  const power = (frame) => 0.008 * (1.1 + Math.sin(frame * 0.19)) ** 2 + 0.00001;
  const system = {
    start: 0.2,
    power: Float32Array.from({ length: 6000 }, (_, i) => (i < 2800 ? power(i + 20) : 0)),
  };
  const microphone = {
    start: 0,
    power: Float32Array.from({ length: 6200 }, (_, i) => {
      if (i < 2820) return own ? power(i * 2 + 353) : power(i - 12) * 0.5;
      return i > 3100 && i < 5800 ? 0.01 * (1.1 + Math.sin(i * 0.31)) ** 2 : 0;
    }),
  };
  return { microphone, system };
}

test('block selection finds loud delayed echo and same-recording user speech, respects offsets and cap', () => {
  const { microphone, system } = envelopes();
  const result = selectBlocks(microphone, system, { blockSeconds: 4, voiceSeconds: 2, cap: 2 });
  assert.ok(result.echoCandidates > 2);
  assert.ok(result.voiceCandidates > 2);
  assert.equal(result.echo.length, 2);
  assert.equal(result.voice.length, 2);
  assert.ok(result.echo.every((b) => b.from >= 1 && b.to < 28));
  assert.ok(result.voice.every((b) => b.from > 30 && b.to < 59));
  const other = envelopes(true);
  assert.equal(selectBlocks(other.microphone, other.system, { blockSeconds: 4 }).echo.length, 0);
  const silent = { start: 0, power: new Float32Array(6000) };
  assert.equal(selectBlocks(silent, silent).voice.length, 0);
  const quietEcho = {
    ...microphone,
    power: Float32Array.from(microphone.power, (v, i) => (i < 2820 ? v / 100000 : v)),
  };
  assert.equal(selectBlocks(quietEcho, system).echo.length, 0);
});

test('mixing preserves natural level and warm-up, applies -8 dB without mutating sources, counts clipping', () => {
  const echo = Int16Array.from([100, 200, 300, 400]);
  const voice = Int16Array.from([1000, -2000]);
  const natural = mixBlock(echo, voice, { lead: 2 });
  assert.deepEqual([...natural.mixed], [100, 200, 1300, -1600]);
  assert.deepEqual([...natural.voice], [...voice]);
  assert.equal(natural.clipped, 0);
  const quiet = mixBlock(echo, voice, { lead: 2, levelDb: -8 });
  assert.deepEqual([...quiet.voice], [398, -796]);
  assert.deepEqual([...quiet.mixed], [100, 200, 698, -396]);
  assert.deepEqual([...echo], [100, 200, 300, 400]);
  assert.deepEqual([...voice], [1000, -2000]);
  assert.equal(mixBlock(Int16Array.of(32000, -32000), Int16Array.of(2000, -2000)).clipped, 2);
  assert.throws(() => mixBlock(echo, new Int16Array(5)), /fit/);
});

test('word scores count duplicates, omit shared echo words and reuse CJK tokenization', () => {
  assert.deepEqual(
    scoreWords('hello hello shared', 'echo shared echo', 'hello shared echo echo echo'),
    {
      voiceWords: 3,
      voiceKept: 2,
      echoWords: 2,
      echoRemaining: 2,
      ambiguousEchoWords: 1,
    },
  );
  const chinese = scoreWords('保留用户声音', '去掉会议回声', '保留用户声音');
  assert.equal(chinese.voiceKept, chinese.voiceWords);
  assert.equal(chinese.echoRemaining, 0);
  const empty = aggregateScores([{ ...scoreWords('', '', ''), ...signalSums([], []) }]);
  assert.equal(empty.voiceShare, null);
  assert.equal(empty.correlation, null);
  assert.equal(empty.voiceEnergyDb, null);
});

test('energy measures the known voice component and aggregation weights words and signal power', () => {
  const voice = Int16Array.of(1000, -1000, 1000, -1000);
  const output = Int16Array.of(1000, 0, 1000, 0); // half the voice plus orthogonal residual echo
  const scores = [
    { ...scoreWords('alpha bravo', 'remote echo', 'alpha remote'), ...signalSums(voice, output) },
    { ...scoreWords('charlie', 'remote echo', 'charlie'), ...signalSums(voice, output) },
  ];
  const result = aggregateScores(scores);
  assert.equal(result.blocks, 2);
  close(result.voiceShare, 2 / 3);
  close(result.echoShare, 1 / 4);
  close(result.voiceEnergyDb, 20 * Math.log10(0.5));
  close(result.outputEnergyDb, 10 * Math.log10(0.5));
  close(result.correlation, Math.SQRT1_2);
  const dry = aggregateScores([signalSums(voice, voice)]);
  close(dry.voiceEnergyDb, 0);
  close(dry.correlation, 1);
  assert.throws(() => signalSums(voice, []), /unaligned/);
});

test('exact-zero runs cross streaming boundaries, ignore shorter runs and preserve input state', () => {
  const first = Int16Array.from([1, ...Array(900).fill(0)]);
  const a = zeroRuns(first, undefined, { final: false });
  assert.deepEqual(a.runs, []);
  const b = zeroRuns(
    Int16Array.from([...Array(700).fill(0), 1, ...Array(1599).fill(0), 2]),
    a.state,
  );
  assert.deepEqual(b.runs, [[1, 1601]]);
  assert.deepEqual(a.state, { position: 901, from: 1 });
  assert.deepEqual(zeroRuns(new Int16Array(1600)).runs, [[0, 1600]]);
  assert.deepEqual(zeroRuns(Int16Array.of(1, 0, 1)).runs, []);
});

test('convergence ignores silent reference and reset-straddling bins; missing convergence stays null', () => {
  const rows = [
    [1, -20, -40, -20],
    [2, -20, -40, -90],
    [3, -20, -25, -20],
    [4, -20, -35, -20],
    [5, -20, -40, -20],
    [6, -20, -25, -20],
  ];
  const result = convergence(rows, [
    [1, 1.5],
    [5.1, 5.5],
  ]);
  close(result[0].seconds, 3.9);
  assert.equal(result[0].activeSeconds, 2);
  assert.equal(result[1].seconds, null);
  assert.equal(result[1].activeSeconds, 1);
  assert.equal(convergence([], [[0, 0.1]])[0].seconds, null);
});

test('CPU uses native cpuSeconds and weights by audio seconds', () => {
  assert.deepEqual(
    cpuTotals([
      { processedSamples: 32000, cpuSeconds: 0.2 },
      { processedSamples: 16000, cpuSeconds: 0.4 },
    ]),
    {
      audioSeconds: 3,
      processSeconds: 0.6000000000000001,
      perAudioSecond: 0.20000000000000004,
    },
  );
  assert.equal(cpuTotals([]).perAudioSecond, null);
});

test('PCM WAV preserves exact-zero padding and signed samples', () => {
  const samples = Int16Array.of(-32768, -1, 0, 32767);
  const wav = pcmWav(samples);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), 8);
  assert.deepEqual(
    Array.from({ length: 4 }, (_, i) => wav.readInt16LE(44 + i * 2)),
    [...samples],
  );
});

test('scripts import safely and help returns before opening even a nonexistent notebook', (t) => {
  const directory = fixture(t);
  for (const script of ['aec-eval', 'echo-eval']) {
    const path = resolve(`scripts/${script}.mjs`);
    const imported = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(path)})`],
      { encoding: 'utf8' },
    );
    assert.equal(imported, '');
    const help = execFileSync(
      process.execPath,
      [path, '--help', '--notebook', join(directory, 'missing.sqlite')],
      { encoding: 'utf8' },
    );
    assert.match(help, /Usage:/);
  }
  assert.equal(options([]).jobs, 1);
  assert.equal(options(['--jobs', '4']).jobs, 4);
  for (const value of ['0', '5', '1.5', 'NaN']) assert.throws(() => options(['--jobs', value]));
  assert.throws(() => options(['--unknown']));
});

test('shared two-track discovery keeps echo-eval labels and --only filtering', () => {
  const meetings = [
    {
      id: 'private',
      recordings: [{ id: 'one' }, { id: 'two' }],
      transcript: ['one', 'two'].flatMap((recordingId) =>
        ['microphone', 'system'].map((source) => ({ recordingId, source, text: 'private' })),
      ),
    },
  ];
  assert.deepEqual(
    sessions(meetings).map((s) => s.label),
    ['M1a', 'M1b'],
  );
  assert.deepEqual(
    sessions(meetings, ['M1b']).map((s) => s.recording.id),
    ['two'],
  );
});

test('recognition sends explicit AEC modes; evaluator always requests off for processed audio', async (t) => {
  const directory = fixture(t),
    helper = join(directory, 'fake-helper');
  writeFileSync(
    helper,
    `#!/usr/bin/env node
console.log(JSON.stringify({type:'ready'}));
process.stdin.once('data', data => {
 const command = JSON.parse(data);
 console.log(JSON.stringify({type:'retranscription-completed',segments:[{text:command.echoCancellation,source:command.tracks[0].source}]}));
});
`,
  );
  chmodSync(helper, 0o700);
  for (const [mode, expected] of [
    [undefined, 'auto'],
    ['on', 'auto'],
    ['off', 'off'],
  ]) {
    const rows = await recognizeTracks({
      helper,
      recordingId: 'fixture',
      locales: ['en-US'],
      tracks: [{ source: 'microphone', path: '/unused' }],
      echoCancellation: aecMode(mode),
    });
    assert.equal(rows[0].text, expected);
  }
  assert.throws(() => aecMode('auto'));
  const rows = await recognizeTracks({
    helper,
    recordingId: 'fixture',
    locales: ['en-US'],
    tracks: [{ source: 'microphone', path: '/unused' }],
  });
  assert.equal(rows[0].text, 'off');
});

test('numbers output is private, append-only, and rejects notebook and WAV aliases', (t) => {
  const dir = fixture(t),
    notebook = join(dir, 'source.json'),
    output = join(dir, 'numbers.jsonl');
  writeFileSync(notebook, 'private source');
  const writer = numbersOutput(output, notebook);
  writer.write('{"blocks":1}');
  writer.close();
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(readFileSync(output, 'utf8'), '{"blocks":1}\n');
  const append = numbersOutput(output, notebook);
  append.write('{"blocks":2}');
  append.close();
  assert.equal(readFileSync(output, 'utf8'), '{"blocks":1}\n{"blocks":2}\n');
  assert.throws(() => numbersOutput(notebook, notebook));
  for (const [name, make] of [
    ['hard.jsonl', linkSync],
    ['link.jsonl', symlinkSync],
  ]) {
    const path = join(dir, name);
    make(notebook, path);
    assert.throws(() => numbersOutput(path, notebook));
  }
  assert.throws(() => numbersOutput(join(dir, 'microphone.wav'), notebook));
  assert.equal(readFileSync(notebook, 'utf8'), 'private source');
});
