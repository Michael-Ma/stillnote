import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  granolaMeetings,
  granolaNotes,
  granolaRange,
  granolaTranscriptPage,
} from '../app/importers/granola.mjs';
import { notionId, notionPage, notionPages } from '../app/importers/notion.mjs';
import { sourceImport } from '../app/source-import.mjs';
import { Store } from '../app/store.mjs';

// Answers in the shapes these apps document or are likely to send; the content is invented.
const text = (value) => ({ content: [{ type: 'text', text: value }] });
const json = (value) => text(JSON.stringify(value));
const PAGE = '0123456789abcdef0123456789abcdef';
const PAGE_ID = '01234567-89ab-cdef-0123-456789abcdef';

test('Granola meeting lists, as JSON or tagged text, with cursors and people', () => {
  assert.deepEqual(
    granolaMeetings({
      structuredContent: {
        meetings: [
          {
            id: 'm1',
            title: 'Pricing review',
            date: '2026-10-01T15:00:00Z',
            attendees: [{ name: 'Ada Lovelace' }, { email: 'alan@example.test' }],
          },
          { title: 'no id is skipped' },
        ],
        next_cursor: 'c2',
      },
    }),
    {
      meetings: [
        {
          id: 'm1',
          title: 'Pricing review',
          date: '2026-10-01T15:00:00.000Z',
          participants: 'Ada Lovelace, alan@example.test',
        },
      ],
      cursor: 'c2',
    },
  );
  assert.deepEqual(
    granolaMeetings(
      text(
        '<meetings>\n<meeting id="m2" title="Plans &amp; pricing" date="2026-10-02T09:30:00Z">\n<known_participants>Ada Lovelace <ada@example.test>, Alan Turing</known_participants>\n</meeting>\n</meetings>',
      ),
    ),
    {
      meetings: [
        {
          id: 'm2',
          title: 'Plans & pricing',
          date: '2026-10-02T09:30:00.000Z',
          participants: 'Ada Lovelace, Alan Turing',
        },
      ],
      cursor: null,
    },
  );
});

test('Granola notes: private notes and the AI summary, or the raw answer for one meeting', () => {
  const found = granolaNotes(
    text(
      '<meeting id="m1" title="Pricing review" date="2026-10-01T15:00:00Z"><private_notes>- ask about seats</private_notes><summary>## Decisions\n- Ship the team plan</summary></meeting>',
    ),
    ['m1'],
  );
  assert.deepEqual(found.get('m1'), {
    title: 'Pricing review',
    createdAt: '2026-10-01T15:00:00.000Z',
    participants: '',
    notes: '- ask about seats',
    summary: '## Decisions\n- Ship the team plan',
  });
  const json = granolaNotes({
    structuredContent: {
      meetings: [{ id: 'm3', title: 'Standup', notes: { markdown: 'Blocked on QA' } }],
    },
  });
  assert.equal(json.get('m3').notes, 'Blocked on QA');
  assert.equal(
    granolaNotes(text('Some answer we cannot read'), ['m9']).get('m9').notes,
    'Some answer we cannot read',
  );
  assert.equal(granolaNotes(text('Unreadable'), ['a', 'b']).size, 0);
});

test('Granola transcripts page by offset and time ranges become tool arguments', () => {
  assert.deepEqual(
    granolaTranscriptPage(json({ transcript: '[0:05] Me: Hello', next_offset: 40 })),
    {
      text: '[0:05] Me: Hello',
      next: 40,
    },
  );
  assert.deepEqual(granolaTranscriptPage(text('<transcript>[0:07] Them: Hi</transcript>')), {
    text: '[0:07] Them: Hi',
    next: null,
  });
  assert.deepEqual(granolaRange('last_7_days'), { time_range: 'last_7_days' });
  assert.deepEqual(granolaRange('last_90_days', new Date('2026-10-30T12:00:00Z')), {
    time_range: 'custom',
    from_date: '2026-08-01',
    to_date: '2026-10-30',
  });
});

test('Notion search results are pages with ids; databases and repeats are left out', () => {
  assert.equal(notionId(`https://www.notion.so/Weekly-sync-${PAGE}?pvs=4`), PAGE_ID);
  assert.equal(notionId(PAGE_ID), PAGE_ID);
  assert.equal(notionId('not a page'), null);
  assert.deepEqual(
    notionPages(
      json({
        type: 'workspace_search',
        results: [
          {
            id: PAGE_ID,
            title: 'Weekly sync',
            url: `https://www.notion.so/${PAGE}`,
            type: 'page',
            timestamp: '2026-10-02T17:00:00Z',
          },
          { id: 'ffffffffffffffffffffffffffffffff', title: 'Tasks', type: 'database' },
          { title: 'Weekly sync again', url: `https://www.notion.so/x-${PAGE}`, type: 'page' },
        ],
      }),
    ),
    [
      {
        id: PAGE_ID,
        title: 'Weekly sync',
        date: '2026-10-02T17:00:00.000Z',
        url: `https://www.notion.so/${PAGE}`,
      },
    ],
  );
});

test('a Notion page: properties, AI meeting notes, transcript, and the rest as notes', () => {
  const note = notionPage(
    json({
      title: 'Weekly sync',
      url: `https://www.notion.so/${PAGE}`,
      text: `<page url="https://www.notion.so/${PAGE}"><properties>{"title":"Weekly sync","date:Date:start":"2026-10-02T10:00:00.000-07:00","Attendees":"[\\"Ada Lovelace\\",\\"user://abc\\"]"}</properties><content># Agenda\n<mention-user url="user://1">Ada</mention-user> presents the plan.\n<meeting-notes>Weekly sync<summary>- Launch on Monday</summary><notes>Rough idea</notes><transcript>Ada: Hello everyone\nAlan: Hi there\nAda: Let us begin</transcript></meeting-notes></content></page>`,
    }),
  );
  assert.equal(note.title, 'Weekly sync');
  assert.equal(note.createdAt, '2026-10-02T17:00:00.000Z');
  assert.equal(note.participants, 'Ada Lovelace');
  assert.equal(note.summary, '- Launch on Monday');
  assert.equal(note.notes, 'Rough idea\n\n# Agenda\nAda presents the plan.');
  assert.deepEqual(
    note.transcript.map((s) => [s.speaker, s.text]),
    [
      ['Ada', 'Hello everyone'],
      ['Alan', 'Hi there'],
      ['Ada', 'Let us begin'],
    ],
  );
  // A plain page: Markdown sections still give the summary.
  const plain = notionPage(text('## Summary\n- One thing\n\n## Next\nOther notes'), 'Fallback');
  assert.equal(plain.title, 'Fallback');
  assert.equal(plain.summary, '- One thing');
  assert.equal(plain.notes, '## Next\nOther notes');
});

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-source-'));
  const s = new Store(dir);
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return s;
}

test('importing from Granola: listed, chosen, transcripts paged, never copied twice', async (t) => {
  const s = store(t);
  const calls = [];
  const tools = {
    list_meetings: (args) =>
      args.cursor
        ? json({ meetings: [{ id: 'm2', title: 'Retro', date: '2026-10-20T10:00:00Z' }] })
        : json({
            meetings: [{ id: 'm1', title: 'Pricing review', date: '2026-10-21T10:00:00Z' }],
            next_cursor: 'p2',
          }),
    get_meetings: ({ meeting_ids }) =>
      json({
        meetings: meeting_ids.map((id) => ({
          id,
          title: id === 'm1' ? 'Pricing review' : 'Retro',
          private_notes: `notes ${id}`,
          summary: `summary ${id}`,
        })),
      }),
    get_meeting_transcript: ({ meeting_id, offset }) => {
      if (meeting_id === 'm2') throw new Error('Transcripts need a paid Granola plan.');
      return offset
        ? json({ transcript: '\n[0:20] Them: Agreed.' })
        : json({ transcript: '[0:05] Me: Shall we ship?', next_offset: 25 });
    },
  };
  const connections = {
    tool: async (source, name, args) => {
      calls.push([source, name, args]);
      return tools[name](args);
    },
    tools: async () => [],
  };
  const progress = [];
  const importer = sourceImport({
    connections,
    store: s,
    progress: (p) => progress.push(p.done),
    now: () => new Date('2026-10-30T12:00:00Z'),
  });
  const listed = await importer.list('granola', { range: 'last_30_days' });
  assert.deepEqual(
    listed.map((m) => [m.id, m.title, m.imported]),
    [
      ['m1', 'Pricing review', false],
      ['m2', 'Retro', false],
    ],
  );
  assert.deepEqual(calls[1][2], { time_range: 'last_30_days', cursor: 'p2' });
  const result = await importer.run('granola', ['m1', 'm2']);
  assert.equal(result.meetings.length, 2);
  assert.equal(result.withoutTranscript, 1);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(progress, [0, 1, 2]);
  const pricing = s.all().find((m) => m.title === 'Pricing review');
  assert.equal(pricing.sourceKey, 'granola:m1');
  assert.equal(pricing.notes, 'notes m1');
  assert.equal(pricing.summary, 'summary m1');
  assert.equal(pricing.createdAt, '2026-10-21T10:00:00.000Z');
  assert.deepEqual(
    pricing.transcript.map((x) => [x.speaker, x.timestamp, x.text]),
    [
      ['Me', 5, 'Shall we ship?'],
      ['Them', 20, 'Agreed.'],
    ],
  );
  // Listed again, both show as imported; importing them again adds nothing.
  assert.ok((await importer.list('granola', {})).every((m) => m.imported));
  const again = await importer.run('granola', ['m1', 'm2', 'm1']);
  assert.deepEqual(again.meetings, []);
  assert.equal(again.duplicates, 2);
  assert.equal(s.all().length, 2);
  await assert.rejects(importer.run('granola', []), /Choose what to import/);
  // An answer with meetings in it that Stillnote cannot read is an error, not an empty list.
  tools.list_meetings = () => text('• 3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8 — Weekly sync');
  await assert.rejects(importer.list('granola', {}), /could not read the meeting list/);
  tools.list_meetings = () => json({ meetings: [] });
  assert.deepEqual(await importer.list('granola', {}), []);
  await assert.rejects(importer.run('granola', [5]), /Choose what to import/);
  await assert.rejects(importer.list('evernote', {}), /Unknown app/);
});

test('importing from Notion uses the tool’s own argument names and reports failed pages', async (t) => {
  const s = store(t);
  const calls = [];
  const connections = {
    tools: async () => [
      {
        name: 'notion-search',
        inputSchema: { required: ['query'], properties: { query: { type: 'string' } } },
      },
      {
        name: 'notion-fetch',
        inputSchema: { required: ['id'], properties: { id: { type: 'string' } } },
      },
    ],
    tool: async (source, name, args) => {
      calls.push([name, args]);
      if (name === 'notion-search')
        return json({
          results: [
            { id: PAGE_ID, title: 'Weekly sync', type: 'page' },
            { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', title: 'Broken', type: 'page' },
          ],
        });
      if (args.id === PAGE_ID)
        return json({
          title: 'Weekly sync',
          text: '<page><content>Decisions here</content></page>',
        });
      throw new Error('Could not load page.');
    },
  };
  const importer = sourceImport({ connections, store: s });
  const pages = await importer.list('notion', { query: '  ' });
  assert.deepEqual(calls[0], ['notion-search', { query: 'meeting' }]);
  assert.equal(pages.length, 2);
  const result = await importer.run(
    'notion',
    pages.map((p) => p.id),
  );
  assert.equal(result.meetings.length, 1);
  assert.equal(result.withoutTranscript, null);
  assert.deepEqual(result.failed, [
    { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', title: 'Broken', reason: 'Could not load page.' },
  ]);
  assert.equal(s.all()[0].notes, 'Decisions here');
  assert.equal(s.all()[0].sourceKey, `notion:${PAGE_ID}`);
});
