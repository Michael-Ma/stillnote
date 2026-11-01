import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';
import { todoScanner } from '../app/todo-scanner.mjs';
import { backfillIds, todoInstructions } from '../app/todos.mjs';

const answer = (task, assignee = 'me') =>
  JSON.stringify({ items: [{ task, assignee, quote: 'I will send the draft' }] });
const line = {
  text: 'I will send the draft',
  speaker: 'You',
  source: 'microphone',
  timestamp: 3,
};
const other = {
  text: 'Thanks, sounds good',
  speaker: 'Meeting audio',
  source: 'system',
  timestamp: 5,
};

function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-scanner-'));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const meeting = (title) => {
    const m = store.create({ title });
    store.append(m.id, line);
    store.append(m.id, other);
    return m;
  };
  const calls = [],
    errors = [];
  let changes = 0;
  // Each request waits here until the test answers it.
  const pending = [];
  const respond = (request) => {
    calls.push(request);
    return new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      pending.push({ resolve, reject });
    });
  };
  const scanner = todoScanner({
    store,
    respond,
    recordingMeeting: () => null,
    onChange: () => changes++,
    onError: (message) => errors.push(message),
    ...overrides,
  });
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  return { store, meeting, calls, errors, pending, scanner, turn, changes: () => changes };
}

test('meetings are scanned one at a time and saved as they finish', async (t) => {
  const { store, meeting, calls, pending, scanner, turn, changes } = fixture(t);
  const first = meeting('First'),
    second = meeting('Second');
  store.setting('myNames', 'Sam');
  scanner.add([first.id, second.id]);
  await turn();
  assert.equal(calls.length, 1, 'the second waits for the first');
  assert.equal(calls[0].instructions, todoInstructions);
  assert.match(calls[0].input[0].content, /<my_names>\nSam\n<\/my_names>/);
  assert.deepEqual(scanner.state(), {
    running: true,
    meetingId: first.id,
    done: 0,
    total: 2,
  });
  pending[0].resolve(answer('Send the draft'));
  await turn();
  await turn();
  assert.equal(store.todos().length, 1);
  assert.equal(store.todos()[0].assignee, 'me');
  assert.equal(store.todos()[0].evidence.speaker, 'You');
  assert.equal(calls.length, 2);
  assert.equal(scanner.state().done, 1);
  pending[1].resolve(answer('Send the draft again', 'other'));
  await turn();
  await turn();
  assert.deepEqual(scanner.state(), { running: false, meetingId: null, done: 0, total: 0 });
  assert.equal(store.todos().length, 2);
  assert.ok(changes() > 3, 'the window hears about progress');
});

test('a meeting already waiting or running is not queued twice', async (t) => {
  const { meeting, calls, pending, scanner, turn } = fixture(t);
  const first = meeting('First'),
    second = meeting('Second');
  scanner.add([first.id, second.id, second.id]);
  await turn();
  assert.equal(scanner.add([first.id, second.id]).total, 2);
  pending[0].resolve('{"items":[]}');
  await turn();
  await turn();
  pending[1].resolve('{"items":[]}');
  await turn();
  await turn();
  assert.equal(calls.length, 2);
});

test('stopping keeps what is saved and leaves the rest for later', async (t) => {
  const { store, meeting, pending, scanner, turn, errors } = fixture(t);
  const first = meeting('First'),
    second = meeting('Second'),
    third = meeting('Third');
  scanner.add([first.id, second.id, third.id]);
  await turn();
  pending[0].resolve(answer('Send the draft'));
  await turn();
  await turn();
  await scanner.cancel();
  await turn();
  assert.equal(scanner.state().running, false);
  assert.equal(store.todos().length, 1);
  assert.deepEqual(Object.keys(store.todoScans()), [first.id]);
  assert.deepEqual(errors, [], 'stopping is not an error');
  assert.deepEqual(
    backfillIds(store.all(), store.todoScans(), null).sort(),
    [second.id, third.id].sort(),
  );
});

test('a refused request stops the queue and says why', async (t) => {
  const { store, meeting, pending, scanner, turn, errors, calls } = fixture(t);
  const first = meeting('First'),
    second = meeting('Second');
  scanner.add([first.id, second.id]);
  await turn();
  pending[0].reject(new Error('ChatGPT plan usage limit reached. Open Manage usage in Settings.'));
  await turn();
  await turn();
  assert.equal(calls.length, 1, 'the plan would refuse the next one too');
  assert.match(errors[0], /usage limit/);
  assert.equal(store.todoScans()[first.id].status, 'failed');
  assert.equal(store.todoScans()[second.id], undefined);
  assert.equal(scanner.state().running, false);
});

test('an unreadable answer fails that meeting only', async (t) => {
  const { store, meeting, pending, scanner, turn, errors } = fixture(t);
  const first = meeting('First'),
    second = meeting('Second');
  store.saveTodoScan(first.id, [
    { text: 'Earlier todo', assignee: 'me', owner: null, due: null, evidence: null },
  ]);
  scanner.add([first.id, second.id]);
  await turn();
  pending[0].resolve('Sorry, I cannot help with that.');
  await turn();
  await turn();
  assert.equal(store.todoScans()[first.id].status, 'failed');
  assert.deepEqual(
    store.todos().map((row) => row.text),
    ['Earlier todo'],
    'an earlier scan is kept',
  );
  pending[1].resolve(answer('Send the draft'));
  await turn();
  await turn();
  assert.equal(store.todoScans()[second.id].status, 'done');
  assert.deepEqual(errors, []);
});

test('a meeting too large to send fails without a request', async (t) => {
  const { store, meeting, calls, scanner, turn } = fixture(t);
  const huge = meeting('Huge');
  store.update(huge.id, { notes: 'x'.repeat(360_000) });
  scanner.add([huge.id]);
  await turn();
  await turn();
  assert.equal(calls.length, 0);
  assert.equal(store.todoScans()[huge.id].status, 'failed');
});

test('a request that hangs is given up on, with a message', async (t) => {
  const { store, meeting, scanner, turn, errors } = fixture(t, { limit: 5 });
  const stuck = meeting('Stuck');
  scanner.add([stuck.id]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await turn();
  assert.match(errors[0], /timed out/);
  assert.equal(store.todoScans()[stuck.id].status, 'failed');
});

test('meetings in Trash, gone, or still recording are skipped', async (t) => {
  let recording = null;
  const { store, meeting, calls, scanner, turn } = fixture(t, {
    recordingMeeting: () => recording,
  });
  const trashed = meeting('Trashed'),
    live = meeting('Live');
  store.update(trashed.id, { deletedAt: true });
  recording = live.id;
  scanner.add([trashed.id, live.id, 'gone']);
  await turn();
  await turn();
  await turn();
  await turn();
  assert.equal(calls.length, 0);
  assert.deepEqual(store.todoScans(), {});
  assert.equal(scanner.state().running, false);
});

test('a meeting deleted forever during its scan stays deleted', async (t) => {
  const { store, meeting, pending, scanner, turn } = fixture(t);
  const m = meeting('Sensitive');
  scanner.add([m.id]);
  await turn();
  store.update(m.id, { deletedAt: true });
  store.deleteForever([m.id]);
  pending[0].resolve(answer('Send the draft'));
  await turn();
  await turn();
  assert.deepEqual(store.todos(), []);
  assert.deepEqual(store.todoScans(), {});
});
