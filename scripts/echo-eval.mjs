#!/usr/bin/env node
// How much of the microphone's echo app/echo.mjs takes out of the user's real meetings, and whether
// any of the user's own words went with it. The meetings are private: the notebook is opened
// read-only, and only counts and decibels are ever printed.
//
//   node scripts/echo-eval.mjs                 the saved rows, which have no word timing
//   node scripts/echo-eval.mjs --audio         the saved audio recognized again, as Retry does;
//                                              the text stays in this process and is never written
//   node scripts/echo-eval.mjs --audio --levels   also compares what was cut with the audio levels
//
// Options: --notebook <path>, --only M2,M9b, --baseline <another echo.mjs to compare with>,
// --out <file> for the numbers as JSON lines.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { echoMatch, suppressEcho, timedWords } from '../app/echo.mjs';
import { arbitrateOffline } from '../app/language-arbiter.mjs';
import { words as looseWords } from '../app/own-lines.mjs';
import { recordingDirectory } from '../app/recordings.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1];
};
const flag = (name) => args.includes(name);
const dataDir = join(homedir(), 'Library/Application Support/Stillnote');
const notebook = option('--notebook', join(dataDir, 'notebook.sqlite'));
const only = option('--only')?.split(',');
const out = option('--out');
const baseline = option('--baseline') && (await import(resolve(option('--baseline'))));
const helper = join(root, 'native/bin/StillnoteCapture');
const ffmpeg = '/opt/homebrew/bin/ffmpeg';

function readNotebook() {
  const db = new DatabaseSync(notebook, { readOnly: true });
  try {
    const rows = db.prepare('SELECT id, data FROM meetings ORDER BY id').all();
    const fingerprint = createHash('sha256');
    for (const row of rows) fingerprint.update(row.id).update(row.data);
    return {
      meetings: rows.map((row) => ({ ...JSON.parse(row.data), id: row.id })),
      fingerprint: fingerprint.digest('hex'),
    };
  } finally {
    db.close();
  }
}

// Each recording with both sides, under a label that says nothing about the meeting.
function sessions(meetings) {
  const found = [];
  let index = 0;
  for (const meeting of meetings) {
    const transcript = meeting.transcript ?? [];
    if (!transcript.length) continue;
    index++;
    const twoSided = (meeting.recordings ?? []).filter((recording) => {
      const rows = transcript.filter((s) => s.recordingId === recording.id);
      return ['microphone', 'system'].every((side) => rows.some((s) => s.source === side));
    });
    twoSided.forEach((recording, i) =>
      found.push({
        label: `M${index}${twoSided.length > 1 ? 'ab'[i] : ''}`,
        meeting,
        recording,
        saved: transcript.filter((s) => s.recordingId === recording.id),
      }),
    );
  }
  return found.filter((session) => !only || only.includes(session.label));
}

function recognize({ meeting, recording }) {
  const dir = recordingDirectory(dataDir, meeting.id, recording.id);
  const locales = recording.locales?.length ? recording.locales : [recording.locale];
  const tracks = recording.tracks.map((track) => ({
    source: track.source,
    path: join(dir, track.fileName),
    startOffset: track.startOffset ?? 0,
  }));
  if (!tracks.every((track) => existsSync(track.path)))
    return Promise.reject(new Error('audio is missing'));
  return new Promise((done, fail) => {
    const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    child.on('error', fail);
    child.on('exit', (code) => fail(new Error(`helper exited with ${code}`)));
    createInterface({ input: child.stdout }).on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === 'ready')
        child.stdin.write(
          JSON.stringify({
            op: 'transcribe',
            recordingId: recording.id,
            context: [],
            locale: locales[0],
            locales,
            tracks,
          }) + '\n',
        );
      if (event.type === 'retranscription-completed') {
        child.kill();
        done(locales.length > 1 ? arbitrateOffline(event.segments, locales) : event.segments);
      }
      if (event.type === 'retranscription-error') {
        child.kill();
        fail(new Error('recognition failed'));
      }
    });
  });
}

const start = (row) => Number(row.timestamp) || 0;
const side = (rows, source) => rows.filter((s) => s.source === source);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1] : null;
};
const round = (value) => (value === null ? null : Math.round(value * 10) / 10);
const percentiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => round(sorted[Math.floor((sorted.length - 1) * p)] ?? null);
  return { n: sorted.length, p10: at(0.1), p50: at(0.5), p90: at(0.9) };
};

// A row that shares most of its words with a meeting audio row within 15 seconds. Loose: it also
// counts what people naturally repeat, which sets its floor at about 3% in meetings with no echo.
function looseEchoes(mic, system) {
  const near = (row) => system.filter((s) => Math.abs(start(s) - start(row)) <= 15);
  return mic.filter((row) => {
    const wanted = new Set(looseWords(row.text));
    if (wanted.size < 3) return false;
    return near(row).some((s) => {
      const have = new Set(looseWords(s.text));
      return [...wanted].filter((w) => have.has(w)).length / wanted.size > 0.6;
    });
  }).length;
}

// Echoed words, whatever the rows are like: how many more of the microphone's words meeting audio
// says at that very moment than it does several seconds away, where only chance puts them.
function echoedWords(mic, system) {
  const said = new Map();
  for (const row of system)
    for (const word of timedWords(row)) {
      if (word.word.length < 2) continue;
      if (!said.has(word.word)) said.set(word.word, []);
      said.get(word.word).push(word.time);
    }
  const own = mic.flatMap((row) => timedWords(row).filter((word) => word.word.length >= 2));
  const matches = (lag) =>
    own.filter((word) => said.get(word.word)?.some((t) => Math.abs(word.time - t - lag) <= 0.4))
      .length;
  const lags = Array.from({ length: 33 }, (_, i) => -8 + i / 2);
  const chance = median(lags.map(matches));
  const lag = [-0.5, -0.25, 0, 0.25, 0.5].reduce((a, b) => (matches(b) > matches(a) ? b : a));
  return { total: own.length, echoed: Math.max(0, matches(lag) - chance), lag };
}

// Every first-person word of the microphone's that meeting audio did not say within 3 seconds, as
// `time|word`: what must survive the filter.
const firstPerson =
  /我|咱|俺|(?<![\p{L}\p{N}'’])(?:i|i'm|i'd|i'll|i've|me|my|mine)(?![\p{L}\p{N}])/giu;
function ownWords(mic, system) {
  const heard = new Map();
  for (const row of system)
    for (const match of String(row.text).matchAll(firstPerson)) {
      const word = match[0].toLowerCase();
      if (!heard.has(word)) heard.set(word, []);
      heard.get(word).push(row);
    }
  const said = (word, time) =>
    heard
      .get(word)
      ?.some((row) => time >= start(row) - 3 && time <= (Number(row.end) || start(row) + 8) + 3);
  const own = new Set();
  for (const row of mic) {
    const runs =
      Array.isArray(row.runs) && row.runs.length ? row.runs : [[start(row), 0, 0, row.text]];
    for (const run of runs)
      for (const match of String(run[3]).matchAll(firstPerson)) {
        const word = match[0].toLowerCase();
        if (!said(word, Number(run[0]))) own.add(`${run[0]}|${match.index}|${word}`);
      }
  }
  return own;
}

// The same comparison with meeting audio moved far from the microphone: whatever goes here went
// by chance, not because anyone said it at that moment.
function unrelatedMatches(rows) {
  const moved = (by) =>
    rows.map((row) =>
      row.source === 'system'
        ? {
            ...row,
            timestamp: start(row) + by,
            ...(row.end ? { end: row.end + by } : {}),
            ...(row.runs
              ? { runs: row.runs.map(([a, b, ...rest]) => [a + by, b + by, ...rest]) }
              : {}),
          }
        : row,
    );
  let removed = 0,
    trimmed = 0;
  for (const by of [-90, -45, 45, 90]) {
    const result = suppressEcho(moved(by));
    removed += result.removed.length;
    trimmed += result.trimmed.length;
  }
  return { removed, trimmed };
}

// Loudness every 10 ms of a track, the only thing kept of the audio.
function loudness(path) {
  return new Promise((done, fail) => {
    const rate = 8000,
      frame = rate / 100;
    const child = spawn(
      ffmpeg,
      ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const levels = [];
    let sum = 0,
      count = 0,
      odd = null;
    child.stdout.on('data', (chunk) => {
      const bytes = odd ? Buffer.concat([odd, chunk]) : chunk;
      const usable = bytes.length & ~1;
      odd = usable < bytes.length ? bytes.subarray(usable) : null;
      for (let i = 0; i < usable; i += 2) {
        const sample = bytes.readInt16LE(i) / 32768;
        sum += sample * sample;
        if (++count === frame) {
          levels.push(sum / count);
          sum = count = 0;
        }
      }
    });
    child.on('error', fail);
    child.on('close', () => done(levels));
  });
}

// Decibels over a stretch of the recording: the loudest quarter of it, since speech comes in bursts.
function decibels(levels, offset, from, to) {
  const first = Math.max(0, Math.floor((from - offset) * 100)),
    last = Math.min(levels.length, Math.ceil((to - offset) * 100));
  const frames = levels.slice(first, last).sort((a, b) => b - a);
  const loud = frames.slice(0, Math.max(1, Math.ceil(frames.length / 4)));
  const power = loud.reduce((sum, v) => sum + v, 0) / loud.length;
  return 10 * Math.log10(Math.max(power, 1e-10));
}

// How closely the microphone's loudness follows meeting audio's over `spans`, with the microphone
// `lag` hundredths of a second later. An echo is a quieter copy of meeting audio and moves with it
// (correlation near 1); the user's own voice has nothing to do with it (near 0). The two tracks'
// clocks differ by tens of milliseconds, so this says what they share, not which came first.
function together(mic, system, offsets, spans, lag) {
  const envelope = (levels, offset, from, to) => {
    const first = Math.max(0, Math.round((from - offset) * 100));
    return Array.from(levels.slice(first, first + Math.round((to - from) * 100)), Math.sqrt);
  };
  let shared = 0,
    a = 0,
    b = 0;
  for (const { from, to } of spans) {
    const x = envelope(system, offsets[1], from, to);
    const y = envelope(mic, offsets[0], from + lag / 100, to + lag / 100);
    const n = Math.min(x.length, y.length);
    const mean = (v) => v.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
    const mx = mean(x),
      my = mean(y);
    for (let i = 0; i < n; i++) {
      shared += (x[i] - mx) * (y[i] - my);
      a += (x[i] - mx) ** 2;
      b += (y[i] - my) ** 2;
    }
  }
  return shared / Math.sqrt(a * b || 1);
}
const bestLag = (mic, system, offsets, spans) => {
  const lags = Array.from({ length: 81 }, (_, i) => i - 40);
  return lags.reduce((x, y) =>
    together(mic, system, offsets, spans, y) > together(mic, system, offsets, spans, x) ? y : x,
  );
};

// Was what went an echo, or the user's own voice? In most meetings the two are easy to tell: speech
// into the microphone is far louder than a quiet echo. With loud speakers they are about as loud,
// but an echo still moves with meeting audio. So `suspect` counts what went that was both loud
// (within 10 dB of the user's quietest speech in that meeting) and not moving with meeting audio,
// spans of words and short parts left behind alike; `lost` are first-person words, as
// `time|place|word`.
async function levelCheck({ meeting, recording }, rows, result, lost) {
  const dir = recordingDirectory(dataDir, meeting.id, recording.id);
  const track = (source) => recording.tracks.find((t) => t.source === source);
  const [mic, system] = await Promise.all(
    ['microphone', 'system'].map((source) => loudness(join(dir, track(source).fileName))),
  );
  const offsets = ['microphone', 'system'].map((source) => track(source).startOffset ?? 0);
  const span = (from, to) => ({
    from,
    to,
    mic: decibels(mic, offsets[0], from, to),
    system: decibels(system, offsets[1], from, to),
  });
  const end = (row) => Number(row.end) || start(row) + 1;
  const quiet = (row) =>
    !side(rows, 'system').some((s) => start(s) < end(row) + 1 && end(s) > start(row) - 1);
  const own = side(rows, 'microphone')
    .filter((row) => end(row) - start(row) >= 1 && quiet(row))
    .map((row) => span(start(row), end(row)));
  // What a cut took: from the end of one part to the start of the next.
  const gone = result.removed.map((row) => ({ ...span(start(row), end(row)), row, kind: 'row' }));
  for (const { row, pieces } of result.trimmed) {
    const edges = [start(row), ...pieces.flatMap((p) => [start(p), end(p)]), end(row)];
    for (let i = 0; i < edges.length; i += 2)
      if (edges[i + 1] - edges[i] >= 1)
        gone.push({ ...span(edges[i], edges[i + 1]), row, kind: 'cut' });
  }
  const ownVoice = percentiles(own.map((s) => s.mic));
  const loud = (value) => value >= (ownVoice.n ? ownVoice.p10 - 10 : -40);
  const lag = gone.length ? bestLag(mic, system, offsets, gone.slice(0, 200)) : 0;
  const moves = (s) => together(mic, system, offsets, [s], lag) >= 0.5;
  // What a suspect span is: how much of it is loud, and the delay at which it best follows meeting
  // audio by itself. The microphone well ahead of a close match is the user's voice coming back
  // from the other side of the call.
  const suspects = gone
    .filter((s) => loud(s.mic) && !moves(s))
    .map((s) => {
      const first = Math.max(0, Math.round((s.from - offsets[0]) * 100));
      const frames = mic.slice(first, first + Math.round((s.to - s.from) * 100));
      const threshold = 10 ** ((ownVoice.n ? ownVoice.p10 - 10 : -40) / 10);
      const lags = Array.from({ length: 201 }, (_, i) => i - 100);
      const own = lags.reduce((x, y) =>
        together(mic, system, offsets, [s], y) > together(mic, system, offsets, [s], x) ? y : x,
      );
      return {
        kind: s.kind,
        seconds: round(s.to - s.from),
        mic: round(s.mic),
        system: round(s.system),
        loudShare: Math.round((100 * frames.filter((v) => v >= threshold).length) / frames.length),
        lagMs: own * 10,
        follows: Math.round(100 * together(mic, system, offsets, [s], own)) / 100,
        shift: round(echoMatch(s.row, side(rows, 'system')).shift ?? null),
      };
    });
  const lostLevels = lost.map((word) => {
    const time = Number(word.split('|')[0]);
    return span(time - 0.3, time + 0.6);
  });
  const shortParts = result.trimmed
    .flatMap((t) => t.pieces)
    .filter((p) => timedWords(p).reduce((sum, w) => sum + w.weight, 0) < 3 && end(p) > start(p))
    .map((p) => span(start(p), end(p)));
  return {
    ownVoice,
    wentMic: percentiles(gone.map((s) => s.mic)),
    wentBelowMeetingAudio: percentiles(gone.map((s) => s.system - s.mic)),
    wentMoves: gone.length
      ? Math.round(100 * together(mic, system, offsets, gone, lag)) / 100
      : null,
    wentLoud: gone.filter((s) => loud(s.mic)).length,
    suspect: suspects.length,
    suspects,
    suspectSeconds: Math.round(
      gone.filter((s) => loud(s.mic) && !moves(s)).reduce((sum, s) => sum + s.to - s.from, 0),
    ),
    wentSeconds: Math.round(gone.reduce((sum, s) => sum + s.to - s.from, 0)),
    lostMic: percentiles(lostLevels.map((s) => s.mic)),
    lostSuspect: lostLevels.filter((s) => loud(s.mic) && !moves(s)).length,
    shortPartsLoud: shortParts.filter((s) => loud(s.mic) && !moves(s)).length,
  };
}

async function measure(session) {
  const rows = flag('--audio') ? await recognize(session) : session.saved;
  const mic = side(rows, 'microphone'),
    system = side(rows, 'system');
  const result = suppressEcho(rows);
  const left = side(result.segments, 'microphone');
  const own = ownWords(mic, system),
    ownAfter = ownWords(left, system);
  const lost = [...own].filter((word) => !ownAfter.has(word));
  const parts = result.trimmed.flatMap((t) => t.pieces);
  const before = echoedWords(mic, system),
    after = echoedWords(left, system);
  const old = baseline && side(baseline.suppressEcho(rows).segments, 'microphone');
  return {
    label: session.label,
    minutes: Math.round((session.recording.duration ?? 0) / 60),
    microphoneRows: mic.length,
    timedRows: mic.filter((row) => row.runs?.length).length,
    words: before.total,
    wordsPerRow: Math.round(before.total / (mic.length || 1)),
    lag: before.lag,
    looseBefore: looseEchoes(mic, system),
    looseAfter: looseEchoes(left, system),
    echoedBefore: before.echoed,
    echoedAfter: after.echoed,
    ...(old
      ? { rowsLeftBaseline: old.length, echoedBaseline: echoedWords(old, system).echoed }
      : {}),
    wordsLeft: after.total,
    rowsRemoved: result.removed.length,
    rowsTrimmed: result.trimmed.length,
    partsLeft: parts.length,
    shortParts: parts.filter((p) => timedWords(p).reduce((s, w) => s + w.weight, 0) < 3).length,
    ownWords: own.size,
    ownWordsLost: lost.length,
    unrelated: unrelatedMatches(rows),
    ...(flag('--levels') ? { levels: await levelCheck(session, rows, result, lost) } : {}),
  };
}

const before = readNotebook();
const all = sessions(before.meetings);
console.error(`${all.length} recordings with both sides`);
const totals = [];
for (const session of all) {
  const began = Date.now();
  try {
    const numbers = await measure(session);
    numbers.seconds = Math.round((Date.now() - began) / 1000);
    totals.push(numbers);
    const line = JSON.stringify(numbers);
    console.log(line);
    if (out) appendFileSync(out, line + '\n', { mode: 0o600 });
  } catch (error) {
    console.error(session.label, error.message);
  }
}
if (readNotebook().fingerprint !== before.fingerprint)
  console.error('The notebook changed while this ran: the app is in use.');
const sum = (key) => totals.reduce((total, n) => total + (n[key] ?? 0), 0);
console.log(
  JSON.stringify({
    label: 'all',
    microphoneRows: sum('microphoneRows'),
    looseBefore: sum('looseBefore'),
    looseAfter: sum('looseAfter'),
    echoedBefore: sum('echoedBefore'),
    echoedAfter: sum('echoedAfter'),
    rowsRemoved: sum('rowsRemoved'),
    rowsTrimmed: sum('rowsTrimmed'),
    ownWords: sum('ownWords'),
    ownWordsLost: sum('ownWordsLost'),
  }),
);
