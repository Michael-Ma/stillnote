#!/usr/bin/env node
// Private, numbers-only AEC evaluation. The notebook is read-only; recognition text lives only
// in memory. WAVs live in a 0700 os.tmpdir() directory, removed in finally, including on failure.
//
//   node scripts/aec-eval.mjs [--notebook path] [--only M2,M9b] [--out numbers.jsonl] [--jobs 1]
//
// Cost: at most 40 double-talk blocks per recording AND per run. Each has 8 s of echo warm-up
// and 6 s of speech, at natural level and -8 dB: 9 six-second recognition passes (echo baseline
// plus four variants at each level). At most 3600 s of DSP input per run, including up to eight
// bounded restart windows per recording. A 25-minute wall deadline stops new work and bounds
// in-flight helpers. --jobs (1..4, default 1) limits simultaneous blocks/recognizers.
// These are bounded samples, not a replay of an entire meeting. Counts include skipped work.
//
// Words use own-lines.mjs tokenization (CJK bigrams); matching respects repeated word counts.
// Echo words shared with voice-alone are ambiguous and excluded. Voice energy is the component
// projected onto the known voice; total output energy and correlation expose residual echo.
import { execFile } from 'node:child_process';
import {
  chmodSync,
  constants,
  fstatSync,
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { defaultAudio, onlyEcho } from '../app/echo-audio.mjs';
import { words } from '../app/own-lines.mjs';
import { recordingDirectory, trackLevels } from '../app/recordings.mjs';
import { readNotebook, recognizeTracks, sessions } from './echo-eval.mjs';

const rate = 16000;
const warmup = 8;
const speech = 6;
const maxBlocks = 40;
const maxDSPSeconds = 3600;
const wallSeconds = 25 * 60;
const db = (power) => 10 * Math.log10(Math.max(power, 1e-12));
const total = (values) => values.reduce((sum, n) => sum + n, 0);
const evenly = (items, cap) =>
  items.length <= cap
    ? items
    : Array.from({ length: cap }, (_, i) => items[Math.floor(((i + 0.5) * items.length) / cap)]);

function spanPower(track, from, to) {
  const first = Math.round((from - track.start) * 100);
  const last = Math.round((to - track.start) * 100);
  return first < 0 || last > track.power.length ? [] : track.power.slice(first, last);
}
const loudDB = (power) => {
  const sorted = [...power].sort((a, b) => b - a);
  const loud = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 4)));
  return loud.length ? db(total(loud) / loud.length) : -120;
};

// Tracks use app/echo-audio.mjs's { start, power } representation, including timeline offsets.
export function selectBlocks(
  microphone,
  system,
  { blockSeconds = warmup + speech, voiceSeconds = speech, cap = maxBlocks } = {},
) {
  const from = Math.ceil(Math.max(microphone.start, system.start) + 1);
  const to =
    Math.min(
      microphone.start + microphone.power.length / 100,
      system.start + system.power.length / 100,
    ) - 1;
  const voice = [],
    echo = [];
  for (let start = from; start + voiceSeconds <= to; start += voiceSeconds) {
    const mic = spanPower(microphone, start, start + voiceSeconds);
    // Leave a room tail on both sides; reference below -55 dB throughout, not just on average.
    const ref = spanPower(system, start - 0.55, start + voiceSeconds + 0.55);
    if (
      ref.length &&
      ref.every((v) => db(v) < -55) &&
      loudDB(mic) >= -40 &&
      mic.filter((v) => db(v) >= -45).length >= mic.length / 4
    )
      voice.push({ from: start, to: start + voiceSeconds, db: loudDB(mic) });
  }
  const quietVoice = voice.length
    ? [...voice].sort((a, b) => a.db - b.db)[Math.floor(voice.length * 0.1)].db
    : -30;
  for (let start = from; start + blockSeconds <= to; start += blockSeconds) {
    const mic = spanPower(microphone, start, start + blockSeconds);
    const ref = spanPower(system, start, start + blockSeconds);
    const playing = ref.filter((v) => db(v) >= defaultAudio.playing).length;
    if (playing < ref.length * defaultAudio.share || loudDB(mic) < Math.max(-40, quietVoice - 10))
      continue;
    if (
      onlyEcho(microphone, system, [start, start + blockSeconds], [[start, start + blockSeconds]], {
        follows: 0.9,
        shape: 0.9,
      })
    )
      echo.push({ from: start, to: start + blockSeconds });
  }
  return {
    echo: evenly(echo, cap),
    voice: evenly(voice, cap),
    echoCandidates: echo.length,
    voiceCandidates: voice.length,
  };
}

// PCM16 in and out. Keep natural levels; callers skip any mix that would clip.
export function mixBlock(echo, voice, { levelDb = 0, lead = 0 } = {}) {
  if (lead < 0 || lead + voice.length > echo.length) throw new Error('voice does not fit block');
  const mixed = new Int16Array(echo);
  const scaled = Int16Array.from(voice, (v) => Math.round(v * 10 ** (levelDb / 20)));
  let clipped = 0;
  for (let i = 0; i < scaled.length; i++) {
    const n = echo[lead + i] + scaled[i];
    if (n < -32768 || n > 32767) clipped++;
    mixed[lead + i] = Math.max(-32768, Math.min(32767, n));
  }
  return { mixed, voice: scaled, clipped };
}

const counts = (text) => {
  const out = new Map();
  for (const word of words(text)) out.set(word, (out.get(word) ?? 0) + 1);
  return out;
};
export function scoreWords(voice, echo, output) {
  const own = counts(voice),
    far = counts(echo),
    heard = counts(output);
  const shared = (wanted) => total([...wanted].map(([w, n]) => Math.min(n, heard.get(w) ?? 0)));
  const exclusive = new Map([...far].filter(([w]) => !own.has(w)));
  return {
    voiceWords: total([...own.values()]),
    voiceKept: shared(own),
    echoWords: total([...exclusive.values()]),
    echoRemaining: shared(exclusive),
    ambiguousEchoWords: total([...far].filter(([w]) => own.has(w)).map(([, n]) => n)),
  };
}

export function signalSums(voice, output) {
  if (voice.length !== output.length) throw new Error('unaligned output');
  let voicePower = 0,
    outputPower = 0,
    cross = 0;
  for (let i = 0; i < voice.length; i++) {
    voicePower += (voice[i] / 32768) ** 2;
    outputPower += (output[i] / 32768) ** 2;
    cross += (voice[i] / 32768) * (output[i] / 32768);
  }
  return { voicePower, outputPower, cross, samples: voice.length };
}

export function aggregateScores(scores) {
  const sum = (key) => total(scores.map((s) => s[key] ?? 0));
  const voiceWords = sum('voiceWords'),
    echoWords = sum('echoWords');
  const voicePower = sum('voicePower'),
    outputPower = sum('outputPower'),
    cross = sum('cross');
  return {
    blocks: scores.length,
    voiceWords,
    voiceKept: sum('voiceKept'),
    voiceShare: voiceWords ? sum('voiceKept') / voiceWords : null,
    echoWords,
    echoRemaining: sum('echoRemaining'),
    echoShare: echoWords ? sum('echoRemaining') / echoWords : null,
    ambiguousEchoWords: sum('ambiguousEchoWords'),
    voiceEnergyDb: voicePower ? db((cross / voicePower) ** 2) : null,
    outputEnergyDb: voicePower ? db(outputPower / voicePower) : null,
    correlation: voicePower && outputPower ? cross / Math.sqrt(voicePower * outputPower) : null,
  };
}

// Streaming exact-zero detection. State is returned, never mutated; runs use sample indices.
export function zeroRuns(
  samples,
  state = { position: 0, from: null },
  { minimum = rate / 10, final = true } = {},
) {
  let { position, from } = state;
  const runs = [];
  for (const sample of samples) {
    if (sample === 0) {
      if (from === null) from = position;
    } else if (from !== null) {
      if (position - from >= minimum) runs.push([from, position]);
      from = null;
    }
    position++;
  }
  if (final && from !== null) {
    if (position - from >= minimum) runs.push([from, position]);
    from = null;
  }
  return { runs, state: { position, from } };
}

// The native reset is 0.1 s into a zero run. Use complete one-second bins after audio resumes;
// a qualifying bin's END gives an upper bound (1 s resolution), never pre-reset suppression.
export function convergence(
  timeline,
  gaps,
  { activeDb = defaultAudio.playing, end = Infinity } = {},
) {
  return gaps.map(([from, to], i) => {
    const reset = from + 0.1,
      next = gaps[i + 1]?.[0] ?? Infinity;
    const bins = timeline.filter(([t]) => t >= Math.ceil(to) && t + 1 <= Math.min(next, end));
    const active = bins.filter(([, mic, , ref]) => ref >= activeDb && mic > -100);
    const found = active.find(([, mic, output]) => mic - output >= 10);
    return {
      reset,
      resumed: to,
      observedSeconds: bins.length,
      activeSeconds: active.length,
      seconds: found ? found[0] + 1 - reset : null,
    };
  });
}

export function cpuTotals(stats) {
  const audioSeconds = total(stats.map((s) => s.processedSamples / rate));
  const processSeconds = total(stats.map((s) => s.cpuSeconds)); // Native stats use thread CPU time.
  return {
    audioSeconds,
    processSeconds,
    perAudioSecond: audioSeconds ? processSeconds / audioSeconds : null,
  };
}

export function pcmWav(samples) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
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
  buffer.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buffer.writeInt16LE(v, 44 + 2 * i));
  return buffer;
}

function readPCM(path, first, count) {
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(count * 2);
    if (readSync(fd, bytes, 0, bytes.length, 44 + first * 2) !== bytes.length)
      throw new Error('incomplete PCM');
    return Int16Array.from({ length: count }, (_, i) => bytes.readInt16LE(i * 2));
  } finally {
    closeSync(fd);
  }
}
function readSpan(track, from, to) {
  const first = Math.round((from - track.start) * rate),
    count = Math.round((to - from) * rate);
  const out = new Int16Array(count);
  const a = Math.max(0, first),
    b = Math.min(track.frames, first + count);
  if (b > a) out.set(readPCM(track.path, a, b - a), a - first);
  return out;
}
function scanGaps(track) {
  let state,
    runs = [];
  for (let at = 0; at < track.frames; at += rate * 60) {
    const more = zeroRuns(readPCM(track.path, at, Math.min(rate * 60, track.frames - at)), state, {
      final: false,
    });
    state = more.state;
    runs.push(...more.runs);
  }
  runs.push(...zeroRuns([], state).runs);
  return runs.map((run) => run.map((n) => track.start + n / rate));
}

export function options(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      notebook: { type: 'string' },
      only: { type: 'string' },
      out: { type: 'string' },
      jobs: { type: 'string', default: '1' },
      help: { type: 'boolean' },
    },
  });
  const jobs = Number(values.jobs);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 4) throw new Error('--jobs must be 1..4');
  return { ...values, jobs };
}

// Refuse aliases of private sources; never append numbers to the notebook or a recording.
export function numbersOutput(path, notebook) {
  if (!path) return { write() {}, close() {} };
  if (/\.(?:sqlite|sqlite3|db|wav)$/i.test(path)) throw new Error('invalid numbers output');
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const target = fstatSync(fd),
      source = statSync(notebook);
    if (
      !target.isFile() ||
      target.nlink !== 1 ||
      (target.dev === source.dev && target.ino === source.ino)
    )
      throw new Error('invalid numbers output');
    return { write: (line) => writeSync(fd, line + '\n'), close: () => closeSync(fd) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const config = options(argv);
  if (config.help) {
    console.log(
      'Usage: node scripts/aec-eval.mjs [--notebook path] [--only M2,M9b] [--out numbers.jsonl] [--jobs 1..4]',
    );
    return;
  }
  const notebook = resolve(
    config.notebook ?? join(homedir(), 'Library/Application Support/Stillnote/notebook.sqlite'),
  );
  const before = readNotebook(notebook),
    all = sessions(before.meetings, config.only?.split(','));
  const helper = resolve(import.meta.dirname, '../native/bin/StillnoteCapture');
  const deadline = Date.now() + wallSeconds * 1000;
  let usedBlocks = 0,
    usedDSP = 0;
  const expired = () => Date.now() >= deadline;
  const timeout = (limit) => Math.max(1, Math.min(limit, deadline - Date.now()));
  const directory = mkdtempSync(join(tmpdir(), 'stillnote-aec-eval-'));
  let output;
  const report = (numbers) => {
    const line = JSON.stringify(numbers);
    console.log(line);
    output.write(line);
  };
  const totals = [];
  try {
    chmodSync(directory, 0o700);
    output = numbersOutput(config.out, notebook);
    for (const session of all) {
      if (expired()) break;
      const result = {
        label: session.label,
        failed: 0,
        clipped: 0,
        blocks: 0,
        levels: {},
        convergence: {},
        cpu: {},
      };
      const scores = { 0: {}, '-8': {} },
        stats = { full: [], linear: [] };
      const work = mkdtempSync(join(directory, 'recording-'));
      try {
        const originalDir = recordingDirectory(
          dirname(notebook),
          session.meeting.id,
          session.recording.id,
        );
        const track = (source) => {
          const saved = session.recording.tracks.find((t) => t.source === source);
          const path = join(originalDir, source + '.wav'),
            start = saved.startOffset ?? 0;
          const levels = trackLevels(path, start)();
          if (!levels) throw new Error('noncanonical WAV');
          return { ...levels, path, frames: Math.floor((statSync(path).size - 44) / 2) };
        };
        const mic = track('microphone'),
          ref = track('system');
        const selected = selectBlocks(mic, ref);
        result.echoCandidates = selected.echoCandidates;
        result.voiceCandidates = selected.voiceCandidates;
        const pairs = selected.voice.length ? selected.echo.slice(0, maxBlocks - usedBlocks) : [];
        const locales = session.recording.locales?.length
          ? session.recording.locales
          : [session.recording.locale ?? 'en-US'];
        const transcribe = async (path) => {
          if (expired()) throw new Error('deadline');
          const rows = await recognizeTracks({
            helper,
            recordingId: session.recording.id,
            locales,
            tracks: [{ source: 'microphone', path, startOffset: 0 }],
            echoCancellation: 'off',
            timeout: timeout(90000),
          });
          return rows.map((row) => row.text).join(' ');
        };
        const aec = (microphone, reference, output, linear, from = 0) =>
          new Promise((done, fail) => {
            if (expired()) return fail(new Error('deadline'));
            const args = [
              '--aec-file',
              microphone,
              '--reference',
              reference,
              '--mic-offset',
              String(from),
              '--reference-offset',
              String(from),
              '--out',
              output,
              ...(linear ? ['--linear'] : []),
            ];
            execFile(
              helper,
              args,
              { timeout: timeout(60000), killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
              (error, stdout) => {
                if (error) return fail(new Error('AEC failed'));
                try {
                  const numbers = JSON.parse(stdout);
                  if (
                    numbers.errors !== 0 ||
                    !Number.isFinite(numbers.cpuSeconds) ||
                    !Number.isFinite(numbers.processedSamples) ||
                    !Array.isArray(numbers.seconds)
                  )
                    throw new Error('invalid stats');
                  done(numbers);
                } catch {
                  fail(new Error('invalid AEC result'));
                }
              },
            );
          });
        let cursor = 0;
        const workers = await Promise.allSettled(
          Array.from({ length: config.jobs }, async () => {
            while (cursor < pairs.length && !expired()) {
              const index = cursor++,
                block = pairs[index],
                user = selected.voice[index % selected.voice.length];
              const cost = 4 * (block.to - block.from);
              if (usedDSP + cost > maxDSPSeconds) break;
              usedBlocks++;
              usedDSP += cost;
              const dir = mkdtempSync(join(work, 'block-'));
              try {
                const echo = readSpan(mic, block.from, block.to),
                  voice = readSpan(mic, user.from, user.to);
                const reference = join(dir, 'reference.wav'),
                  echoFile = join(dir, 'echo.wav');
                writeFileSync(reference, pcmWav(readSpan(ref, block.from, block.to)), {
                  mode: 0o600,
                });
                writeFileSync(echoFile, pcmWav(echo.subarray(warmup * rate)), { mode: 0o600 });
                const echoText = await transcribe(echoFile);
                let measured = 0;
                for (const level of [0, -8]) {
                  const mix = mixBlock(echo, voice, { levelDb: level, lead: warmup * rate });
                  if (mix.clipped) {
                    result.clipped++;
                    continue;
                  }
                  const input = join(dir, 'mixed.wav'),
                    voiceFile = join(dir, 'voice.wav');
                  writeFileSync(input, pcmWav(mix.mixed), { mode: 0o600 });
                  writeFileSync(voiceFile, pcmWav(mix.voice), { mode: 0o600 });
                  const voiceText = await transcribe(voiceFile);
                  const levelScores = {};
                  for (const variant of ['voice', 'mix', 'full', 'linear']) {
                    let samples = mix.voice,
                      text = voiceText;
                    if (variant !== 'voice') {
                      let path = input;
                      if (variant !== 'mix') {
                        path = join(dir, 'processed.wav');
                        const numbers = await aec(input, reference, path, variant === 'linear');
                        stats[variant].push(numbers);
                      }
                      samples =
                        variant === 'mix'
                          ? mix.mixed.subarray(warmup * rate)
                          : readPCM(path, warmup * rate, voice.length);
                      const target = join(dir, 'target.wav');
                      writeFileSync(target, pcmWav(samples), { mode: 0o600 });
                      text = await transcribe(target);
                    }
                    levelScores[variant] = {
                      ...scoreWords(voiceText, echoText, text),
                      ...signalSums(mix.voice, samples),
                    };
                  }
                  for (const [variant, score] of Object.entries(levelScores))
                    (scores[level][variant] ??= []).push(score);
                  measured++;
                }
                if (measured) result.blocks++;
              } catch {
                result.failed++;
              } finally {
                rmSync(dir, { recursive: true, force: true });
              }
            }
          }),
        );
        result.failed += workers.filter((worker) => worker.status === 'rejected').length;
        const gaps = scanGaps(mic);
        result.resets = gaps.length;
        // Keep the whole gap (so reset detection stays exact), 8 s before and 20 s after it.
        // Long gaps that cannot fit the per-run budget are counted but not processed.
        for (const gap of evenly(gaps, 8)) {
          const from = Math.max(mic.start, Math.floor(gap[0] - warmup));
          const to = Math.min(mic.start + mic.frames / rate, Math.ceil(gap[1] + 20));
          const cost = 2 * (to - from);
          if (expired()) break;
          if (cost > 120 || usedDSP + cost > maxDSPSeconds) continue;
          usedDSP += cost;
          const input = join(work, 'restart-mic.wav'),
            reference = join(work, 'restart-ref.wav');
          writeFileSync(input, pcmWav(readSpan(mic, from, to)), { mode: 0o600 });
          writeFileSync(reference, pcmWav(readSpan(ref, from, to)), { mode: 0o600 });
          for (const variant of ['full', 'linear']) {
            const numbers = await aec(
              input,
              reference,
              join(work, 'restart-out.wav'),
              variant === 'linear',
              from,
            );
            stats[variant].push(numbers);
            const localGaps = gaps.filter(([a, b]) => a >= from && b <= to);
            const measured = convergence(numbers.seconds, localGaps, { end: to }).find(
              (r) => Math.abs(r.resumed - gap[1]) < 1 / rate,
            );
            if (measured) (result.convergence[variant] ??= []).push(measured);
          }
        }
        // Even without eligible double talk/restarts, measure CPU on a bounded raw window.
        if (!stats.full.length && !expired() && usedDSP + 120 <= maxDSPSeconds) {
          const from = Math.max(mic.start, ref.start),
            to = Math.min(from + 60, mic.start + mic.frames / rate, ref.start + ref.frames / rate);
          if (to > from) {
            usedDSP += 2 * (to - from);
            const input = join(work, 'cpu-mic.wav'),
              reference = join(work, 'cpu-ref.wav');
            writeFileSync(input, pcmWav(readSpan(mic, from, to)), { mode: 0o600 });
            writeFileSync(reference, pcmWav(readSpan(ref, from, to)), { mode: 0o600 });
            for (const variant of ['full', 'linear'])
              stats[variant].push(
                await aec(input, reference, join(work, 'cpu-out.wav'), variant === 'linear', from),
              );
          }
        }
        result.blocksSkipped = selected.echoCandidates - result.blocks;
      } catch {
        result.failed++;
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      result.resetsSkipped =
        (result.resets ?? 0) -
        Math.min(result.convergence.full?.length ?? 0, result.convergence.linear?.length ?? 0);
      for (const level of [0, -8])
        result.levels[level] = Object.fromEntries(
          Object.entries(scores[level]).map(([variant, rows]) => [variant, aggregateScores(rows)]),
        );
      for (const variant of ['full', 'linear']) result.cpu[variant] = cpuTotals(stats[variant]);
      totals.push({ result, scores, stats });
      report(result);
    }
    const summary = {
      label: 'all',
      recordings: totals.length,
      recordingsSkipped: all.length - totals.length,
      blocks: total(totals.map((t) => t.result.blocks)),
      failed: total(totals.map((t) => t.result.failed)),
      clipped: total(totals.map((t) => t.result.clipped)),
      attemptedBlocks: usedBlocks,
      budgetDSPSeconds: usedDSP,
      deadlineReached: Number(expired()),
      levels: {},
      cpu: {},
    };
    for (const level of [0, -8])
      summary.levels[level] = Object.fromEntries(
        ['voice', 'mix', 'full', 'linear'].map((variant) => [
          variant,
          aggregateScores(totals.flatMap((t) => t.scores[level][variant] ?? [])),
        ]),
      );
    for (const variant of ['full', 'linear'])
      summary.cpu[variant] = cpuTotals(totals.flatMap((t) => t.stats[variant]));
    summary.notebookChanged = Number(readNotebook(notebook).fingerprint !== before.fingerprint);
    report(summary);
  } finally {
    try {
      output?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('AEC evaluation failed. Check options and local helper availability.');
    process.exitCode = 1;
  });
}
