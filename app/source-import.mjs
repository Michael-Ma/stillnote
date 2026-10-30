// Importing from a connected app (app/mcp-auth.mjs): list what is there, then bring the chosen
// items in as notes, each marked with where it came from so it is never copied twice.
// `connections` calls the apps' tools, `store` writes, `progress` hears how far an import is.
import {
  granolaMeetings,
  granolaNotes,
  granolaRange,
  granolaTranscript,
  granolaTranscriptPage,
} from './importers/granola.mjs';
import { notionPage, notionPages } from './importers/notion.mjs';

const MAX_ITEMS = 1000;
// An answer with ids in it that gave no items is one Stillnote could not read, not an empty list.
const unread = (result) => {
  const raw = JSON.stringify(result ?? '');
  return /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i.test(raw);
};
const valid = (ids) => {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 500 ||
    !ids.every((id) => typeof id === 'string' && id && id.length <= 200)
  )
    throw new Error('Choose what to import.');
  return [...new Set(ids)];
};

export function sourceImport({ connections, store, progress = () => {}, now = () => new Date() }) {
  // What the last list showed, for titles and dates an item's own answer leaves out.
  const listed = { granola: new Map(), notion: new Map() };
  // The name of a tool's main argument, from the server's own schema when it gives one.
  const argumentNames = {};
  async function argumentName(source, tool, fallback) {
    if (!(tool in argumentNames)) {
      const found = await connections.tools(source).catch(() => []);
      const schema = found.find((item) => item.name === tool)?.inputSchema;
      const name = schema?.required?.find((key) => schema.properties?.[key]?.type === 'string');
      argumentNames[tool] = name ?? fallback;
    }
    return argumentNames[tool];
  }
  const already = (source) =>
    new Set(
      store
        .all(true)
        .map((m) => m.sourceKey)
        .filter((key) => key?.startsWith(source + ':')),
    );
  const remember = (source, items) => {
    const seen = already(source);
    for (const item of items) listed[source].set(item.id, item);
    return items.map((item) => ({ ...item, imported: seen.has(`${source}:${item.id}`) }));
  };

  async function granolaList({ range } = {}) {
    const meetings = new Map();
    let cursor = null;
    for (let page = 0; page < 20 && meetings.size < MAX_ITEMS; page++) {
      const result = await connections.tool('granola', 'list_meetings', {
        ...granolaRange(range, now()),
        ...(cursor ? { cursor } : {}),
      });
      const answer = granolaMeetings(result);
      if (!answer.meetings.length && !meetings.size && unread(result))
        throw new Error('Stillnote could not read the meeting list from Granola.');
      for (const m of answer.meetings) meetings.set(m.id, m);
      if (!answer.cursor || answer.cursor === cursor) break;
      cursor = answer.cursor;
    }
    return [...meetings.values()].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  }
  async function notionList({ query } = {}) {
    const words = typeof query === 'string' ? query.trim().slice(0, 200) : '';
    const name = await argumentName('notion', 'notion-search', 'query');
    const result = await connections.tool('notion', 'notion-search', {
      [name]: words || 'meeting',
    });
    const pages = notionPages(result);
    if (!pages.length && unread(result))
      throw new Error('Stillnote could not read the search results from Notion.');
    return pages;
  }

  // Every page of one meeting's transcript; a plan without transcripts gives none.
  async function granolaTranscriptFor(id) {
    let text = '',
      offset = 0;
    for (let page = 0; page < 25; page++) {
      const answer = granolaTranscriptPage(
        await connections.tool('granola', 'get_meeting_transcript', {
          meeting_id: id,
          include_timestamps: true,
          max_chars: 80_000,
          ...(offset ? { offset } : {}),
        }),
      );
      text += answer.text;
      if (!answer.next || answer.next <= offset) break;
      offset = answer.next;
    }
    return granolaTranscript(text);
  }
  async function granolaNotesFor(ids, report) {
    const notes = [],
      failed = [];
    let withoutTranscript = 0;
    for (let at = 0; at < ids.length; at += 10) {
      const batch = ids.slice(at, at + 10);
      let found = new Map();
      try {
        found = granolaNotes(
          await connections.tool('granola', 'get_meetings', { meeting_ids: batch }),
          batch,
        );
      } catch (error) {
        for (const id of batch) failed.push({ id, reason: error.message });
        report(batch.length);
        continue;
      }
      for (const id of batch) {
        const item = found.get(id),
          shown = listed.granola.get(id);
        if (!item && !shown) {
          failed.push({ id, reason: 'Granola did not return this meeting.' });
          report(1);
          continue;
        }
        let transcript = [];
        try {
          transcript = await granolaTranscriptFor(id);
        } catch {}
        if (!transcript.length) withoutTranscript++;
        notes.push({
          title: item?.title || shown?.title || 'Granola meeting',
          createdAt: item?.createdAt ?? shown?.date ?? null,
          participants: item?.participants || shown?.participants || '',
          notes: item?.notes ?? '',
          summary: item?.summary ?? '',
          transcript,
          sourceKey: `granola:${id}`,
        });
        report(1);
      }
    }
    return { notes, failed, withoutTranscript };
  }
  async function notionNotesFor(ids, report) {
    const notes = [],
      failed = [];
    const name = await argumentName('notion', 'notion-fetch', 'id');
    for (const id of ids) {
      try {
        const page = notionPage(
          await connections.tool('notion', 'notion-fetch', { [name]: id }),
          listed.notion.get(id)?.title ?? '',
        );
        notes.push({
          ...page,
          createdAt: page.createdAt ?? listed.notion.get(id)?.date ?? null,
          sourceKey: `notion:${id}`,
        });
      } catch (error) {
        failed.push({ id, reason: error.message });
      }
      report(1);
    }
    return { notes, failed, withoutTranscript: 0 };
  }

  return {
    async list(source, input) {
      if (source === 'granola') return remember(source, await granolaList(input));
      if (source === 'notion') return remember(source, await notionList(input));
      throw new Error('Unknown app.');
    },
    async run(source, chosen) {
      if (!['granola', 'notion'].includes(source)) throw new Error('Unknown app.');
      const seen = already(source);
      const unique = valid(chosen);
      const ids = unique.filter((id) => !seen.has(`${source}:${id}`));
      let done = 0;
      const report = (n) => progress({ source, done: (done += n), total: ids.length });
      progress({ source, done, total: ids.length });
      const { notes, failed, withoutTranscript } =
        source === 'granola'
          ? await granolaNotesFor(ids, report)
          : await notionNotesFor(ids, report);
      const { meetings, duplicates } = store.importNotes(notes);
      return {
        meetings: meetings.map((m) => m.id),
        duplicates: duplicates + (unique.length - ids.length),
        failed: failed.map(({ id, reason }) => ({
          id,
          title: listed[source].get(id)?.title ?? id,
          reason,
        })),
        withoutTranscript: source === 'granola' ? withoutTranscript : null,
      };
    },
  };
}
