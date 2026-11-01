import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bootstrap,
  memberKey,
  metrics,
  nextStepItems,
  poolItems,
  shuffled,
  splitMeetings,
  taskRows,
  wilson,
} from '../scripts/todo-score.mjs';

test('a shuffle is repeatable and loses nothing', () => {
  const list = Array.from({ length: 20 }, (_, i) => i);
  assert.deepEqual(shuffled(list, 7), shuffled(list, 7));
  assert.notDeepEqual(shuffled(list, 7), shuffled(list, 8));
  assert.deepEqual(
    [...shuffled(list, 7)].sort((a, b) => a - b),
    list,
  );
});

test('the tuning set draws from every stratum and the test set gets the rest', () => {
  const meetings = [
    ...Array.from({ length: 9 }, (_, i) => ({ id: `two-${i}`, stratum: 'two' })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: `one-${i}`, stratum: 'one' })),
  ];
  const { dev, test: rest } = splitMeetings(meetings, 3, 4);
  assert.equal(dev.length, 4);
  assert.equal(rest.length, 8);
  assert.ok(dev.some((id) => id.startsWith('one')));
  assert.ok(dev.some((id) => id.startsWith('two')));
  assert.deepEqual([...dev, ...rest].sort(), meetings.map((m) => m.id).sort());
  assert.deepEqual(splitMeetings(meetings, 3, 4), { dev, test: rest });
});

test('next steps are read from the notes as they stand', () => {
  const summary = [
    '## Pricing',
    '- **Me**: not a next step',
    '## Next steps',
    '- **Me**: Send the draft, by Friday',
    '- **Priya**: Update the page',
    '  - nested detail',
    '- Book a room',
    '## Afterwards',
    '- **Me**: outside the section',
  ].join('\n');
  assert.deepEqual(
    nextStepItems(summary).map(({ text, assignee }) => [text, assignee]),
    [
      ['Send the draft, by Friday', 'me'],
      ['Update the page', 'other'],
      ['Book a room', 'unclear'],
    ],
  );
  assert.deepEqual(nextStepItems('## 下一步\n- **我**：发报价\n- **小李**：改文案')[0], {
    text: '发报价',
    assignee: 'me',
    owner: '我',
    evidence: null,
  });
  assert.deepEqual(nextStepItems('## Pricing\n- Nothing agreed'), []);
});

test('the same task from two runs is one thing to label, and labels stay put', () => {
  let pool = poolItems([], 'first', 'm', [
    { text: 'Send the pricing draft' },
    { text: 'Call Priya' },
  ]);
  assert.equal(pool.length, 2);
  pool = poolItems(pool, 'second', 'm', [{ text: 'Send pricing draft' }, { text: 'Book a room' }]);
  assert.equal(pool.length, 3);
  assert.deepEqual(pool[0].members, [memberKey('first', 'm', 0), memberKey('second', 'm', 0)]);
  assert.equal(pool[2].id, 'c3');
  assert.deepEqual(poolItems(pool, 'second', 'm', [{ text: 'Send pricing draft' }]), pool);
  assert.equal(poolItems(pool, 'third', 'other', [{ text: 'Call Priya' }]).length, 4);
});

const candidates = [
  { id: 'a', meetingId: 'm', members: ['run/m/0'] },
  { id: 'b', meetingId: 'm', members: ['run/m/1'] },
  { id: 'c', meetingId: 'm', members: ['run/m/2'] },
  { id: 'd', meetingId: 'm', members: ['other/m/0'] },
  { id: 'e', meetingId: 'n', members: ['run/n/0'] },
  { id: 'f', meetingId: 'n', members: ['run/n/1'] },
];
const labels = {
  a: { label: 'mine' },
  b: { label: 'mine', dupOf: 'a' },
  c: { label: 'not_task' },
  d: { label: 'mine' },
  e: { label: 'other' },
  f: { label: 'unsure' },
};
const items = [
  { meetingId: 'm', index: 0, assignee: 'unclear' },
  { meetingId: 'm', index: 1, assignee: 'me' },
  { meetingId: 'm', index: 2, assignee: 'unclear' },
  { meetingId: 'n', index: 0, assignee: 'me' },
  { meetingId: 'n', index: 1, assignee: 'me' },
];
const rowsFor = (overrides = {}) =>
  taskRows({ candidates, labels, run: 'run', items, meetingIds: ['m', 'n'], ...overrides });

test('a task said twice counts once, by its strongest claim', () => {
  const { rows, unlabeled } = rowsFor();
  assert.equal(unlabeled, 0);
  assert.equal(rows.length, 5);
  const task = rows.find((r) => r.id === 'a');
  assert.equal(task.pred, 'me');
  assert.equal(task.repeats, 1);
  assert.equal(rows.find((r) => r.id === 'd').pred, null, 'found only by another run');
});

test('tasks a person added to a meeting count as mine and missed', () => {
  const { rows } = rowsFor({ missing: { m: ['Forgotten task'], elsewhere: ['Not in this set'] } });
  assert.equal(rows.length, 6);
  assert.deepEqual(
    rows.filter((r) => r.id.startsWith('missing')).map((r) => [r.gold, r.pred]),
    [['mine', null]],
  );
});

test('labels still to come are counted, not guessed', () => {
  const { [`a`]: _, ...fewer } = labels;
  const { unlabeled } = rowsFor({ labels: { ...fewer, b: { label: 'mine' } } });
  assert.equal(unlabeled, 1);
});

test('the numbers mean what the report says', () => {
  const m = metrics(rowsFor().rows);
  assert.equal(m.tasks, 5);
  assert.equal(m.mine, 2);
  // Said "me": a (mine), e (other), f (unsure, left out). Precision 1 of 2.
  assert.equal(m.precisionMine, 1 / 2);
  // Listed with a judgement: a, c, e. One of three is mine.
  assert.equal(m.precisionList, 1 / 3);
  assert.equal(m.recallStrict, 1 / 2);
  assert.equal(m.recallList, 1 / 2);
  assert.equal(m.unclearShare, 1 / 4);
  assert.equal(m.unclearIsMine, 0);
  assert.equal(m.flipRate, 1 / 2);
  assert.equal(m.repeatRate, 1 / 5);
  assert.deepEqual(m.errors, {
    otherListedAsMine: 1,
    otherListedAsUnclear: 0,
    notTaskAsMine: 0,
    notTaskAsUnclear: 1,
    mineSaidOther: 0,
    mineMissed: 1,
  });
  assert.equal(metrics([]).precisionMine, null);
});

test('the interval comes from whole meetings and holds the estimate', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    meetingId: `m${i}`,
    gold: i < 7 ? 'mine' : 'other',
    pred: 'me',
    repeats: 0,
  }));
  const stat = (sample) => metrics(sample).precisionMine;
  const [low, high] = bootstrap(rows, stat, { seed: 5, rounds: 500 });
  assert.ok(low < 0.7 && 0.7 < high);
  assert.deepEqual(bootstrap(rows, stat, { seed: 5, rounds: 500 }), [low, high]);
  assert.equal(bootstrap([], stat), null);
});

test('Wilson agrees with a known value', () => {
  const [low, high] = wilson(32, 35);
  assert.ok(Math.abs(low - 0.776) < 0.005);
  assert.ok(Math.abs(high - 0.97) < 0.005);
  assert.equal(wilson(0, 0), null);
});
