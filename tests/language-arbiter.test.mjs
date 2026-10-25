import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  arbitrateOffline,
  createLiveArbiter,
  judge,
  switchPoints,
} from '../app/language-arbiter.mjs';
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

// Replays saved candidates as a live stream: each final phrase arrives a little after its audio
// ends (the Chinese model finalizes later), with ticks in between, then the recording stops.
function streamLive(candidates, locales, delay = { 'zh-CN': 1.6, 'en-US': 0.7 }) {
  const arbiter = createLiveArbiter({ locales, startedAt: 0 });
  // Each phrase updates its provisional text every second from half a second in, as the
  // transcribers do, then sends its final after the delay.
  const arrivals = candidates
    .flatMap((s) => {
      const final = (s.end ?? s.timestamp) + (delay[s.locale] ?? 1);
      const updates = [];
      // Like the real models, a growing phrase reports a later and later provisional start.
      for (let at = s.timestamp + 0.5; at < final; at += 1)
        updates.push({
          s: {
            ...s,
            type: 'partial',
            text: s.text.slice(0, 4),
            timestamp: Math.min(s.end ?? s.timestamp, s.timestamp + (at - s.timestamp) * 0.7),
          },
          at,
        });
      return [...updates, { s: { ...s, type: 'segment' }, at: final }];
    })
    .sort((a, b) => a.at - b.at);
  const rows = new Map(),
    shown = new Map();
  const apply = (actions) => {
    for (const action of actions)
      if (action.type === 'segment') rows.set(action.segment.segmentId, action.segment);
      else if (action.type === 'partial') shown.set(action.event.segmentId, action.event);
      else for (const id of action.segmentIds) shown.delete(id);
  };
  let t = 0;
  for (const { s, at } of arrivals) {
    for (; t < at; t += 0.25) apply(arbiter.tick(t * 1000));
    apply(arbiter.push(s, at * 1000));
  }
  apply(arbiter.flush((t + 10) * 1000));
  for (const id of rows.keys()) shown.delete(id);
  return { rows: [...rows.values()].sort((a, b) => a.timestamp - b.timestamp), shown };
}

for (const [name, { windows, candidates }] of Object.entries(replay.fixtures)) {
  test(`live ${name}: decides like the offline arbiter while speech streams in`, () => {
    const { rows, shown } = streamLive(candidates, replay.locales);
    const live = scoreSentences(windows, rows, languages);
    const offline = scoreSentences(
      windows,
      arbitrateOffline(candidates, replay.locales),
      languages,
    );
    assert.deepEqual(
      live.map((s) => s.locale),
      offline.map((s) => s.locale),
    );
    assert.ok(mean(live.map((s) => s.error)) <= mean(offline.map((s) => s.error)) + 0.03);
    assert.equal(shown.size, 0, 'no provisional text is left after stop');
    for (let i = 1; i < rows.length; i++)
      assert.ok(rows[i].timestamp >= rows[i - 1].end - 0.35, `overlap at ${rows[i].timestamp}`);
  });
}

// A real Auto recording (macOS voices played into the microphone). The Chinese model's first
// phrase runs on to 7.92 s although its last word ends at 6.12 s, and the English sentence that
// follows opens with two unsure words: both used to cost "The pricing".
const boundary = JSON.parse(
  readFileSync(new URL('./fixtures/language-boundary.json', import.meta.url), 'utf8'),
);
const englishText = (rows) =>
  rows
    .filter((s) => s.locale === 'en-US')
    .map((s) => s.text)
    .join(' ');

test('the first words after a language switch are kept', () => {
  const auto = arbitrateOffline(boundary.candidates, boundary.locales);
  assert.match(englishText(auto), /^The pricing page launches/);
  assert.match(auto[0].text, /^今天我们讨论一下/);
  const { rows } = streamLive(boundary.candidates, boundary.locales);
  assert.match(englishText(rows), /^The pricing page launches/);
});

test('live: only the leading language shows provisional text, and a dropped one is ignored', () => {
  const arbiter = createLiveArbiter({ locales: ['zh-CN', 'en-US'], startedAt: 0 });
  const partial = (locale, segmentId, text) => ({
    type: 'partial',
    source: 'microphone',
    locale,
    segmentId,
    text,
    timestamp: 0,
    end: 1,
  });
  assert.deepEqual(arbiter.push(partial('en-US', 'e1', 'Hello'), 100), []);
  assert.deepEqual(
    arbiter.push(partial('zh-CN', 'z1', '你好'), 100).map((a) => [a.type, a.event.segmentId]),
    [['partial', 'z1']],
  );
  const dropped = arbiter.drop('microphone', 'zh-CN', 200);
  assert.deepEqual(dropped[0], { type: 'discard', segmentIds: ['z1'] });
  assert.deepEqual(
    dropped.slice(1).map((a) => [a.type, a.event.segmentId]),
    [['partial', 'e1']],
    'the remaining language takes over the live text',
  );
  assert.deepEqual(arbiter.push({ ...partial('zh-CN', 'z2', '再见'), type: 'segment' }, 300), []);
  const done = arbiter.flush(400);
  assert.deepEqual(
    done.filter((a) => a.type === 'segment').map((a) => a.segment.text),
    ['Hello'],
  );
});

test('live: a language that hears nothing does not hold the transcript back', () => {
  const arbiter = createLiveArbiter({ locales: ['zh-CN', 'en-US'], startedAt: 0, settle: 3500 });
  const english = {
    type: 'segment',
    source: 'system',
    locale: 'en-US',
    segmentId: 'e1',
    text: 'Hello everyone',
    timestamp: 0,
    end: 2,
    confidence: 0.95,
  };
  const early = arbiter.push(english, 2500);
  assert.equal(early.filter((a) => a.type === 'segment').length, 0, 'waits for Chinese first');
  const later = arbiter.tick(4000);
  assert.deepEqual(
    later.filter((a) => a.type === 'segment').map((a) => a.segment.segmentId),
    ['e1'],
  );
});

test('live: with watermarks, a slow language is waited for instead of assumed silent', () => {
  const arbiter = createLiveArbiter({ locales: ['zh-CN', 'en-US'], startedAt: 0 });
  const progress = (locale, through, now) =>
    arbiter.push({ type: 'recognition-progress', source: 'microphone', locale, through }, now);
  const english = {
    type: 'segment',
    source: 'microphone',
    locale: 'en-US',
    segmentId: 'e1',
    text: 'Jin tian kai hui',
    timestamp: 0,
    end: 3,
    confidence: 0.2,
  };
  progress('en-US', 3, 3500);
  progress('zh-CN', 0.5, 3500); // the Chinese model is still loading
  const early = arbiter.push(english, 4000);
  assert.equal(early.filter((a) => a.type === 'segment').length, 0);
  assert.equal(
    arbiter.tick(9000).filter((a) => a.type === 'segment').length,
    0,
    'waits past the old 3.5 s silence rule while Chinese keeps reporting progress',
  );
  progress('zh-CN', 1, 9000);
  const chinese = arbiter.push(
    {
      type: 'segment',
      source: 'microphone',
      locale: 'zh-CN',
      segmentId: 'z1',
      text: '今天开会',
      timestamp: 0,
      end: 3,
      confidence: 0.95,
    },
    12000,
  );
  assert.deepEqual(
    chinese.filter((a) => a.type === 'segment').map((a) => a.segment.segmentId),
    ['z1'],
  );
});

test('live: provisional text the helper withdraws, or that goes stale, is never saved', () => {
  const arbiter = createLiveArbiter({ locales: ['zh-CN', 'en-US'], startedAt: 0 });
  const event = (type, locale, segmentId, text, timestamp, end, confidence) => ({
    type,
    source: 'microphone',
    locale,
    segmentId,
    text,
    timestamp,
    end,
    confidence,
  });
  const segments = (actions) =>
    actions.filter((a) => a.type === 'segment').map((a) => a.segment.segmentId);
  // A cough the Chinese model first heard as 嗯, then revised to nothing.
  arbiter.push(event('partial', 'zh-CN', 'cough', '嗯', 0.5, 0.8), 1000);
  arbiter.push(event('segment', 'zh-CN', 'z1', '今天开会', 1, 3, 0.95), 3000);
  arbiter.push(event('segment', 'en-US', 'e1', 'Jin tian', 1, 3, 0.2), 3000);
  for (const locale of ['zh-CN', 'en-US'])
    arbiter.push({ type: 'recognition-progress', source: 'microphone', locale, through: 4 }, 3200);
  assert.deepEqual(segments(arbiter.tick(3500)), [], 'the cough holds the decision back');
  const withdrawn = arbiter.discard({ source: 'microphone', segmentIds: ['cough'] }, 3600);
  assert.deepEqual(
    withdrawn.filter((a) => a.type === 'discard').map((a) => a.segmentIds),
    [['cough']],
  );
  assert.deepEqual(segments(withdrawn), ['z1'], 'decided as soon as it is withdrawn');
  // Provisional text the helper never finalizes or withdraws expires after `stall`.
  arbiter.push(event('partial', 'zh-CN', 'stale', '那个', 5, 5.4), 5000);
  const expired = arbiter.tick(5000 + 15000);
  assert.deepEqual(
    expired.filter((a) => a.type === 'discard').map((a) => a.segmentIds),
    [['stale']],
  );
  assert.deepEqual(segments(arbiter.flush(21000)), [], 'nothing withdrawn is saved at stop');
});
