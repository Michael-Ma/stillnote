// Notion's MCP tools (https://mcp.notion.com/mcp) read into Stillnote notes. Pure. notion-fetch
// answers with a page as Notion-flavored Markdown: <properties> as JSON and the page in
// <content>, where an AI meeting notes block carries <summary>, <notes> and <transcript>.
import { parseDate, parseMarkdown } from '../import-formats.mjs';
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

// A Notion page id from an id or a notion.so URL.
export function notionId(value) {
  const hex = /([0-9a-f]{32})(?:[?#].*)?$/i.exec(String(value ?? '').replace(/-/g, ''))?.[1];
  return hex
    ? hex.toLowerCase().replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
    : null;
}

// notion-search → [{ id, title, date (ISO or null), url }], pages only.
export function notionPages(result) {
  const data = resultData(result);
  const items =
    typeof data === 'object'
      ? (records(data, ['id', 'url']) ?? [])
      : [...String(data).matchAll(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g)].map((m) => ({
          title: m[1],
          url: m[2],
        }));
  const seen = new Set();
  return items
    .filter((item) => !item.type || ['page', 'meeting-notes'].includes(item.type))
    .map((item) => ({
      id: notionId(item.id) ?? notionId(item.url),
      title: withoutTags(pick(item, ['title', 'name']) ?? '') || 'Untitled',
      date: parseDate(pick(item, ['timestamp', 'last_edited_time', 'created_time', 'date'])),
      url: typeof item.url === 'string' ? item.url : '',
    }))
    .filter((item) => item.id && !seen.has(item.id) && seen.add(item.id));
}

const DATE_KEY = /(^|[:\s])(date|created|meeting date|time|日期|时间)/i;
const PEOPLE_KEY = /attendee|participant|people|参会|与会|参与/i;
function facts(properties) {
  let createdAt = null,
    participants = '';
  // "date:Date:start" holds a date property's start; plain keys hold the rest.
  const entries = Object.entries(properties).sort(
    ([a], [b]) => /:start$/.test(b) - /:start$/.test(a),
  );
  for (const [key, value] of entries) {
    if (!createdAt && DATE_KEY.test(key) && typeof value === 'string') createdAt = parseDate(value);
    if (!participants && PEOPLE_KEY.test(key)) {
      let list = value;
      if (typeof value === 'string')
        try {
          list = JSON.parse(value);
        } catch {}
      participants = names(list);
    }
  }
  return { createdAt, participants };
}

// notion-fetch → { title, createdAt, participants, notes, summary, transcript }.
export function notionPage(result, fallbackTitle = '') {
  const data = resultData(result);
  const text =
    typeof data === 'object' ? String(pick(data, ['text', 'content', 'markdown']) ?? '') : data;
  const page = elements(text, 'page')[0];
  let properties = {};
  try {
    properties = JSON.parse(child(text, 'properties') || '{}');
  } catch {}
  const title =
    withoutTags(
      (typeof data === 'object' && typeof data.title === 'string' && data.title) ||
        properties.title ||
        properties.Name ||
        page?.attrs.title ||
        '',
    ) || fallbackTitle;
  let content = child(text, 'content') || (page ? page.body : text);
  const meeting = elements(content, 'meeting-notes')[0];
  let summary = '',
    notes = '',
    transcript = [];
  if (meeting) {
    summary = withoutTags(child(meeting.body, 'summary'));
    notes = withoutTags(child(meeting.body, 'notes'));
    transcript = transcriptRows(withoutTags(child(meeting.body, 'transcript')));
    content = content.replace(/<meeting-notes\b[\s\S]*?<\/meeting-notes\s*>/i, '');
  }
  const rest = parseMarkdown(withoutTags(content), title, { headingTitle: false });
  const known = facts(properties);
  return {
    title: title || rest.title,
    createdAt: known.createdAt ?? rest.createdAt,
    participants: known.participants || rest.participants,
    notes: [notes, rest.notes].filter(Boolean).join('\n\n'),
    summary: summary || rest.summary,
    transcript: transcript.length ? transcript : rest.transcript,
  };
}
