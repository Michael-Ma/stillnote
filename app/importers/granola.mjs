// Granola's MCP tools (https://mcp.granola.ai/mcp) read into Stillnote notes. Pure. Granola
// documents its tools, not the exact shape of their answers, so JSON and XML-like text are both
// read, and a meeting whose answer cannot be read keeps the answer's text as its notes.
import { parseDate } from '../import-formats.mjs';
import {
  child,
  elements,
  names,
  pick,
  records,
  resultData,
  transcriptRows,
  withoutTags,
} from './tool-output.mjs';
import { resultText } from '../mcp-client.mjs';

const ID = ['id', 'meeting_id', 'document_id', 'note_id', 'uuid'];
const TITLE = ['title', 'name', 'meeting_title'];
const DATE = ['date', 'start', 'start_time', 'started_at', 'created_at', 'meeting_date', 'time'];
const PEOPLE = ['attendees', 'participants', 'known_participants', 'people'];
const NOTES = ['private_notes', 'notes', 'my_notes', 'user_notes'];
const SUMMARY = ['summary', 'summarized_notes', 'enhanced_notes', 'ai_notes', 'ai_summary'];
const TAG = 'meeting|note|document';
const tagOf = (keys) => keys.join('|');

// The list_meetings time ranges Stillnote offers, as the tool's arguments.
export function granolaRange(range, now = new Date()) {
  if (range === 'last_7_days' || range === 'last_30_days') return { time_range: range };
  const days = { last_90_days: 90, last_year: 365, everything: 365 * 15 }[range] ?? 30;
  const from = new Date(now.getTime() - days * 86_400_000);
  return {
    time_range: 'custom',
    from_date: from.toISOString().slice(0, 10),
    to_date: now.toISOString().slice(0, 10),
  };
}

const meeting = (fields) => ({
  id: String(fields.id),
  title: withoutTags(fields.title ?? '') || 'Granola meeting',
  date: parseDate(fields.date),
  participants: names(fields.participants),
});

// list_meetings → { meetings: [{ id, title, date (ISO or null), participants }], cursor }.
export function granolaMeetings(result) {
  const data = resultData(result);
  if (typeof data === 'object') {
    const meetings = (records(data, ID) ?? [])
      .map((item) => ({
        id: pick(item, ID),
        title: pick(item, TITLE),
        date: pick(item, DATE),
        participants: pick(item, PEOPLE),
      }))
      .filter((item) => item.id)
      .map(meeting);
    return { meetings, cursor: pick(data, ['next_cursor', 'nextCursor']) ?? null };
  }
  const meetings = elements(data, TAG)
    .map(({ attrs, body }) => ({
      id: attrs.id ?? attrs.meeting_id ?? child(body, tagOf(ID)),
      title: attrs.title ?? child(body, tagOf(TITLE)),
      date: attrs.date ?? attrs.start ?? child(body, tagOf(DATE)),
      participants: child(body, tagOf(PEOPLE)),
    }))
    .filter((item) => item.id)
    .map(meeting);
  const cursor =
    child(data, 'next_cursor') ||
    /next_cursor["']?\s*[:=]\s*["']?([\w-]+)/i.exec(data)?.[1] ||
    null;
  return { meetings, cursor };
}

// get_meetings → Map id → { title, createdAt, participants, notes, summary }. With one meeting
// asked for and an answer Stillnote cannot read, that answer's text is the meeting's notes.
export function granolaNotes(result, ids = []) {
  const data = resultData(result);
  const found = new Map();
  const add = (fields) => {
    if (!fields.id) return;
    found.set(String(fields.id), {
      title: withoutTags(fields.title ?? ''),
      createdAt: parseDate(fields.date),
      participants: names(fields.participants),
      notes: withoutTags(fields.notes ?? ''),
      summary: withoutTags(fields.summary ?? ''),
    });
  };
  if (typeof data === 'object')
    for (const item of records(data, ID) ?? [])
      add({
        id: pick(item, ID),
        title: pick(item, TITLE),
        date: pick(item, DATE),
        participants: pick(item, PEOPLE),
        notes: pick(item, NOTES),
        summary: pick(item, SUMMARY),
      });
  else
    for (const { attrs, body } of elements(data, TAG))
      add({
        id: attrs.id ?? attrs.meeting_id ?? child(body, tagOf(ID)),
        title: attrs.title ?? child(body, tagOf(TITLE)),
        date: attrs.date ?? attrs.start ?? child(body, tagOf(DATE)),
        participants: child(body, tagOf(PEOPLE)),
        notes: child(body, tagOf(NOTES)),
        summary: child(body, tagOf(SUMMARY)),
      });
  if (!found.size && ids.length === 1) {
    const text = resultText(result).trim();
    if (text)
      found.set(ids[0], { title: '', createdAt: null, participants: '', notes: text, summary: '' });
  }
  return found;
}

// One page of get_meeting_transcript → { text, next } (next: the offset of the next page, or null).
export function granolaTranscriptPage(result) {
  const data = resultData(result);
  if (typeof data === 'object') {
    const segments = records(data, ['speaker', 'text']);
    const text =
      typeof pick(data, ['transcript', 'text', 'content']) === 'string'
        ? pick(data, ['transcript', 'text', 'content'])
        : (segments ?? [])
            .map((s) => `${s.speaker ? `${s.speaker}: ` : ''}${s.text ?? ''}`)
            .join('\n');
    const next = Number(pick(data, ['next_offset', 'nextOffset']));
    return { text, next: Number.isFinite(next) && next > 0 ? next : null };
  }
  const next = Number(
    child(data, 'next_offset') || /next_offset["']?\s*[:=]\s*(\d+)/i.exec(data)?.[1],
  );
  return {
    text: child(data, 'transcript') || data,
    next: Number.isFinite(next) && next > 0 ? next : null,
  };
}
export const granolaTranscript = (text) => transcriptRows(withoutTags(text));
