import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, chatContext, chatHistory, checkImportSize, validateLocale } from '../app/store.mjs';
import { contextHints, meetingEvents, helperRequests } from '../app/recordings.mjs';
import { modelCache } from '../app/providers/index.mjs';
import { consumeResponse } from '../app/stream.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-fixes-'));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir };
}
test('summary autosaves preserve the first AI version and its own timestamp', (t) => {
  const { store } = fixture(t);
  const m = store.create();
  store.update(m.id, { summary: 'AI draft' }, { summarySource: 'ai' });
  const original = store.get(m.id);
  store.write({ ...original, summaryAt: '2020-01-01T00:00:00.000Z' });
  store.update(m.id, { notes: 'Unrelated save' });
  for (let i = 0; i < 30; i++) store.update(m.id, { summary: `Edit ${i}` });
  assert.deepEqual(store.get(m.id).versions, [
    { text: 'AI draft', at: '2020-01-01T00:00:00.000Z' },
  ]);
  assert.equal(store.get(m.id).summarySource, 'edited');
  store.update(m.id, { summary: 'New AI' }, { summarySource: 'ai' });
  assert.equal(store.get(m.id).versions[0].text, 'Edit 29');
  assert.equal(store.get(m.id).summarySource, 'ai');
});
test('plain summary edits have no revisions; explicit snapshots cap at twenty', (t) => {
  const { store } = fixture(t);
  const { id } = store.create();
  store.update(id, { summary: 'First manual' });
  store.update(id, { summary: 'Second manual' });
  assert.equal(store.get(id).versions.length, 0);
  for (let i = 0; i < 25; i++)
    store.update(id, { summary: `Restored ${i}`, snapshotSummary: true });
  const m = store.get(id);
  assert.equal(m.versions.length, 20);
  assert.equal(m.versions[0].text, 'Restored 23');
  assert.equal('snapshotSummary' in m, false);
  const before = m.versions.length;
  store.update(id, { summary: m.summary });
  assert.equal(store.get(id).versions.length, before);
});
test('chat ranks FTS matches ahead of recency and fills around oversized meetings', (t) => {
  const { store } = fixture(t);
  const relevant = store.create({ title: 'Launch decision', notes: 'x'.repeat(160000) });
  store.write({ ...relevant, createdAt: '2020-01-01T00:00:00.000Z' });
  const recent = store.create({ title: 'Recent', notes: 'y'.repeat(160000) });
  const huge = store.create({ title: 'Too big', notes: 'z'.repeat(400000) });
  const small = store.create({ title: 'Fits', notes: 'Small evidence' });
  const result = chatContext(store.all(), store.search('Launch'));
  assert.equal(result.sources[0].id, relevant.id);
  assert.deepEqual(
    new Set(result.sources.map((s) => s.id)),
    new Set([relevant.id, recent.id, small.id]),
  );
  assert.deepEqual(result.context, { included: 3, total: 4 });
  assert.ok(result.source.length <= 350000);
  assert.ok(!result.sources.some((s) => s.id === huge.id));
  assert.deepEqual(
    result.sources.map((s) => s.number),
    [1, 2, 3],
  );
});
test('chat prioritizes summaries and notes and never silently cuts a transcript', (t) => {
  const { store } = fixture(t);
  const m = store.create({ title: 'Large transcript', notes: 'Keep this evidence' });
  store.append(m.id, { text: 'transcript-marker '.repeat(25000) });
  const result = chatContext(store.all());
  assert.match(result.source, /Keep this evidence/);
  assert.match(result.source, /"transcriptOmitted":true/);
  assert.ok(!result.source.includes('transcript-marker'));
  assert.throws(
    () => chatContext(store.all(), [], { single: true }),
    /Large transcript.*too large/,
  );
  const small = {
    ...store.get(m.id),
    transcript: [{ text: 'Complete transcript', timestamp: 0, speaker: 'You' }],
  };
  assert.match(chatContext([small]).source, /Complete transcript/);
  assert.ok(!chatContext([small]).source.includes('transcriptOmitted'));
});
test('chat recency tie-breaks nonmatches and handles no full source fitting', () => {
  const m = (id, date) => ({
    id,
    title: id,
    createdAt: date,
    notes: 'small',
    summary: '',
    transcript: [],
  });
  assert.deepEqual(
    chatContext([m('old', '2020'), m('new', '2026')]).sources.map((s) => s.id),
    ['new', 'old'],
  );
  assert.deepEqual(chatContext([m('huge', '2026')], [], { budget: 1 }).context, {
    included: 0,
    total: 1,
  });
});
test('history is bounded after expanding historical citations', () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: String(i) }));
  assert.equal(chatHistory(messages).length, 12);
  assert.equal(
    chatHistory(
      [
        {
          role: 'assistant',
          content: '[1]',
          sources: [{ number: 1, title: 'x'.repeat(100), id: 'a' }],
        },
      ],
      50,
    ).length,
    0,
  );
  assert.equal(chatHistory([{ role: 'user', content: 'x'.repeat(60001) }]).length, 0);
});
test('oversized transcript import leaves no meeting; successful import is atomic', (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.importFile('huge.TXT', 'x'.repeat(2000001)), /2,000,000-character/);
  assert.equal(store.all().length, 0);
  const original = store.index;
  store.index = () => {
    throw new Error('Index failure');
  };
  assert.throws(() => store.importFile('Valid.MD', 'evidence'), /Index failure/);
  assert.equal(store.all().length, 0);
  store.index = original;
  const { meeting } = store.importFile('Valid.MD', 'evidence');
  assert.equal(meeting.title, 'Valid');
  assert.equal(meeting.transcript[0].text, 'evidence');
  assert.equal(store.search('evidence')[0].id, meeting.id);
});
test('backup imports use case-insensitive extensions and portable settings only', (t) => {
  const a = fixture(t).store,
    b = fixture(t).store;
  a.create({ title: 'Backup' });
  a.setting('inputDevice', 'machine-uid');
  a.setting('provider', 'claude');
  a.setting('claudePath', '/tmp/program');
  a.setting('echoCancellation', 'off');
  a.setting('locale', 'yue-CN');
  const backup = a.backup();
  for (const key of ['inputDevice', 'provider', 'claudePath']) assert.ok(!(key in backup.settings));
  Object.assign(backup.settings, {
    inputDevice: 'untrusted',
    provider: 'claude',
    claudePath: '/tmp/untrusted',
    futureUnknown: true,
  });
  assert.equal(b.importFile('BACKUP.JSON', JSON.stringify(backup)).restored, 1);
  assert.equal(b.settings().inputDevice, null);
  assert.equal(b.settings().provider, undefined);
  assert.equal(b.settings().claudePath, undefined);
  assert.equal(b.settings().futureUnknown, undefined);
  assert.equal(b.settings().locale, 'yue-CN');
  assert.equal(b.settings().echoCancellation, 'off');
});
test('a notebook larger than the old 30 MB import limit backs up and restores', (t) => {
  const a = fixture(t).store,
    b = fixture(t).store;
  for (let i = 0; i < 16; i++)
    a.create({ title: `Long ${i}`, notes: `${i} `.padEnd(1_990_000, 'word ') });
  const file = JSON.stringify(a.backup());
  assert.ok(file.length > 30_000_000, 'the backup is above the old limit');
  assert.equal(b.importFile('Stillnote-backup.json', file).restored, 16);
  assert.equal(b.get(a.all()[0].id).notes, a.all()[0].notes);
});
test('imports are size-checked by kind before they are read', () => {
  assert.doesNotThrow(() => checkImportSize('Stillnote-backup.JSON', 250_000_000));
  assert.throws(() => checkImportSize('Stillnote-backup.json', 250_000_001), /250 MB/);
  assert.doesNotThrow(() => checkImportSize('call.vtt', 30_000_000));
  assert.throws(() => checkImportSize('call.txt', 30_000_001), /30 MB/);
});
test('a restore keeps line language, source and calendar link, and repairs odd backups', (t) => {
  const a = fixture(t).store,
    b = fixture(t).store;
  const m = a.create({ title: 'Standup', eventKey: 'standup@2026-10-24T09:00:00.000Z' });
  a.append(m.id, { text: '今天开会', speaker: 'You', source: 'microphone', locale: 'zh-CN' });
  const backup = a.backup();
  assert.ok(!('transcriptVersions' in backup.meetings[0]), 'earlier versions stay on this Mac');
  const [meeting] = backup.meetings;
  meeting.folderId = 'deleted-folder';
  meeting.versions = Array.from({ length: 25 }, (_, i) => ({
    text: `v${i}`,
    at: new Date().toISOString(),
    extra: 'x',
  }));
  backup.meetings.push({ ...meeting, title: 'Duplicate' });
  backup.messages = [
    { id: 'q', scope: 'all', role: 'user', content: 'Hi', sources: [], injected: 'x' },
  ];
  assert.equal(b.restore(backup), 1);
  const restored = b.get(m.id);
  assert.equal(restored.title, 'Standup');
  assert.equal(restored.eventKey, 'standup@2026-10-24T09:00:00.000Z');
  assert.deepEqual(
    restored.transcript.map((s) => [s.text, s.source, s.locale]),
    [['今天开会', 'microphone', 'zh-CN']],
  );
  assert.equal(restored.folderId, null);
  assert.equal(restored.versions.length, 20);
  assert.deepEqual(Object.keys(restored.versions[0]), ['text', 'at']);
  const [message] = b.messages('all');
  assert.equal(message.injected, undefined);
  assert.ok(Number.isFinite(Date.parse(message.createdAt)));
});
test('settings validate device, echo cancellation, and widened BCP-47 locales', (t) => {
  const { store } = fixture(t);
  assert.equal(store.settings().echoCancellation, 'auto');
  assert.equal(store.settings().locale, 'en-US');
  for (const locale of ['en-US', 'zh-Hant-TW', 'yue-CN', 'en', 'abc-12345678-AB'])
    store.setting('locale', locale);
  for (const locale of ['english', 'en_US', 'en-a', 'EN-us', 'en-US-x-test', null])
    assert.throws(() => store.setting('locale', locale));
  // Auto picks between two different languages; installing a language never accepts 'auto'.
  store.setting('locale', 'auto');
  store.setting('autoLocales', ['zh-CN', 'en-US']);
  for (const pair of [['zh-CN'], ['zh-CN', 'zh-CN'], ['zh-CN', 'english'], 'zh-CN,en-US'])
    assert.throws(() => store.setting('autoLocales', pair), /two different languages|recognition/);
  assert.throws(() => validateLocale('auto'), /Invalid recognition language/);
  for (const value of [null, 'CoreAudio:USB-123']) store.setting('inputDevice', value);
  for (const value of ['', 42, 'a\n', 'x'.repeat(1001)])
    assert.throws(() => store.setting('inputDevice', value));
  for (const value of ['auto', 'on', 'off']) store.setting('echoCancellation', value);
  for (const value of [true, null, 'maybe'])
    assert.throws(() => store.setting('echoCancellation', value));
});
test('context hints combine names, title, folder, and bounded distinctive terms', () => {
  assert.deepEqual(contextHints({ notes: 'カタカナ 한국어' }), ['カタカナ', '한국어']);
  const hints = contextHints(
    {
      title: 'Atlas planning',
      participants: 'Alice Smith, Bob & Carol and Dan',
      notes: 'Atlas handles Kubernetes and 机器人研究. ordinary words ignored.',
    },
    'Research',
  );
  assert.deepEqual(hints, [
    'Atlas',
    'planning',
    'Alice Smith',
    'Bob',
    'Carol',
    'Dan',
    'Research',
    'Kubernetes',
    '机器人研究',
  ]);
  const bounded = contextHints({
    title: 'x'.repeat(200),
    notes: Array.from(
      { length: 100 },
      (_, i) =>
        `Word${String.fromCharCode(65 + (i % 26))}word${String.fromCharCode(65 + Math.floor(i / 26))}`,
    ).join(' '),
  });
  assert.equal(bounded.length, 51);
  assert.ok(bounded.every((hint) => hint.length <= 100));
  assert.equal(
    contextHints({ title: Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ') }).length,
    100,
  );
});
test('old FTS schema migrates safely and idempotently with stable integer rowids', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-old-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(join(dir, 'notebook.sqlite'));
  db.exec(
    "CREATE TABLE meetings(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE VIRTUAL TABLE meeting_search USING fts5(id UNINDEXED, title, content, tokenize='unicode61');",
  );
  const meeting = {
    id: 'old',
    title: 'Legacy launch',
    notes: 'Search evidence',
    summary: '',
    transcript: [],
    versions: [],
    createdAt: '2020',
    updatedAt: '2020',
  };
  db.prepare('INSERT INTO meetings(rowid,id,data) VALUES(?,?,?)').run(
    42,
    meeting.id,
    JSON.stringify(meeting),
  );
  db.prepare('INSERT INTO meeting_search(rowid,id,title,content) VALUES(?,?,?,?)').run(
    7,
    meeting.id,
    meeting.title,
    meeting.notes,
  );
  db.close();
  const store = new Store(dir);
  assert.equal(store.search('evidence')[0].id, 'old');
  assert.equal(store.db.prepare('SELECT rowid FROM meeting_search').get().rowid, 42);
  store.update('old', { notes: 'Updated phrase' });
  assert.equal(store.search('evidence').length, 0);
  assert.equal(store.search('Updated')[0].id, 'old');
  assert.equal(store.db.prepare('SELECT rowid FROM meeting_search').get().rowid, 42);
  store.close();
  const reopened = new Store(dir);
  assert.equal(reopened.search('Updated').length, 1);
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM meeting_search').get().n, 1);
  reopened.update('old', { deletedAt: true });
  assert.equal(reopened.search('Updated').length, 0);
  reopened.close();
});
test('stream parser ignores non-string text deltas', async () => {
  const deltas = [];
  const events = [null, 7, {}, 'valid'].map((delta) => ({
    type: 'response.output_text.delta',
    delta,
  }));
  events.push({ type: 'response.completed' });
  const body = (async function* () {
    yield Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  })();
  assert.equal(await consumeResponse(body, (delta) => deltas.push(delta)), 'valid');
  assert.deepEqual(deltas, ['valid']);
});
test('native requests guard concurrent operations, match replies, time out and recover', async () => {
  const sent = [];
  const requests = helperRequests((command) => sent.push(command));
  const pending = requests.request('devices');
  await assert.rejects(requests.request('devices'), /already/);
  requests.receive({ type: 'devices', inputs: [] });
  assert.deepEqual((await pending).inputs, []);
  const install = requests.request('install-language', { locale: 'zh-CN' });
  assert.equal(
    requests.receive({ type: 'language-installed', locale: 'en-US', installed: [] }),
    false,
  );
  requests.receive({
    type: 'error',
    op: 'install-language',
    locale: 'zh-CN',
    message: 'Download failed',
  });
  await assert.rejects(install, /Download failed/);
  await assert.rejects(requests.request('languages', {}, 1), /timed out/);
  const retry = requests.request('languages');
  requests.reject(new Error('Helper exited'));
  await assert.rejects(retry, /Helper exited/);
  assert.equal(sent.length, 4);
});
test('recording meeting events coalesce at 4/s and final flush sends latest state', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let current = 0;
  const events = [];
  const updates = meetingEvents(
    (id) => ({ id, current }),
    (e) => events.push(e),
  );
  for (let i = 0; i < 100; i++) {
    current++;
    updates.schedule('meeting');
  }
  t.mock.timers.tick(249);
  assert.equal(events.length, 0);
  t.mock.timers.tick(1);
  assert.equal(events.length, 1);
  assert.equal(events[0].meeting.current, 100);
  for (let i = 0; i < 3; i++) {
    updates.schedule('meeting');
    t.mock.timers.tick(250);
  }
  assert.equal(events.length, 4);
  updates.schedule('meeting');
  current = 101;
  updates.flush('meeting');
  t.mock.timers.tick(250);
  assert.equal(events.length, 5);
  assert.equal(events.at(-1).meeting.current, 101);
});
test('model lists cache per account, expire and fall back to the saved model', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const cache = modelCache();
  let calls = 0;
  const provider = {
    models: async () => {
      calls++;
      return [{ id: 'current' }];
    },
  };
  await cache.get(provider, 'account1');
  await cache.get(provider, 'account1');
  assert.equal(calls, 1);
  await cache.get(provider, 'account2');
  assert.equal(calls, 2);
  t.mock.timers.tick(180001);
  await cache.get(provider, 'account1');
  assert.equal(calls, 3);
  cache.clear();
  provider.models = async () => {
    throw new Error('Offline');
  };
  assert.deepEqual(await cache.get(provider, 'account1', 'saved'), [
    { id: 'saved', name: 'saved' },
  ]);
  await assert.rejects(cache.get(provider, 'account1'), /Offline/);
});

test('notes take budget priority over transcript-only meetings, even when ranked lower', () => {
  const transcript = {
    id: 'first',
    title: 'First',
    createdAt: '2026',
    notes: '',
    summary: '',
    transcript: [{ text: 'a'.repeat(250), timestamp: 0, speaker: 'You' }],
  };
  const notes = {
    id: 'second',
    title: 'Second',
    createdAt: '2025',
    notes: 'b'.repeat(250),
    summary: '',
    transcript: [],
  };
  const result = chatContext([transcript, notes], [transcript], { budget: 450 });
  assert.deepEqual(
    result.sources.map((s) => s.id),
    ['second'],
  );
  assert.ok(result.source.length <= 450);
});
