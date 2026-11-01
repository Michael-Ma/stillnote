import test from 'node:test';
import assert from 'node:assert/strict';
import { createEchoFilter, echoMatch, suppressEcho, timedWords } from '../app/echo.mjs';

// The pairs below follow what real calls without headphones produced (timings, how phrases were
// cut, the kinds of words misheard); the sentences themselves are made up.

// A final phrase as the recognizer returns it: word timing from `at`, `rate` seconds a word (a
// CJK character counts as a word), or none with `timed: false`.
function phrase(source, at, text, { rate = 0.32, timed = true, id } = {}) {
  const parts = text.match(/\p{Script=Han}|[^\s\p{Script=Han}]+/gu);
  const runs = parts.map((part, i) => [
    +(at + i * rate).toFixed(3),
    +(at + (i + 1) * rate).toFixed(3),
    0.9,
    (i && !/\p{Script=Han}/u.test(part) ? ' ' : '') + part,
  ]);
  return {
    source,
    segmentId: id ?? `${source}-${at}`,
    speaker: source === 'microphone' ? 'You' : 'Meeting audio',
    text,
    timestamp: at,
    ...(timed ? { end: +(at + parts.length * rate).toFixed(3), runs } : {}),
  };
}
const mic = (at, text, options) => phrase('microphone', at, text, options);
const meeting = (at, text, options) => phrase('system', at, text, options);
const echo = (row, system) => echoMatch(row, system).echo;

const offer =
  "And we might give them early access to the new dashboard in their region for, let's say, 6 months.";
const headStart = 'We give them a 6 week head start on the new release.';
const reply = 'Six weeks sounds right to me, honestly.';
const kept = { keep: true, remove: [], trim: [] };
const leftOut = { keep: false, remove: [], trim: [] };

test('words are normalized the same way on both sides', () => {
  const words = (text) => timedWords(mic(0, text)).map((w) => w.word);
  assert.deepEqual(words("Um, so let's say, uh, six months."), [
    'so',
    "let's",
    'say',
    '6',
    'months',
  ]);
  assert.deepEqual(words('Let’s give them 6 MONTHS'), ["let's", 'give', 'them', '6', 'months']);
  // CJK runs count by character pairs; 嗯 and 呃 are fillers.
  assert.deepEqual(words('嗯，这个 feature 的 deadline'), ['这个', 'feature', '的', 'deadline']);
  // Each word is timed from its own run (runs start with the space before their word).
  assert.deepEqual(
    timedWords(meeting(10, 'We give them a head start')).map((w) => w.time),
    [10, 10.32, 10.64, 10.96, 11.28, 11.6],
  );
});

test('the observed duplicate: the same sentence from the speakers a fraction of a second apart', () => {
  // As seen on a 149-minute call: You at 494.8 s, Meeting audio at 495.1 s, the same words.
  assert.equal(echo(mic(494.81, offer), [meeting(495.08, offer)]), true);
  // Rows without word timing or an end (other engines) are spread over an estimated span.
  assert.equal(
    echo(mic(494.81, offer, { timed: false }), [meeting(495.08, offer, { timed: false })]),
    true,
  );
  // Measured with word timing on that call: the microphone ran 0.1 s ahead of meeting audio.
  assert.equal(echo(mic(6.648, headStart), [meeting(6.741, headStart)]), true);
});

test('an echo the microphone misheard a little is still an echo', () => {
  // A number written differently and two words heard as one.
  assert.equal(
    echo(mic(81.3, 'We have four designs that were approved impromptu last week.'), [
      meeting(81.0, 'We have 4 designs that were approved in principle last week.'),
    ]),
    true,
  );
  // A word the microphone missed, and a filler it heard differently.
  assert.equal(
    echo(mic(12.2, 'So, um... I thought that there could be a much simpler onboarding'), [
      meeting(12.0, 'So, um, I thought that there could be a much, much simpler onboarding'),
    ]),
    true,
  );
  // Chinese: one character misheard (我 for 他), a pause written differently.
  assert.equal(
    echo(mic(2267.3, '对其实我觉得这些需求我们都已经 cover到了是吧。', { rate: 0.22 }), [
      meeting(2267.4, '对 ，其实我觉得这些需求他们都已经 cover到了是吧。', { rate: 0.22 }),
    ]),
    true,
  );
});

test('a word heard wrong costs a Chinese row what it costs an English one', () => {
  const said = '其实我觉得这些需求大家都已经讨论过了对吧';
  const heard = (text) =>
    echo(mic(10, text, { rate: 0.22 }), [meeting(10.1, said, { rate: 0.22 })]);
  // A two-character word heard as another one: a single word, as in English.
  assert.equal(heard('其实我觉得这些需求客户都已经讨论过了对吧'), true);
  // Two characters wrong far apart cost four of seventeen pairs, but only two of eighteen characters.
  assert.equal(
    echo(mic(20, '这个方案你们下周可以开始事点看看效果', { rate: 0.22 }), [
      meeting(20.1, '这个方案我们下周可以开始试点看看效果', { rate: 0.22 }),
    ]),
    true,
  );
  // Three characters that meeting audio did not say are words of its own, as in English.
  assert.equal(heard('其实我觉得这些需求老板们都已经讨论过了对吧'), false);
  // The same characters, scattered: pairs still have to match.
  assert.equal(
    echo(mic(30, '大家都觉得需求已经讨论过', { rate: 0.22 }), [
      meeting(30.1, '讨论需求过后大家已经都觉得', { rate: 0.22 }),
    ]),
    false,
  );
});

test('recognizers cut phrases in different places: words are matched where they were said', () => {
  // The microphone's phrase is the second half of meeting audio's, starting 3.9 s after it.
  const long = meeting(
    100,
    'And then we go out and test it, bring in the users, and also write the docs to explain the feature to everyone.',
  );
  const second = mic(103.9, 'And also write the docs to explain the feature to everyone.');
  assert.equal(echo(second, [long]), true);
  // Without word timing the row's own start would be far from the long phrase's.
  assert.ok(second.timestamp - long.timestamp > 1.5);
  // One microphone phrase covering two of meeting audio's.
  const first = meeting(
    200,
    'If you want to try the beta, we could open it to your team, actually,',
  );
  const rest = meeting(
    204.85,
    'we believe we could open the whole workspace and invite everyone right now for a pilot.',
  );
  const whole = mic(
    200.05,
    'If you want to try the beta, we could open it to your team, actually, we believe we could open the whole workspace and invite everyone right now for a pilot.',
  );
  assert.equal(echo(whole, [first]), false, 'half of it is not yet heard');
  assert.equal(echo(whole, [rest, first]), true);
});

test('short rows are always kept', () => {
  assert.equal(echo(mic(8.57, 'Yeah.'), [meeting(8.6, 'Yeah, okay.')]), false);
  assert.equal(echo(mic(3.1, 'Thank you.'), [meeting(3.1, 'Thank you.')]), false);
  assert.equal(echo(mic(5.0, '好的好的'), [meeting(5.0, '好的好的')]), false);
});

test('your own words are kept even when they overlap the other side', () => {
  // A sentence of your own that starts like theirs, said at the same time.
  assert.equal(
    echo(mic(40.2, 'I think we can talk about pricing on Monday.'), [
      meeting(40, 'I think we can ship the new onboarding flow on Friday.'),
    ]),
    false,
  );
  // The same common words, scattered through what they said: no stretch of it was repeated.
  assert.equal(
    echo(mic(60.4, 'I think we need a plan.'), [
      meeting(60, 'So I think that the main thing we need is a plan that we can all agree on.', {
        rate: 0.2,
      }),
    ]),
    false,
  );
  // Your reply right after their sentence, recognized as one phrase with the echo: kept whole.
  assert.equal(echo(mic(300, `${offer} Yes, exactly right.`), [meeting(300.1, offer)]), false);
  // Chinese: agreeing over them, sharing a few words.
  assert.equal(
    echo(mic(50.5, '好的那我们下周二见', { rate: 0.22 }), [
      meeting(50, '我们下周二再讨论这个方案吧', { rate: 0.22 }),
    ]),
    false,
  );
});

test('a sentence you repeat after them is kept; only a simultaneous one is an echo', () => {
  const thanks = meeting(10, 'Thank you so much.', { rate: 0.25 });
  assert.equal(echo(mic(10.05, 'Thank you so much.', { rate: 0.25 }), [thanks]), true);
  assert.equal(echo(mic(11.2, 'Thank you so much.', { rate: 0.25 }), [thanks]), false);
  assert.equal(
    echo(mic(11.0, 'Nice to meet you too.', { rate: 0.25 }), [
      meeting(10, 'Nice to meet you.', { rate: 0.25 }),
    ]),
    false,
  );
  // Quoting them later, word for word.
  assert.equal(
    echo(mic(130, 'Early access to the new dashboard in their region.'), [meeting(100, offer)]),
    false,
  );
});

test('only meeting audio counts as the original', () => {
  assert.equal(echo(mic(6.6, headStart), [mic(6.7, headStart, { id: 'another' })]), false);
  assert.equal(echo(mic(6.6, headStart), []), false);
});

test('Retry leaves out the echoes and keeps everything else in order', () => {
  const rows = [
    mic(0.35, offer),
    meeting(0.62, offer),
    mic(6.65, headStart),
    meeting(6.74, headStart),
    mic(8.57, 'Yeah.'),
    meeting(8.72, 'You know, and then we would have a second phase.'),
    mic(82.7, 'Yeah, that is why I was thinking about the plan we discussed last time.'),
  ];
  const { segments, removed } = suppressEcho(rows);
  assert.deepEqual(
    segments.map((s) => [s.source, s.timestamp]),
    [
      ['system', 0.62],
      ['system', 6.74],
      ['microphone', 8.57],
      ['system', 8.72],
      ['microphone', 82.7],
    ],
  );
  assert.deepEqual(
    removed.map((s) => s.timestamp),
    [0.35, 6.65],
  );
  assert.deepEqual(suppressEcho([]), { segments: [], removed: [], trimmed: [] });
});

test('live: an echo is caught whichever source finalizes first', () => {
  // Meeting audio first: the microphone's row never joins the transcript.
  let filter = createEchoFilter();
  assert.deepEqual(filter.add(meeting(6.74, headStart)), kept);
  assert.deepEqual(filter.add(mic(6.65, headStart)), leftOut);
  // The microphone first: it is saved, then meeting audio shows it was an echo.
  filter = createEchoFilter();
  const early = mic(6.65, headStart);
  assert.deepEqual(filter.add(early), kept);
  assert.deepEqual(filter.add(meeting(6.74, headStart)), { ...kept, remove: [early] });
  // Your own row stays, and is not offered for removal again.
  assert.deepEqual(filter.add(mic(10.2, reply)), kept);
  assert.deepEqual(filter.add(meeting(10.3, 'Okay, great.')), kept);
});

test('live: a microphone phrase goes as meeting audio says it', () => {
  const filter = createEchoFilter();
  const whole = mic(
    200.05,
    'If you want to try the beta, we could open it to your team, actually, we believe we could open the whole workspace and invite everyone right now for a pilot.',
  );
  assert.equal(
    filter.add(
      meeting(200, 'If you want to try the beta, we could open it to your team, actually,'),
    ).keep,
    true,
  );
  // Half of it has been said: that half goes, the rest waits.
  const first = filter.add(whole);
  assert.equal(first.keep, true);
  assert.equal(first.trim.length, 1);
  assert.equal(first.trim[0].row, whole);
  assert.deepEqual(
    first.trim[0].pieces.map((p) => p.text),
    ['we believe we could open the whole workspace and invite everyone right now for a pilot.'],
  );
  assert.deepEqual(
    filter.add(
      meeting(
        204.85,
        'we believe we could open the whole workspace and invite everyone right now for a pilot.',
      ),
    ),
    { ...kept, remove: first.trim[0].pieces },
  );
});

test('live: rows replace earlier ones with their id, and old ones are forgotten', () => {
  const filter = createEchoFilter();
  const text = 'And she is good at planning, I would say.';
  assert.equal(
    filter.add(mic(10, 'Honestly, I think that works for me.', { id: 'm1' })).keep,
    true,
  );
  assert.deepEqual(filter.add(meeting(10.1, text)), kept);
  // The same phrase finalized again, now heard as the echo: it replaces the first version, which
  // is not offered for removal later.
  assert.deepEqual(filter.add(mic(10, text, { id: 'm1' })), leftOut);
  assert.deepEqual(filter.add(meeting(10.2, text, { id: 'again' })), kept);
  // Two minutes later the old sentence is no longer remembered.
  filter.add(meeting(400, 'Something else entirely, much later on.'));
  assert.equal(filter.add(mic(10, text, { id: 'm2' })).keep, true);
  // Rows from no known source, or without text, pass through.
  assert.deepEqual(filter.add({ text: 'Imported', timestamp: 0 }), kept);
  assert.deepEqual(filter.add({ ...mic(1, 'x'), text: ' ' }), kept);
});

// A long row of the microphone's that holds both: words of your own around what the speakers
// played. The recognizer joins them when nobody pauses.
const opening = 'Right, let me tell you what I think about that.';
const played = 'We looked at the numbers for the new release and they seem fine.';
const closing = 'So honestly I would rather wait until next week.';
const rate = 0.32;
const wordsIn = (text) => text.split(' ').length;
const mixed = (at) => ({
  row: mic(at, `${opening} ${played} ${closing}`),
  speakers: meeting(at + wordsIn(opening) * rate + 0.1, played),
});
const texts = (rows) => rows.map((r) => r.text);
const byTime = (rows) => rows.toSorted((a, b) => a.timestamp - b.timestamp);

test('a long row loses what meeting audio said and keeps the words around it', () => {
  const { row, speakers } = mixed(100);
  const { segments, removed, trimmed } = suppressEcho([row, speakers]);
  assert.deepEqual(removed, []);
  assert.deepEqual(texts(byTime(segments)), [opening, played, closing]);
  assert.deepEqual(
    byTime(segments).map((s) => s.source),
    ['microphone', 'system', 'microphone'],
  );
  assert.equal(trimmed.length, 1);
  assert.equal(trimmed[0].row, row);
  // Each part keeps its own time and word timing, and an id of its own.
  const [before, , after] = byTime(segments);
  assert.equal(before.timestamp, 100);
  assert.equal(after.timestamp, +(100 + (wordsIn(opening) + wordsIn(played)) * rate).toFixed(3));
  assert.equal(after.end, row.end);
  assert.deepEqual(
    texts([
      {
        text: after.runs
          .map((r) => r[3])
          .join('')
          .trim(),
      },
    ]),
    [closing],
  );
  assert.notEqual(before.segmentId, after.segmentId);
  assert.notEqual(before.segmentId, row.segmentId);
});

test('Chinese: a long row loses what meeting audio said and keeps the words around it', () => {
  const say = '我觉得这个方案可以再想一想';
  const heard = '他们说下周要把新版本先发给重点客户试用';
  const add = '那我这边先跟团队对一下时间';
  const zh = 0.22;
  const row = mic(50, `${say}${heard}${add}`, { rate: zh });
  const speakers = meeting(50 + [...say].length * zh + 0.1, heard, { rate: zh });
  const { segments } = suppressEcho([row, speakers]);
  assert.deepEqual(texts(byTime(segments)), [say, heard, add]);
});

test('a garbled stretch goes like a clean one', () => {
  const { row } = mixed(100);
  // The microphone misheard one word of what the speakers played.
  const garbled = meeting(
    100 + wordsIn(opening) * rate + 0.1,
    'We looked at the numbers for a new release and they seem fine.',
  );
  assert.deepEqual(texts(byTime(suppressEcho([row, garbled]).segments)), [
    opening,
    garbled.text,
    closing,
  ]);
});

test('a row is not cut for less than a stretch of six words', () => {
  const text = `${opening} and they seem fine. ${closing}`;
  const row = mic(100, text);
  const speakers = meeting(100 + wordsIn(opening) * rate + 0.1, 'and they seem fine.');
  assert.deepEqual(suppressEcho([row, speakers]).trimmed, []);
  assert.deepEqual(texts(suppressEcho([row, speakers]).segments), [text, speakers.text]);
});

test('a row without word timing is never cut', () => {
  const row = mic(100, `${opening} ${played} ${closing}`, { timed: false });
  const speakers = meeting(100 + wordsIn(opening) * rate + 0.1, played, { timed: false });
  const { segments, trimmed } = suppressEcho([row, speakers]);
  assert.deepEqual(trimmed, []);
  assert.deepEqual(texts(segments), [row.text, played]);
  // Nor one without an id, which could not be told from its neighbours when saved.
  const { row: nameless, speakers: heard } = mixed(100);
  delete nameless.segmentId;
  assert.deepEqual(suppressEcho([nameless, heard]).trimmed, []);
});

test('your own words are not cut when they merely resemble what meeting audio said', () => {
  const kept = (row, speakers) => assert.deepEqual(suppressEcho([row, speakers]).trimmed, []);
  // The same words said after them, in a long row: repeating is not an echo.
  const repeat = `${opening} ${played} ${closing}`;
  kept(mic(100, repeat), meeting(100 + wordsIn(opening) * rate - 2.6, played));
  // The same opening, then a sentence of your own, at the same moment.
  kept(
    mic(40, 'I think we can look at the numbers on Monday and then decide what the plan is.'),
    meeting(40, 'I think we can ship the new onboarding flow on Friday if everybody agrees.'),
  );
  // Common words scattered through a long row of theirs.
  kept(
    mic(60, 'So we need the numbers for the release and then we can all agree on the plan.'),
    meeting(60, 'The numbers we need are in the plan that the release team can agree on for all.', {
      rate: 0.2,
    }),
  );
  // Chinese, the same way.
  kept(
    mic(70, '我们下周二再讨论这个方案不过我还想先听听大家的意见', { rate: 0.22 }),
    meeting(70, '下周二我们要把这个方案发给客户请大家先看一下', { rate: 0.22 }),
  );
});

test('a word of the first person that meeting audio did not say is never cut', () => {
  // Inside a stretch a single word heard differently would go; "I" and 我 do not.
  const row = mic(
    100,
    `${opening} We looked at the numbers for the I new release and they seem fine again today. ${closing}`,
  );
  const speakers = meeting(
    100 + wordsIn(opening) * rate + 0.05,
    'We looked at the numbers for the new release and they seem fine again today.',
    { rate },
  );
  const left = suppressEcho([row, speakers]).segments.filter((s) => s.source === 'microphone');
  assert.deepEqual(texts(left), [opening, 'I', closing]);
  const zh = mic(
    50,
    `这件事情让我再想一想吧他们说下周要把新我版本先发给重点客户试用和大家说一声今天先这样吧`,
    { rate: 0.22 },
  );
  const original = meeting(50 + 10 * 0.22 + 0.05, '他们说下周要把新版本先发给重点客户试用', {
    rate: 0.22,
  });
  const rest = suppressEcho([zh, original]).segments.filter((s) => s.source === 'microphone');
  assert.ok(
    rest.some((s) => s.text.endsWith('把新我')),
    'the row keeps its 我',
  );
});

test('what is left of a row stays, however little', () => {
  const row = mic(100, `${played} Yes.`);
  const speakers = meeting(100.1, played);
  assert.deepEqual(texts(suppressEcho([row, speakers]).segments), [played]);
  const longer = mic(100, `${played} ${closing}`);
  assert.deepEqual(texts(byTime(suppressEcho([longer, speakers]).segments)), [played, closing]);
  // Two short words of its own after a cut are still its own.
  const after = mic(100, `${opening} ${played} Okay then.`);
  const heard = meeting(100 + wordsIn(opening) * rate + 0.1, played);
  assert.deepEqual(texts(byTime(suppressEcho([after, heard]).segments)), [
    opening,
    played,
    'Okay then.',
  ]);
});

test('live: a row is cut whichever source finalizes first', () => {
  // Meeting audio first: the row is kept, and cut at once.
  let filter = createEchoFilter();
  let { row, speakers } = mixed(100);
  assert.deepEqual(filter.add(speakers), kept);
  let verdict = filter.add(row);
  assert.equal(verdict.keep, true);
  assert.deepEqual(verdict.remove, []);
  assert.equal(verdict.trim[0].row, row);
  assert.deepEqual(texts(verdict.trim[0].pieces), [opening, closing]);
  // The microphone first: meeting audio shows part of what is saved to have been the echo.
  filter = createEchoFilter();
  ({ row, speakers } = mixed(300));
  assert.deepEqual(filter.add(row), kept);
  verdict = filter.add(speakers);
  assert.equal(verdict.keep, true);
  assert.equal(verdict.trim[0].row, row);
  assert.deepEqual(texts(verdict.trim[0].pieces), [opening, closing]);
  // The cut row is not offered again; its parts are what the filter remembers.
  assert.deepEqual(filter.add(meeting(330, 'Okay, great.')), kept);
});

test('live: a row finalized again replaces the parts of its earlier version', () => {
  const filter = createEchoFilter();
  const { row, speakers } = mixed(100);
  filter.add(speakers);
  const { pieces } = filter.add(row).trim[0];
  const again = filter.add(mic(100, reply, { id: row.segmentId }));
  assert.equal(again.keep, true);
  assert.deepEqual(again.remove, pieces);
});
