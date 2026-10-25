import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { arbitrateOffline, judge, switchPoints } from '../app/language-arbiter.mjs';
import { mean, scoreSentences } from '../scripts/language-score.mjs';

// Real SpeechTranscriber output (zh-CN and en-US) for macOS-voice fixtures, saved by
// `node scripts/language-eval.mjs --save-replay`.
const replay = JSON.parse(
  readFileSync(new URL('./fixtures/language-replay.json', import.meta.url), 'utf8'),
);
const languages = { zh: 'zh-CN', en: 'en-US' };
const run = (start, end, confidence, text) => [start, end, confidence, text];

for (const [name, { windows, candidates }] of Object.entries(replay.fixtures)) {
  test(`replay ${name}: every sentence comes out in its own language`, () => {
    const auto = arbitrateOffline(candidates, replay.locales);
    const sentences = scoreSentences(windows, auto, languages);
    assert.deepEqual(
      sentences.filter((s) => !s.languageCorrect).map((s) => s.reference),
      [],
      'sentences in the wrong language',
    );
    const fixed = (lang) =>
      scoreSentences(
        windows,
        candidates.filter((s) => s.locale === languages[lang]),
        languages,
      );
    const oracle = mean(windows.map((w, i) => fixed(w.lang)[i].error));
    assert.ok(
      mean(sentences.map((s) => s.error)) <= oracle + 0.04,
      'Auto stays close to choosing each sentence perfectly',
    );
    // The transcript reads forward: no overlapping rows, no repeated ids.
    for (let i = 1; i < auto.length; i++)
      assert.ok(auto[i].timestamp >= auto[i - 1].end - 0.35, `overlap at ${auto[i].timestamp}`);
    assert.equal(new Set(auto.map((s) => s.segmentId)).size, auto.length);
  });
}

test('a phrase that switches language inside is cut at the switch', () => {
  const zh = {
    locale: 'zh-CN',
    runs: [
      run(0, 0.3, 1, '今'),
      run(0.3, 0.6, 1, '天'),
      run(0.6, 0.9, 1, '开会'),
      run(1.2, 1.5, 0.6, ' Thanks'),
      run(1.5, 1.8, 0.6, ' for'),
      run(1.8, 2.2, 0.6, ' joining'),
    ],
  };
  assert.deepEqual(switchPoints(zh), [1.05]);
  const en = {
    locale: 'en-US',
    runs: [
      run(0, 0.5, 0.2, 'Jin'),
      run(0.5, 0.9, 0.1, ' tian'),
      run(1.2, 1.5, 0.95, ' Thanks'),
      run(1.5, 1.8, 0.97, ' for'),
    ],
  };
  assert.deepEqual(switchPoints(en), [1.05]);
});

test('English terms inside a Chinese sentence do not cut it', () => {
  const zh = {
    locale: 'zh-CN',
    runs: [
      run(0, 0.3, 1, '这'),
      run(0.3, 0.6, 1, '个'),
      run(0.6, 0.8, 0.9, ' fea'),
      run(0.8, 1, 0.9, 'ture'),
      run(1, 1.2, 1, '的'),
      run(1.2, 1.6, 0.9, ' deadline'),
      run(1.6, 1.8, 1, '是'),
      run(1.8, 2, 1, '周五'),
    ],
  };
  assert.deepEqual(switchPoints(zh), []);
});

test('a phrase one language won entirely keeps its own row and id', () => {
  const zh = {
    source: 'microphone',
    locale: 'zh-CN',
    segmentId: 'zh-1',
    text: '今天开会 我们看设计',
    timestamp: 0,
    end: 4,
    confidence: 0.95,
    runs: [run(0, 1, 0.95, '今天开会'), run(2, 4, 0.95, ' 我们看设计')],
  };
  // The English model breaks at 1.5 s, which cuts the Chinese phrase in two pieces.
  const en = [
    {
      source: 'microphone',
      locale: 'en-US',
      segmentId: 'en-1',
      text: 'Jin',
      timestamp: 0,
      end: 1.5,
      confidence: 0.2,
    },
    {
      source: 'microphone',
      locale: 'en-US',
      segmentId: 'en-2',
      text: 'women',
      timestamp: 1.5,
      end: 4,
      confidence: 0.2,
    },
  ];
  const auto = arbitrateOffline([zh, ...en], ['zh-CN', 'en-US']);
  assert.deepEqual(
    auto.map((s) => [s.segmentId, s.text, s.timestamp, s.end]),
    [['zh-1', '今天开会 我们看设计', 0, 4]],
  );
});

test('speech only one language heard is kept only when it is not a guess', () => {
  const group = (confidence) => ({
    start: 0,
    end: 1,
    segments: [{ locale: 'en-US', text: 'hmm', start: 0, end: 1, confidence }],
  });
  assert.equal(judge(group(0.1), null), null);
  assert.equal(judge(group(0.8), null).locale, 'en-US');
  assert.equal(judge(group(undefined), null).locale, 'en-US', 'unknown confidence is kept');
});

test('near-ties keep the previous language, and old helpers without timing still work', () => {
  const tie = {
    start: 0,
    end: 3,
    segments: [
      { locale: 'en-US', text: 'okay okay okay', start: 0, end: 3, confidence: 0.8 },
      { locale: 'fr-FR', text: 'oké oké oké', start: 0, end: 3, confidence: 0.81 },
    ],
  };
  assert.equal(judge(tie, 'en-US').locale, 'en-US');
  assert.equal(judge(tie, 'fr-FR').locale, 'fr-FR');
  const untimed = arbitrateOffline(
    [
      { locale: 'zh-CN', segmentId: 'a', text: '你好', timestamp: 0, end: 1, confidence: 0.9 },
      { locale: 'en-US', segmentId: 'b', text: 'knee how', timestamp: 0, end: 1, confidence: 0.2 },
      {
        locale: 'zh-CN',
        segmentId: 'c',
        text: 'hello every',
        timestamp: 2,
        end: 3,
        confidence: 0.5,
      },
      {
        locale: 'en-US',
        segmentId: 'd',
        text: 'Hello everyone',
        timestamp: 2,
        end: 3,
        confidence: 0.95,
      },
    ],
    ['zh-CN', 'en-US'],
  );
  assert.deepEqual(
    untimed.map((s) => s.segmentId),
    ['a', 'd'],
  );
});

test('each source is judged on its own', () => {
  const auto = arbitrateOffline(
    [
      {
        source: 'microphone',
        locale: 'zh-CN',
        segmentId: 'm-zh',
        text: '你好',
        timestamp: 0,
        end: 1,
        confidence: 0.9,
      },
      {
        source: 'microphone',
        locale: 'en-US',
        segmentId: 'm-en',
        text: 'knee',
        timestamp: 0,
        end: 1,
        confidence: 0.1,
      },
      {
        source: 'system',
        locale: 'zh-CN',
        segmentId: 's-zh',
        text: 'hello',
        timestamp: 0,
        end: 1,
        confidence: 0.4,
      },
      {
        source: 'system',
        locale: 'en-US',
        segmentId: 's-en',
        text: 'Hello',
        timestamp: 0,
        end: 1,
        confidence: 0.97,
      },
    ],
    ['zh-CN', 'en-US'],
  );
  assert.deepEqual(auto.map((s) => s.segmentId).sort(), ['m-zh', 's-en']);
});
