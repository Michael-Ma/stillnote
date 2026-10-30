import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectImportFiles,
  fileTitle,
  parseCues,
  parseDate,
  parseNoteFile,
  parseTextTranscript,
  seconds,
} from '../app/import-formats.mjs';
import { Store } from '../app/store.mjs';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/import/${name}`, import.meta.url), 'utf8');
const parse = (name) => parseNoteFile(name, fixture(name));
const rows = (note) =>
  note.transcript.map(({ speaker, timestamp, text }) => [speaker, timestamp, text]);

test('timestamps in captions and transcripts become seconds', () => {
  assert.equal(seconds('00:00:01.200'), 1.2);
  assert.equal(seconds('01:02:03,500'), 3723.5);
  assert.equal(seconds('2:03'), 123);
  assert.equal(seconds('75:10'), 4510);
  assert.equal(seconds('soon'), null);
  assert.equal(seconds('1:2'), null);
});

test('Zoom captions name speakers by prefix; one speaker’s phrases become one row', () => {
  const note = parse('zoom.vtt');
  assert.equal(note.title, 'zoom');
  assert.equal(note.notes, '');
  assert.deepEqual(rows(note), [
    ['Alex Kim', 1.2, "Thanks everyone for joining. Let's review the launch plan."],
    ['Priya Shah', 8, 'The beta opens on Monday.'],
  ]);
});

test('Teams captions name speakers by voice tag, decode entities, skip notes, join CJK', () => {
  assert.deepEqual(rows(parse('teams.vtt')), [
    ['Jordan Lee', 0, 'Good morning, can you hear me?'],
    ['Sam Rivera', 3.5, 'Yes & the slides are up.'],
    ['王芳', 62, '我们下周发布。'],
  ]);
});

test('SRT subtitles without speakers keep their times under the imported label', () => {
  assert.deepEqual(rows(parse('captions.srt')), [
    ['Imported transcript', 1, 'Welcome to the quarterly review. Revenue grew in every region.'],
  ]);
  assert.throws(() => parseNoteFile('empty.srt', '1\n\nnothing here'), /No captions/);
});

test('Otter text exports: a speaker and time line, then their words', () => {
  assert.deepEqual(rows(parse('otter.txt')), [
    ['Speaker 1', 0, "Okay, let's get started with the roadmap."],
    ['Michael Ma', 15, 'I think we should ship search first. It unblocks the sales team.'],
    ['Speaker 1', 62, 'Agreed.'],
  ]);
});

test('timed "Name: text" lines, with continuation lines joining the row above', () => {
  assert.deepEqual(rows(parse('bracketed.txt')), [
    ['Dana', 5, 'Can we move the deadline?'],
    ['Lee', 9, 'Only by a week. because QA needs the time.'],
    ['Dana', 15, 'That works.'],
  ]);
});

test('untimed "Name: text" lines are a transcript; ordinary text is notes', () => {
  assert.deepEqual(rows(parse('granola-copy.txt')), [
    ['Me', 0, 'How did the pilot go?'],
    ['Them', 0, 'Usage doubled in the second week.'],
    ['Me', 0, "Great, let's expand it."],
  ]);
  const notes = parse('notes.txt');
  assert.deepEqual(notes.transcript, []);
  assert.match(notes.notes, /^Ideas for the offsite\n- Book the venue/);
  assert.match(notes.notes, /Budget: around 5k$/);
  assert.equal(parseTextTranscript('Note: call back later\nThe rest of the plan.'), null);
  assert.equal(parseTextTranscript('10:30 we start\n11:00 we stop\nlunch after'), null);
});

test('a Notion export: title, properties, Summary and Transcript sections; the rest is notes', () => {
  const note = parse('Weekly product sync 0123456789abcdef0123456789abcdef.md');
  assert.equal(note.title, 'Weekly product sync');
  assert.equal(note.createdAt, new Date(2026, 9, 3, 10, 0).toISOString());
  assert.equal(note.participants, 'Alice Chen, Bob Park');
  assert.equal(note.summary, '- Beta ships Monday.\n- Bob owns the release notes.');
  assert.equal(
    note.notes,
    'Tags: Product\n\n## Notes\n\nDiscussed beta scope.\n\n### Open questions\n\nPricing for teams.',
  );
  assert.deepEqual(rows(note), [
    ['Alice Chen', 1, "Let's start with the beta."],
    ['Bob Park', 12, 'Release notes are drafted.'],
  ]);
});

test('Markdown front matter gives the title, date and attendees', () => {
  const note = parse('obsidian.md');
  assert.equal(note.title, 'Customer call: Acme');
  assert.equal(note.createdAt, new Date('2026-09-14').toISOString());
  assert.equal(note.participants, 'Dana Ruiz, Lee Wong');
  assert.equal(note.notes, 'Pricing concerns came up twice.');
  // A heading that is not the first line, or text under it, is never the title.
  const plain = parseNoteFile('Plan.md', 'Intro line\n# Later heading\nBody');
  assert.equal(plain.title, 'Plan');
  assert.equal(plain.notes, 'Intro line\n# Later heading\nBody');
  // Lines like "Agenda: …" under a title are notes unless the block names a date or people.
  assert.equal(
    parseNoteFile('a.md', '# Sync\n\nAgenda: pricing\n\nText').notes,
    'Agenda: pricing\n\nText',
  );
});

test('dates in the shapes other tools write; implausible ones are ignored', () => {
  assert.equal(
    parseDate('@October 3, 2026 10:00 AM (PDT)'),
    new Date(2026, 9, 3, 10).toISOString(),
  );
  assert.equal(
    parseDate('October 3, 2026 10:00 AM → 11:00 AM'),
    new Date(2026, 9, 3, 10).toISOString(),
  );
  assert.equal(parseDate('2026年10月3日 14:30'), new Date(2026, 9, 3, 14, 30).toISOString());
  assert.equal(parseDate('2026/10/03 10:00'), new Date(2026, 9, 3, 10).toISOString());
  assert.equal(parseDate('soon'), null);
  assert.equal(parseDate('1970-01-01'), null);
  assert.equal(parseDate('2999-01-01'), null);
});

test('file titles drop the extension and a Notion page id; bad files are refused', () => {
  assert.equal(fileTitle('/x/Weekly sync 0123456789abcdef0123456789abcdef.md'), 'Weekly sync');
  assert.equal(fileTitle('Retro 2026.10.03.txt'), 'Retro 2026.10.03');
  assert.throws(() => parseNoteFile('a.pdf', 'x'), /Unsupported/);
  assert.throws(() => parseNoteFile('a.md', ' \n\n'), /empty/);
  assert.throws(() => parseNoteFile('a.txt', 'x'.repeat(2_000_001)), /2,000,000-character/);
  assert.deepEqual(parseCues('WEBVTT\n\nNOTE only\n'), []);
});

test('imported notes are written together, keep their dates, and are not copied twice', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-import-'));
  const s = new Store(dir);
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const notion = {
    ...parse('Weekly product sync 0123456789abcdef0123456789abcdef.md'),
    sourceKey: 'file:a',
  };
  const first = s.importNotes([notion, { ...parse('otter.txt'), sourceKey: 'file:b' }]);
  assert.equal(first.meetings.length, 2);
  const m = s.get(first.meetings[0].id);
  assert.equal(m.createdAt, notion.createdAt);
  assert.equal(m.summarySource, 'edited');
  assert.equal(m.participants, 'Alice Chen, Bob Park');
  assert.equal(m.transcript.length, 2);
  assert.ok(m.transcript.every((segment) => segment.id));
  assert.equal(s.search('drafted')[0].id, m.id);
  assert.equal(s.search('roadmap')[0].id, first.meetings[1].id);
  // Again, with one new file: only the new one is added.
  const again = s.importNotes([notion, { ...parse('notes.txt'), sourceKey: 'file:c' }]);
  assert.equal(again.duplicates, 1);
  assert.equal(again.meetings.length, 1);
  assert.equal(s.all().length, 3);
  // A backup keeps where a note came from, so a restored notebook still recognises it.
  const restoredDir = mkdtempSync(join(tmpdir(), 'stillnote-import-'));
  const restored = new Store(restoredDir);
  t.after(() => {
    restored.close();
    rmSync(restoredDir, { recursive: true, force: true });
  });
  restored.restore(JSON.parse(JSON.stringify(s.backup())));
  assert.equal(restored.importNotes([notion]).duplicates, 1);
  // Nothing is written when one note in the batch is invalid.
  assert.throws(() =>
    s.importNotes([
      parse('zoom.vtt'),
      { title: 'Bad', transcript: [{ text: 'x', timestamp: -1 }] },
    ]),
  );
  assert.equal(s.all().length, 3);
});

test('a chosen folder brings its note files, not hidden ones, links or other files', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-collect-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'export', 'Page', '.obsidian'), { recursive: true });
  for (const name of ['export/b.md', 'export/a.TXT', 'export/Page/c.vtt', 'export/Page/d.png'])
    writeFileSync(join(dir, name), 'x');
  writeFileSync(join(dir, 'export', 'Page', '.obsidian', 'e.md'), 'x');
  writeFileSync(join(dir, 'export', 'data.json'), '{}');
  writeFileSync(join(dir, 'backup.json'), '{}');
  symlinkSync(join(dir, 'backup.json'), join(dir, 'export', 'link.md'));
  const files = collectImportFiles([join(dir, 'export'), join(dir, 'backup.json')], fs);
  assert.deepEqual(
    files.map((f) => f.slice(dir.length + 1)),
    ['export/Page/c.vtt', 'export/a.TXT', 'export/b.md', 'backup.json'],
  );
  assert.throws(() => collectImportFiles([join(dir, 'export')], fs, 2), /at most 2,000 files/);
});
