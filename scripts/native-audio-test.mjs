import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some((arg) => !['--recognize', '--long', '--streamed'].includes(arg))) {
  console.error('Usage: node scripts/native-audio-test.mjs [--long] [--recognize [--streamed]]');
  process.exit(2);
}
const recognize = args.includes('--recognize');
const streamed = args.includes('--streamed');
if (streamed && !recognize) {
  console.error('--streamed requires --recognize');
  process.exit(2);
}
const repetitions = args.includes('--long') ? 3 : 1;
const budgetSeconds = repetitions > 1 ? 180 : 90;
const deadline = Date.now() + budgetSeconds * 1000;
const reportDir = join(
  root,
  'output/native-audio',
  `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`,
);
const helper = join(root, 'native/bin/StillnoteCapture');
const report = {
  status: 'running',
  startedAt: new Date().toISOString(),
  recognitionRequested: recognize,
  streamingRecognizerRequested: streamed,
  realStreamingRecognizerTested: false,
  longFixtureRequested: repetitions > 1,
  budgetSeconds,
  liveMicrophoneTested: false,
  liveSystemAudioTested: false,
  networkOrModelCallsRequested: false,
  reportDir,
};
let temporary;

function run(command, commandArgs) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error) rejectRun(error);
      else resolveRun(result);
    };
    const timer = setTimeout(
      () => {
        child.kill('SIGKILL');
        finish(
          new Error(`Timed out running ${command} within the ${budgetSeconds} second test budget`),
        );
      },
      Math.max(1, deadline - Date.now()),
    );
    child.on('error', (error) => finish(error));
    child.stdin.on('error', (error) => finish(error));
    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (stdout.length > 2_000_000) return finish(new Error('Native helper output exceeded 2 MB'));
    });
    child.stderr.on('data', (data) => {
      stderr = (stderr + data.toString()).slice(-8000);
    });
    child.on('close', (code, signal) => {
      if (code !== 0)
        finish(new Error(`${command} exited code=${code}, signal=${signal}: ${stderr}`));
      else finish(null, stdout);
    });
    child.stdin.end();
  });
}

async function recognizeFile(path, recordingId) {
  // LaunchServices gives this dedicated application its own TCC identity. Direct
  // spawning from Node attributes Speech access to the host application instead.
  const app = join(reportDir, 'Stillnote Audio Test.app');
  const contents = join(app, 'Contents');
  const executable = join(contents, 'MacOS', 'StillnoteCapture');
  const resultPath = join(reportDir, 'recognition-events.jsonl');
  await mkdir(dirname(executable), { recursive: true });
  await copyFile(helper, executable);
  await writeFile(
    join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.stillnote.audio-test</string>
<key>CFBundleName</key><string>Stillnote Audio Test</string>
<key>CFBundleDisplayName</key><string>Stillnote Audio Test</string>
<key>CFBundleExecutable</key><string>StillnoteCapture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>NSSpeechRecognitionUsageDescription</key><string>Stillnote Audio Test checks transcription accuracy using only synthetic prerecorded speech.</string>
</dict></plist>\n`,
  );
  await run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  report.recognitionLaunch = {
    app,
    bundleId: 'local.stillnote.audio-test',
    resultPath,
    permissionMayBeRequested: true,
  };
  await run('/usr/bin/open', [
    '-n',
    app,
    '--args',
    '--transcribe-file',
    path,
    '--result',
    resultPath,
    '--recording-id',
    recordingId,
    '--locale',
    'en-US',
    ...(streamed ? ['--streamed'] : []),
  ]);
  while (Date.now() < deadline) {
    let data = '';
    try {
      data = await readFile(resultPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    assert.ok(data.length <= 2_000_000, 'Recognition event log exceeded 2 MB');
    const events = data.split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    report.recognitionEvents = events;
    const ready = events.find((event) => event.type === 'ready');
    if (ready?.pid) report.recognitionLaunch.pid = ready.pid;
    const result = events.find(
      (event) =>
        event.recordingId === recordingId &&
        ['retranscription-completed', 'retranscription-error'].includes(event.type),
    );
    if (result?.type === 'retranscription-error')
      throw new Error(
        `Recognition failed: ${result.error || result.message || JSON.stringify(result)}`,
      );
    if (result) return result;
    await delay(Math.min(200, Math.max(1, deadline - Date.now())));
  }
  report.recognitionLaunch.permissionOrCompletionPending = true;
  throw new Error(
    `Recognition did not complete within the ${budgetSeconds} second test budget. A Speech Recognition permission prompt may still be pending. The dedicated test application and event log are preserved in the report directory; no unrelated process was terminated.`,
  );
}

function extended80(data, offset) {
  const exponent = data.readUInt16BE(offset);
  const mantissa = Number(data.readBigUInt64BE(offset + 2));
  return (exponent & 0x8000 ? -1 : 1) * mantissa * 2 ** ((exponent & 0x7fff) - 16383 - 63);
}

function inputInfo(data) {
  assert.equal(data.toString('ascii', 0, 4), 'FORM', 'Input must be AIFF');
  assert.ok(['AIFF', 'AIFC'].includes(data.toString('ascii', 8, 12)), 'Input must be AIFF or AIFC');
  for (let at = 12; at + 8 <= data.length;) {
    const name = data.toString('ascii', at, at + 4);
    const size = data.readUInt32BE(at + 4);
    if (name === 'COMM') {
      const channels = data.readUInt16BE(at + 8);
      const frames = data.readUInt32BE(at + 10);
      const sampleRate = extended80(data, at + 16);
      return { channels, frames, sampleRate, duration: frames / sampleRate };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('AIFF lacks a COMM chunk');
}

function wavInfo(data) {
  assert.equal(data.toString('ascii', 0, 4), 'RIFF');
  assert.equal(data.toString('ascii', 8, 12), 'WAVE');
  let format;
  let samples;
  for (let at = 12; at + 8 <= data.length;) {
    const name = data.toString('ascii', at, at + 4);
    const size = data.readUInt32LE(at + 4);
    assert.ok(at + 8 + size <= data.length, `Truncated WAV ${name} chunk`);
    if (name === 'fmt ') {
      format = {
        encoding: data.readUInt16LE(at + 8),
        channels: data.readUInt16LE(at + 10),
        sampleRate: data.readUInt32LE(at + 12),
        blockAlign: data.readUInt16LE(at + 20),
        bits: data.readUInt16LE(at + 22),
      };
      if (format.encoding === 0xfffe && size >= 40) format.encoding = data.readUInt16LE(at + 32);
    }
    if (name === 'data') samples = data.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  assert.ok(format && samples?.length, 'WAV must contain format and nonempty audio');
  assert.equal(format.channels, 1, 'Output must be mono');
  assert.equal(format.sampleRate, 16000, 'Output must be 16 kHz');
  assert.ok(
    (format.encoding === 1 && [16, 24, 32].includes(format.bits)) ||
      (format.encoding === 3 && format.bits === 32),
    'Unsupported WAV sample encoding',
  );
  assert.equal(samples.length % format.blockAlign, 0, 'WAV data must contain whole sample frames');
  let squares = 0;
  let peak = 0;
  let nonzero = 0;
  for (let at = 0; at < samples.length; at += format.blockAlign) {
    const sample =
      format.encoding === 3
        ? samples.readFloatLE(at)
        : format.bits === 16
          ? samples.readInt16LE(at) / 32768
          : format.bits === 24
            ? samples.readIntLE(at, 3) / 8388608
            : samples.readInt32LE(at) / 2147483648;
    assert.ok(Number.isFinite(sample), 'WAV must contain finite samples');
    squares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    if (Math.abs(sample) > 0.0001) nonzero++;
  }
  const frames = samples.length / format.blockAlign;
  return {
    ...format,
    frames,
    duration: frames / format.sampleRate,
    bytes: data.length,
    rms: Math.sqrt(squares / frames),
    peak,
    nonzeroFraction: nonzero / frames,
  };
}

const words = (text) => text.toLowerCase().match(/[a-z]+/g) || [];

async function verifyNormalizedTracks(probe, directory, expectedDuration) {
  assert.ok(
    Array.isArray(probe.tracks) && probe.tracks.length > 0,
    'Self-test must return audio tracks',
  );
  assert.ok(
    Math.abs(probe.inputDuration - expectedDuration) <= 0.1,
    'Reported input duration must match AIFF frames',
  );
  const tracks = [];
  for (const track of probe.tracks) {
    const path = resolve(directory, track.fileName);
    const local = relative(directory, path);
    assert.ok(
      local && !local.startsWith('..') && !isAbsolute(local),
      'Track must be inside report directory',
    );
    const actual = wavInfo(await readFile(path));
    tracks.push({ source: track.source, fileName: track.fileName, ...actual });
    assert.ok(
      Math.abs(actual.duration - expectedDuration) <= 0.1,
      `${track.source}: output duration differs from input`,
    );
    assert.ok(
      Math.abs(actual.frames - Math.round(expectedDuration * 16000)) <= 1600,
      `${track.source}: sample count differs from input`,
    );
    assert.ok(
      actual.rms > 0.001 && actual.peak > 0.01 && actual.nonzeroFraction > 0.05,
      `${track.source}: output signal is silent or negligible`,
    );
    assert.equal(track.sampleRate, actual.sampleRate);
    assert.equal(track.channels, actual.channels);
    assert.equal(track.bytes, actual.bytes);
    assert.ok(Math.abs(track.duration - actual.duration) <= 1 / actual.sampleRate);
  }
  return tracks;
}

function wordErrorRate(referenceTokens, hypothesisTokens) {
  let previous = Array.from({ length: hypothesisTokens.length + 1 }, (_, index) => index);
  for (let row = 1; row <= referenceTokens.length; row++) {
    const current = [row];
    for (let column = 1; column <= hypothesisTokens.length; column++) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (referenceTokens[row - 1] === hypothesisTokens[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  const editDistance = previous[hypothesisTokens.length];
  return {
    value: editDistance / referenceTokens.length,
    editDistance,
    referenceTokens: referenceTokens.length,
    hypothesisTokens: hypothesisTokens.length,
    definition:
      'Token-level Levenshtein edit distance (insertions, deletions, substitutions) divided by reference token count. Tokens are lowercase ASCII English words with punctuation removed; brand spellings and word boundaries are unchanged.',
  };
}

try {
  assert.equal(process.platform, 'darwin', 'Native audio acceptance requires macOS');
  await mkdir(reportDir, { recursive: true });
  temporary = await mkdtemp(join(tmpdir(), 'stillnote-native-audio-'));
  const input = join(temporary, 'input.aiff');
  const fixture = join(root, 'tests/fixtures/native-speech.txt');
  const reference = (await readFile(fixture, 'utf8')).trim();
  const script = Array.from({ length: repetitions }, () => reference).join('\n\n');
  const spokenScriptPath = join(reportDir, 'spoken-script.txt');
  await writeFile(spokenScriptPath, `${script}\n`);
  await run('/usr/bin/say', [
    '-v',
    'Samantha',
    '-f',
    spokenScriptPath,
    '-o',
    input,
    '-r',
    '165',
    '--data-format=BEI16@22050',
  ]);
  report.input = inputInfo(await readFile(input));
  report.fixture = {
    source: relative(root, fixture),
    repetitions,
    spokenWords: words(script).length,
    duration: report.input.duration,
    spokenScriptPath,
  };
  if (repetitions > 1)
    assert.ok(
      report.input.duration > 60,
      'Long fixture must cross two 30-second recognition chunk boundaries',
    );
  assert.ok(
    report.input.duration > 5,
    'Synthetic speech should be long enough to detect truncation',
  );
  const stdout = await run(helper, ['--audio-self-test', input, reportDir]);
  const events = stdout.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const probe = events.find((event) => event.type === 'audio-self-test');
  assert.ok(probe, 'Helper must emit audio-self-test JSON');
  report.native = probe;
  report.tracks = await verifyNormalizedTracks(probe, reportDir, report.input.duration);

  // Hardware commonly supplies stereo 48 kHz PCM; test that conversion separately
  // while retaining the original normalized track for recognition acceptance.
  const stereoInput = join(temporary, 'input-48000-stereo.aiff');
  await run('/usr/bin/afconvert', [
    '-f',
    'AIFF',
    '-d',
    'BEI16@48000',
    '-c',
    '2',
    input,
    stereoInput,
  ]);
  const stereoInfo = inputInfo(await readFile(stereoInput));
  report.stereoNormalization = { input: stereoInfo, tracks: [] };
  assert.equal(stereoInfo.sampleRate, 48000, 'Hardware-format fixture must be 48 kHz');
  assert.equal(stereoInfo.channels, 2, 'Hardware-format fixture must be stereo');
  assert.ok(
    Math.abs(stereoInfo.duration - report.input.duration) <= 0.1,
    'Stereo fixture must preserve input duration',
  );
  const stereoDir = join(reportDir, 'stereo');
  await mkdir(stereoDir, { recursive: true });
  const stereoOutput = await run(helper, ['--audio-self-test', stereoInput, stereoDir]);
  const stereoProbe = stereoOutput
    .split('\n')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    })
    .find((event) => event.type === 'audio-self-test');
  assert.ok(stereoProbe, 'Stereo self-test must emit audio-self-test JSON');
  report.stereoNormalization.native = stereoProbe;
  report.stereoNormalization.tracks = await verifyNormalizedTracks(
    stereoProbe,
    stereoDir,
    stereoInfo.duration,
  );
  report.stereoNormalization.status = 'passed';
  if (recognize) {
    const microphone = probe.tracks.find((track) => track.source === 'microphone');
    assert.ok(microphone, 'Recognition requires the microphone output track');
    const recordingId = randomUUID();
    const result = await recognizeFile(resolve(reportDir, microphone.fileName), recordingId);
    if (streamed) {
      assert.equal(result.streamed, true, 'Native helper must confirm the live streaming path');
      if (repetitions > 1) {
        assert.ok(
          new Set((result.segments ?? []).map((segment) => segment.segmentId)).size >= 2,
          'Long streaming test must cross a recognition-window boundary',
        );
      }
    }
    assert.ok(
      Array.isArray(result.segments) && result.segments.length > 0,
      'Recognition must produce segments',
    );
    const transcript = result.segments.map((segment) => segment.text).join(' ');
    const spoken = words(script);
    const recognized = words(transcript);
    const keywords = [
      'recording',
      'project',
      'design',
      'proposal',
      'friday',
      'audio',
      'pipeline',
      'results',
      'monday',
      'meeting',
      'customer',
      'feedback',
      'calendar',
      'integration',
      'transcription',
      'priorities',
      'notes',
      'timestamps',
      'private',
      'local',
      'storage',
    ];
    const found = new Set(recognized);
    const matched = keywords.filter((keyword) => found.has(keyword));
    report.recognition = {
      ...result,
      transcript,
      spokenWords: spoken.length,
      recognizedWords: recognized.length,
      wordCountRatio: recognized.length / spoken.length,
      keywordRecall: matched.length / keywords.length,
      matchedKeywords: matched,
      missingKeywords: keywords.filter((keyword) => !found.has(keyword)),
      wordErrorRate: wordErrorRate(spoken, recognized),
    };
    assert.ok(
      report.recognition.keywordRecall >= 0.7,
      'Recognition keyword recall must be at least 70%',
    );
    assert.ok(
      report.recognition.wordCountRatio >= 0.75 && report.recognition.wordCountRatio <= 1.5,
      'Recognized word count must be 75–150% of the script',
    );
    assert.ok(
      report.recognition.wordErrorRate.value <= 0.25,
      'Recognition word error rate must be at most 25%',
    );
    report.realStreamingRecognizerTested = streamed;
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        status: report.status,
        report: join(reportDir, 'report.json'),
        duration: report.fixture?.duration,
        recognitionRequested: report.recognitionRequested,
        streamingRecognizerRequested: report.streamingRecognizerRequested,
        realStreamingRecognizerTested: report.realStreamingRecognizerTested,
        recognizedWords: report.recognition?.recognizedWords,
        spokenWords: report.recognition?.spokenWords,
        keywordRecall: report.recognition?.keywordRecall,
        wordErrorRate: report.recognition?.wordErrorRate,
        error: report.error,
      },
      null,
      2,
    ),
  );
}
