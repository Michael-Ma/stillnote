// Opt-in evaluation of Auto language on synthetic speech: macOS voices read Chinese, English,
// alternating and code-switched sentences; the real helper transcribes each fixture once per
// candidate language; the arbiter picks per sentence. Reports per-sentence language accuracy and
// CER (Chinese) / WER (English) for each fixed language and for Auto. Nothing leaves this Mac.
//   node scripts/language-eval.mjs [--locales zh-CN,en-US] [--save-replay] [--live]
// --save-replay stores the real candidates and sentence timing in tests/fixtures, so the arbiter's
// unit test can replay genuine model output without the helper. --live streams each fixture in
// real time through the helper's recording path (second language joining late, as in a meeting)
// and replays the events with their real arrival times through the live arbiter.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { arbitrateOffline, createLiveArbiter } from '../app/language-arbiter.mjs';
import { mean, scoreSentences } from './language-score.mjs';

const root = resolve(import.meta.dirname, '..');
const helper = join(root, 'native/bin/StillnoteCapture');
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const locales = (process.argv.includes('--locales') ? arg('--locales') : 'zh-CN,en-US').split(',');
const [zhLocale, enLocale] = [
  locales.find((l) => /^zh|^yue/.test(l)) ?? locales[0],
  locales.find((l) => /^en/.test(l)) ?? locales[1],
];

const zh = [
  '今天我们主要讨论一下第四季度的招聘计划。',
  '前端还缺两个人，后端缺一个人。',
  '上周我们面试了四个候选人，有一个比较合适。',
  '终面安排在下周二，我和李总一起面。',
  '预算方面，今年的编制只剩三个。',
  '面试官培训下个月初开始。',
];
const en = [
  "Thanks for joining, let's start with the onboarding review.",
  'Three of the five testers missed the record button.',
  'We should move it into the dock next to the chat box.',
  'Priya will have the change ready for review by Wednesday.',
  'The pricing page launch is planned for the twenty eighth.',
  "Let's check the transcription costs before we lock the price.",
];
// Chinese sentences with English terms inside: Auto should keep them with Chinese.
const codeSwitch = [
  '我们下周再 review 一下这个设计。',
  '这个 feature 的 deadline 是周五。',
  '请把 roadmap 发到群里。',
];
const voices = {
  default: { zh: 'Tingting', en: 'Samantha' },
  // One speaker switching languages, as a bilingual colleague would.
  same: { zh: 'Eddy (Chinese (China mainland))', en: 'Eddy (English (US))' },
};
const line = (lang, text) => ({ lang, text });
const alternating = zh.flatMap((t, i) => [line('zh', t), line('en', en[i])]);
const fixtures = {
  chinese: { lines: zh.map((t) => line('zh', t)) },
  english: { lines: en.map((t) => line('en', t)) },
  alternating: { lines: alternating },
  'code-switch': { lines: codeSwitch.map((t) => line('zh', t)) },
  'tight-pauses': { lines: alternating, gap: 0.3 },
  'one-speaker': { lines: alternating, voice: 'same' },
};

const work = mkdtempSync(join(tmpdir(), 'stillnote-lang-'));
const out = join(root, 'output/language-eval', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(out, { recursive: true });

function pcm(path) {
  const bytes = readFileSync(path);
  let offset = 12;
  while (offset < bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4),
      size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') return bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error('No audio data in ' + path);
}
function wavFile(data) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const silence = (seconds) => Buffer.alloc(Math.round(seconds * 16000) * 2);

function build(name, { lines, gap = 0.7, voice = 'default' }) {
  const parts = [silence(0.5)];
  let at = 0.5;
  const windows = lines.map((l, i) => {
    const file = join(work, `${name}-${i}.wav`);
    execFileSync('say', [
      '-v',
      voices[voice][l.lang],
      '--file-format=WAVE',
      '--data-format=LEI16@16000',
      '-o',
      file,
      l.text,
    ]);
    const data = pcm(file);
    const seconds = data.length / 32000;
    parts.push(data, silence(gap));
    const window = { ...l, start: at, end: at + seconds };
    at += seconds + gap;
    return window;
  });
  const path = join(work, `${name}.wav`);
  writeFileSync(path, wavFile(Buffer.concat(parts)));
  return { path, windows };
}

const live = process.argv.includes('--live');
function transcribe(path) {
  const result = join(work, 'events.jsonl');
  rmSync(result, { force: true });
  execFileSync(
    helper,
    [
      '--transcribe-file',
      path,
      '--result',
      result,
      '--locales',
      locales.join(','),
      ...(live ? ['--streamed'] : []),
    ],
    { stdio: 'ignore', timeout: 300000 },
  );
  const events = readFileSync(result, 'utf8').trim().split('\n').map(JSON.parse);
  const done = events.find((e) => e.type === 'retranscription-completed');
  if (!done)
    throw new Error(events.find((e) => e.type === 'retranscription-error')?.message ?? 'No result');
  return done;
}

// The live arbiter fed the streamed events at the moments they actually arrived.
function replayLive(timeline) {
  const arbiter = createLiveArbiter({ locales, startedAt: 0 });
  const rows = new Map();
  const apply = (actions) => {
    for (const action of actions)
      if (action.type === 'segment') rows.set(action.segment.segmentId, action.segment);
  };
  let t = 0;
  for (const event of timeline) {
    for (; t < event.arrival; t += 0.25) apply(arbiter.tick(t * 1000));
    apply(
      event.type === 'language-fallback'
        ? arbiter.drop(event.source, event.locale, event.arrival * 1000)
        : arbiter.push(event, event.arrival * 1000),
    );
  }
  apply(arbiter.flush((t + 10) * 1000));
  return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp);
}

const report = { locales, fixtures: {} };
const replay = { locales, fixtures: {} };
try {
  const only = process.argv.includes('--only') ? arg('--only').split(',') : null;
  for (const [name, fixture] of Object.entries(fixtures)) {
    if (only && !only.includes(name)) continue;
    const { path, windows } = build(name, fixture);
    const done = transcribe(path);
    const candidates = done.segments;
    const modes = {
      [zhLocale]: candidates.filter((s) => s.locale === zhLocale),
      [enLocale]: candidates.filter((s) => s.locale === enLocale),
      auto: arbitrateOffline(candidates, locales),
      ...(live ? { live: replayLive(done.timeline ?? []) } : {}),
    };
    const result = {};
    for (const [mode, segments] of Object.entries(modes)) {
      const sentences = scoreSentences(windows, segments, { zh: zhLocale, en: enLocale });
      result[mode] = {
        error: mean(sentences.map((s) => s.error)),
        languageAccuracy: mean(sentences.map((s) => (s.languageCorrect ? 1 : 0))),
        sentences,
      };
    }
    // The best per-sentence selection could do: each sentence from its own language's model.
    result.oracle = {
      error: mean(
        windows.map((w, i) => result[w.lang === 'zh' ? zhLocale : enLocale].sentences[i].error),
      ),
    };
    report.fixtures[name] = { candidates, result, ...(live ? { timeline: done.timeline } : {}) };
    replay.fixtures[name] = {
      windows,
      candidates: candidates.map(
        ({ source, locale, segmentId, text, timestamp, end, confidence, runs }) => ({
          source,
          locale,
          segmentId,
          text,
          timestamp,
          end,
          confidence,
          runs,
        }),
      ),
    };
    console.log(
      `${name.padEnd(12)} ` +
        Object.entries(result)
          .map(
            ([mode, r]) =>
              `${mode}: error ${(r.error * 100).toFixed(1)}%` +
              (['auto', 'live'].includes(mode)
                ? `, language ${(r.languageAccuracy * 100).toFixed(0)}%`
                : ''),
          )
          .join(' | '),
    );
  }
  if (process.argv.includes('--save-replay'))
    writeFileSync(join(root, 'tests/fixtures/language-replay.json'), JSON.stringify(replay));
} finally {
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  rmSync(work, { recursive: true, force: true });
  console.log(`Report: ${join(out, 'report.json')}`);
}
