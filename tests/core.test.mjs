import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, context, markdown } from '../app/store.mjs';
import { consumeResponse } from '../app/stream.mjs';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-'));
  const s = new Store(dir);
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { s, dir };
}
test('notes, folders, multilingual transcripts, search and trash persist across restart', (t) => {
  const { s, dir } = fixture(t),
    f = s.addFolder('Research');
  const m = s.create({ title: 'Robotics planning' });
  s.update(m.id, { folderId: f.id, notes: 'Ship the onboarding flow', starred: true });
  s.append(m.id, { text: '我们下周讨论机器人测试。', speaker: 'Michael', timestamp: 37 });
  assert.equal(s.search('onboarding')[0].id, m.id);
  assert.equal(s.search('Robotics')[0].id, m.id);
  assert.equal(s.search('机器人')[0].id, m.id);
  const second = new Store(dir);
  assert.equal(second.get(m.id).transcript[0].speaker, 'Michael');
  assert.equal(second.folders()[0].name, 'Research');
  second.close();
  s.update(m.id, { deletedAt: true });
  assert.equal(s.search('onboarding').length, 0);
  assert.equal(s.all().length, 0);
  assert.equal(s.all(true).length, 1);
  s.update(m.id, { deletedAt: null });
  assert.equal(s.search('onboarding').length, 1);
});
test('summary revisions and transcript corrections preserve source notes', (t) => {
  const { s } = fixture(t);
  const m = s.create({ notes: 'Original rough notes' });
  s.update(m.id, { summary: 'First summary' });
  s.update(m.id, { summary: 'Second summary', snapshotSummary: true });
  assert.equal(s.get(m.id).versions[0].text, 'First summary');
  assert.equal(s.get(m.id).notes, 'Original rough notes');
  s.append(m.id, { text: 'wrong', speaker: 'Speaker', timestamp: 0 });
  const id = s.get(m.id).transcript[0].id;
  s.editSegment(m.id, id, { text: 'correct', speaker: 'Alice' });
  assert.equal(s.search('correct').length, 1);
  s.editSegment(m.id, id, { remove: true });
  assert.equal(s.search('correct').length, 0);
});
test('backup restores notes and conversation sources without credentials or duplicates', (t) => {
  const a = fixture(t).s,
    b = fixture(t).s;
  const m = a.create({ title: 'Original', notes: 'Evidence' });
  a.setting('templates', [{ id: 'custom', name: 'My template', prompt: 'Summarize decisions.' }]);
  a.message('all', 'user', 'Question');
  a.message('all', 'assistant', 'Answer [1]', [{ id: m.id, number: 1, title: m.title }]);
  assert.equal(b.restore(a.backup()), 1);
  assert.equal(b.restore(a.backup()), 0);
  assert.equal(b.messages('all').length, 2);
  assert.equal(b.settings().templates[0].id, 'custom');
  assert.equal(b.messages('all')[1].sources[0].id, m.id);
  assert.ok(!JSON.stringify(a.backup()).includes('access_token'));
});
test('invalid imports are rejected before mutation', (t) => {
  const { s } = fixture(t);
  const existing = s.create({ title: 'Keep me' });
  const invalid = {
    version: 1,
    folders: [{ id: 'folder', name: 'Should not appear' }],
    meetings: [{ id: 'bad', title: 55 }],
  };
  assert.throws(() => s.restore(invalid));
  assert.equal(s.all().length, 1);
  assert.equal(s.folders().length, 0);
  assert.equal(s.get(existing.id).title, 'Keep me');
});
test('search safely handles punctuation and untrusted FTS syntax', (t) => {
  const { s } = fixture(t);
  s.create({ title: 'A quoted meeting', notes: 'C++ and (testing)' });
  assert.doesNotThrow(() => s.search('" OR *'));
  assert.equal(s.search('quoted').length, 1);
});
test('search finds words inside Chinese text, CJK phrases, and any word of a question', (t) => {
  const { s } = fixture(t);
  const pricing = s.create({
    title: '定价评审',
    notes: '我们用React开发新的定价页面。The Q4 headcount plan is final.',
  });
  const training = s.create({ title: 'Hiring', notes: 'Interview training starts next month.' });
  const korean = s.create({ title: 'Standup', notes: '회의를 시작합니다' });
  const ids = (results) => results.map((r) => r.id);
  assert.deepEqual(ids(s.search('react')), [pricing.id], 'an English word inside a Chinese run');
  assert.deepEqual(ids(s.search('定价页面')), [pricing.id]);
  assert.deepEqual(ids(s.search('页定')), [], 'characters must be adjacent, in order');
  assert.deepEqual(ids(s.search('Headcount pl')), [pricing.id], 'the last word may be unfinished');
  assert.deepEqual(ids(s.search('training headcount')), [], 'the search box wants every word');
  assert.deepEqual(ids(s.search('회의')), [korean.id]);
  assert.equal(s.search('When does interview training start?', { any: true })[0].id, training.id);
  assert.equal(s.search('定价页面什么时候上线？', { any: true })[0].id, pricing.id);
});
test('context is bounded without silent truncation and uses stable source ids', (t) => {
  const { s } = fixture(t);
  const m = s.create({ title: 'Evidence', notes: 'Source content' });
  assert.match(context([m]), /SOURCE \[1\]/);
  assert.match(context([m]), new RegExp(m.id));
  assert.match(markdown(m), /# Evidence/);
  assert.throws(() => context([{ ...m, notes: 'x'.repeat(350001) }]), /too large/);
});
function body(parts) {
  return (async function* () {
    for (const p of parts) yield new TextEncoder().encode(p);
  })();
}
test('SSE parser handles fragmented and CRLF events and requires completed response', async () => {
  const deltas = [];
  const answer = await consumeResponse(
    body([
      'data: {"type":"response.output_text.delta","delta":"Hel',
      'lo"}\r\n\r\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ]),
    (d) => deltas.push(d),
  );
  assert.equal(answer, 'Hello world');
  assert.deepEqual(deltas, ['Hello', ' world']);
});
test('partial, failed, and empty AI responses are never accepted as summaries', async () => {
  await assert.rejects(
    consumeResponse(body(['data: {"type":"response.output_text.delta","delta":"partial"}\n\n'])),
    /before ChatGPT finished/,
  );
  await assert.rejects(
    consumeResponse(
      body(['data: {"type":"response.failed","response":{"error":{"message":"usage limit"}}}\n\n']),
    ),
    /usage limit/,
  );
  await assert.rejects(consumeResponse(body(['data: {"type":"response.completed"}\n\n'])), /empty/);
});
