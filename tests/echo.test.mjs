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
  assert.deepEqual(suppressEcho([]), { segments: [], removed: [] });
});

test('live: an echo is caught whichever source finalizes first', () => {
  // Meeting audio first: the microphone's row never joins the transcript.
  let filter = createEchoFilter();
  assert.deepEqual(filter.add(meeting(6.74, headStart)), { keep: true, remove: [] });
  assert.deepEqual(filter.add(mic(6.65, headStart)), { keep: false, remove: [] });
  // The microphone first: it is saved, then meeting audio shows it was an echo.
  filter = createEchoFilter();
  const early = mic(6.65, headStart);
  assert.deepEqual(filter.add(early), { keep: true, remove: [] });
  assert.deepEqual(filter.add(meeting(6.74, headStart)), { keep: true, remove: [early] });
  // Your own row stays, and is not offered for removal again.
  assert.deepEqual(filter.add(mic(10.2, reply)), { keep: true, remove: [] });
  assert.deepEqual(filter.add(meeting(10.3, 'Okay, great.')), { keep: true, remove: [] });
});

test('live: a microphone phrase is an echo once meeting audio has said all of it', () => {
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
  assert.deepEqual(filter.add(whole), { keep: true, remove: [] });
  assert.deepEqual(
    filter.add(
      meeting(
        204.85,
        'we believe we could open the whole workspace and invite everyone right now for a pilot.',
      ),
    ),
    { keep: true, remove: [whole] },
  );
});

test('live: rows replace earlier ones with their id, and old ones are forgotten', () => {
  const filter = createEchoFilter();
  const text = 'And she is good at planning, I would say.';
  assert.equal(
    filter.add(mic(10, 'Honestly, I think that works for me.', { id: 'm1' })).keep,
    true,
  );
  assert.deepEqual(filter.add(meeting(10.1, text)), { keep: true, remove: [] });
  // The same phrase finalized again, now heard as the echo: it replaces the first version, which
  // is not offered for removal later.
  assert.deepEqual(filter.add(mic(10, text, { id: 'm1' })), { keep: false, remove: [] });
  assert.deepEqual(filter.add(meeting(10.2, text, { id: 'again' })), { keep: true, remove: [] });
  // Two minutes later the old sentence is no longer remembered.
  filter.add(meeting(400, 'Something else entirely, much later on.'));
  assert.equal(filter.add(mic(10, text, { id: 'm2' })).keep, true);
  // Rows from no known source, or without text, pass through.
  assert.deepEqual(filter.add({ text: 'Imported', timestamp: 0 }), { keep: true, remove: [] });
  assert.deepEqual(filter.add({ ...mic(1, 'x'), text: ' ' }), { keep: true, remove: [] });
});
