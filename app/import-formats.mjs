// Notes and transcripts exported by other tools, turned into Stillnote notes. Pure: the caller
// reads the files; nothing here touches the disk or the store.
//
//   .vtt (Zoom, Teams, Meet) and .srt: timed cues, the speaker from <v Name> or a "Name:" prefix.
//   .txt: a transcript when it reads like one (Otter's "Name  0:03" lines, "[00:01:02] Name: …",
//         or "Name: …" on most lines), otherwise notes.
//   .md (Notion export, Obsidian, Granola's copied notes): a leading # heading is the title,
//         property lines under it give the date and participants, a Summary section is the
//         summary and a Transcript section the transcript; everything else stays in the notes.

import { join as joinPath } from 'node:path';

export const noteExtensions = ['md', 'markdown', 'txt', 'vtt', 'srt'];
const extension = (name) => String(name).split('.').pop().toLowerCase();

// What to import from the chosen paths: chosen files as they are, and the note files inside chosen
// folders (an unzipped Notion export), skipping hidden entries and symbolic links. `fs` supplies
// lstatSync and readdirSync.
export function collectImportFiles(paths, fs, limit = 2000) {
  const files = [];
  const walk = (path, depth) => {
    const info = fs.lstatSync(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory() && depth < 8) {
      for (const name of fs.readdirSync(path).sort())
        if (!name.startsWith('.')) walk(joinPath(path, name), depth + 1);
    } else if (info.isFile() && (depth === 0 || noteExtensions.includes(extension(path)))) {
      files.push(path);
      if (files.length > limit) throw new Error('Choose at most 2,000 files at a time.');
    }
  };
  for (const path of paths) walk(path, 0);
  return files;
}
// The speaker of text whose source names nobody (translated where shown, app/format.mjs).
const UNNAMED = 'Imported transcript';

const STAMP = String.raw`\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?`;
// "1:02:03.5", "01:02:03,500", "2:03" → seconds; null when it is not a timestamp.
export function seconds(stamp) {
  const m = /^(?:(\d+):)?(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(String(stamp).trim());
  if (!m) return null;
  return (Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4] ?? 0}`);
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (text) =>
  text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (all, name) =>
    name[0] === '#'
      ? String.fromCodePoint(
          name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)),
        )
      : (entities[name.toLowerCase()] ?? all),
  );
const normalize = (raw) => String(raw).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
const cjk = /[　-鿿가-힯＀-￯]/;
// Pieces of one sentence: CJK text runs on without a space.
const join = (a, b) => (cjk.test(a.at(-1)) && cjk.test(b[0]) ? a + b : `${a} ${b}`);

// "Name: text" names its speaker only when most lines start that way and the names repeat, so a
// stray "Note: …" or "10:30 …" stays text.
const LABEL = /^([^:：.?!。？！\n]{1,40}?)\s*[:：]\s+(\S[\s\S]*)$/;
function labelled(items) {
  const found = items.map(({ text }) => {
    const m = LABEL.exec(text);
    return m && !/^(\d+|https?)$/i.test(m[1].trim()) ? m : null;
  });
  const hits = found.filter(Boolean);
  const names = new Set(hits.map((m) => m[1].trim()));
  if (
    hits.length < 2 ||
    hits.length < items.length * 0.6 ||
    names.size > Math.max(8, hits.length / 2)
  )
    return null;
  return items.map((item, i) =>
    found[i] ? { ...item, speaker: found[i][1].trim(), text: found[i][2].trim() } : item,
  );
}

// Consecutive cues of one speaker become one row (Zoom writes a cue per phrase).
function merge(items) {
  const rows = [];
  for (const item of items) {
    const last = rows.at(-1);
    if (
      last &&
      last.speaker === item.speaker &&
      item.start - last.end <= 2 &&
      last.text.length + item.text.length < 1000
    ) {
      last.text = join(last.text, item.text);
      last.end = Math.max(last.end, item.end);
    } else rows.push({ ...item });
  }
  return rows;
}
const segments = (rows) =>
  rows.map(({ text, speaker, start }) => ({
    text,
    speaker: speaker || UNNAMED,
    timestamp: Math.round(start * 10) / 10,
  }));

// WebVTT and SRT: blocks of an optional id, a "start --> end" line, and the cue's text.
export function parseCues(raw) {
  const cues = [];
  for (const block of normalize(raw).split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((line) => line.trim());
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at < 0 || at > 1) continue;
    const [start, end] = lines[at].split('-->').map((s) => seconds(s.trim().split(/\s+/)[0]));
    if (start === null) continue;
    const body = lines.slice(at + 1).join('\n');
    const voice = /<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(body);
    const text = decode(body.replace(/<[^>]*>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (text) cues.push({ start, end: end ?? start, speaker: voice?.[1].trim() ?? null, text });
  }
  const named = cues.some((cue) => cue.speaker) ? cues : (labelled(cues) ?? cues);
  return segments(merge(named));
}

// A speaker and a time on a line of their own, the words on the lines below.
const HEADERS = [
  // Otter: "Michael Ma  0:03"
  new RegExp(String.raw`^(.{1,60}?)\s{2,}\(?(${STAMP})\)?$`),
  // "Michael Ma (0:03):", "Michael Ma [00:00:03]"
  new RegExp(String.raw`^(.{1,60}?)\s*[(\[](${STAMP})[)\]]\s*[:：]?$`),
  // "Michael Ma - 00:03", "Michael Ma | 00:03"
  new RegExp(String.raw`^(.{1,60}?)\s+[-–|·]\s+(${STAMP})$`),
];
// A time, a speaker and the words on one line.
const INLINE = [
  // "[00:01:02] Michael: …", "00:01:02 - Michael: …"
  [
    new RegExp(String.raw`^[(\[]?(${STAMP})[)\]]?\s*[-–]?\s*([^:：\n]{1,60}?)\s*[:：]\s+(.+)$`),
    (m) => [m[1], m[2], m[3]],
  ],
  // "Michael (00:01): …"
  [
    new RegExp(String.raw`^([^:：\n(\[]{1,60}?)\s*[(\[](${STAMP})[)\]]\s*[:：]\s+(.+)$`),
    (m) => [m[2], m[1], m[3]],
  ],
  // "[0:05] …" with nobody named
  [new RegExp(String.raw`^[(\[](${STAMP})[)\]]\s+(.+)$`), (m) => [m[1], '', m[2]]],
];

// Transcript-shaped text as rows, or null when it reads like notes.
export function parseTextTranscript(raw) {
  const lines = normalize(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const header = (line) => {
    for (const re of HEADERS) {
      const m = re.exec(line);
      if (m && seconds(m[2]) !== null && !/[.?!。？！]$/.test(m[1])) return m;
    }
    return null;
  };
  // Headers with words below them.
  {
    const rows = [];
    let before = 0;
    for (const line of lines) {
      const m = header(line);
      if (m) rows.push({ speaker: m[1].trim(), start: seconds(m[2]), text: '' });
      else if (rows.length)
        rows.at(-1).text = rows.at(-1).text ? join(rows.at(-1).text, line) : line;
      else before++;
    }
    const spoken = rows.filter((row) => row.text);
    if (
      rows.length >= 2 &&
      spoken.length >= rows.length * 0.8 &&
      before <= Math.max(3, lines.length * 0.1)
    )
      return segments(spoken.map((row) => ({ ...row, end: row.start })));
  }
  // One row per line, continuation lines added to the row above.
  {
    const rows = [];
    let hits = 0;
    for (const line of lines) {
      let row = null;
      for (const [re, parts] of INLINE) {
        const m = re.exec(line);
        if (!m) continue;
        const [stamp, speaker, words] = parts(m);
        if (seconds(stamp) === null) continue;
        row = { start: seconds(stamp), speaker: speaker.trim() || null, text: words.trim() };
        break;
      }
      if (row) {
        hits++;
        rows.push(row);
      } else if (rows.length) rows.at(-1).text = join(rows.at(-1).text, line);
    }
    if (hits >= 2 && hits >= lines.length * 0.6)
      return segments(rows.map((row) => ({ ...row, end: row.start })));
  }
  // "Name: …" lines without times (Granola's copied transcript: "Me: …", "Them: …").
  const named = labelled(lines.map((text) => ({ text, start: 0, end: 0, speaker: null })));
  if (named && named.length >= 3) {
    const rows = [];
    for (const row of named)
      if (row.speaker || !rows.length) rows.push(row);
      else rows.at(-1).text = join(rows.at(-1).text, row.text);
    return segments(rows);
  }
  return null;
}

// "October 3, 2026 10:00 AM", "@October 3, 2026 10:00 AM (PDT)", "2026/10/03 10:00",
// "2026年10月3日 10:00", ISO → an ISO date; null when it is not a plausible date.
export function parseDate(value) {
  const s = String(value ?? '')
    .trim()
    .replace(/^@/, '')
    .split(/\s+→\s+/)[0]
    .replace(/\s*\([A-Z]{2,5}\)$/, '');
  const zh = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(?:(\d{1,2})[:：](\d{2}))?/.exec(s);
  const at = zh
    ? new Date(+zh[1], zh[2] - 1, +zh[3], +(zh[4] ?? 0), +(zh[5] ?? 0)).getTime()
    : Date.parse(s);
  return Number.isFinite(at) && at > Date.UTC(1990, 0, 1) && at < Date.now() + 366 * 86_400_000
    ? new Date(at).toISOString()
    : null;
}

const DATE_KEYS = new Set([
  'created',
  'created time',
  'created at',
  'date',
  'meeting date',
  'time',
  'when',
  '日期',
  '时间',
  '创建时间',
  '会议时间',
]);
const PEOPLE_KEYS = new Set(['attendees', 'participants', 'people', '参会人', '参与者', '与会者']);
const SUMMARY = /^(summary|ai summary|meeting summary|总结|摘要|会议纪要|纪要)$/i;
const TRANSCRIPT = /^(transcript|meeting transcript|转录|转写|逐字稿)$/i;
const PROPERTY = /^([\p{L}][\p{L}\p{N} /()_-]{0,39}?)\s*[:：]\s*(.+)$/u;
const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
const people = (value) =>
  unquote(value)
    .replace(/^\[|\]$/g, '')
    .split(/\s*[,，、;]\s*/)
    .map((name) => unquote(name).replace(/\s*\(.*?\)$/, ''))
    .filter(Boolean)
    .join(', ');

// The title a file name gives: no extension, no Notion page id ("Weekly sync 1a2b…(32 hex)").
export const fileTitle = (name) =>
  String(name)
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^.]+$/, '')
    .replace(/\s+[0-9a-f]{32}$/i, '')
    .trim();

// `headingTitle: false` keeps a leading # heading in the notes (Notion pages carry their title apart).
export function parseMarkdown(raw, title = '', { headingTitle = true } = {}) {
  let text = normalize(raw);
  const facts = { title, createdAt: null, participants: '' };
  const property = (key, value) => {
    const k = key.trim().toLowerCase();
    if (k === 'title' && value.trim()) facts.title = unquote(value);
    else if (DATE_KEYS.has(k) && !facts.createdAt) facts.createdAt = parseDate(unquote(value));
    else if (PEOPLE_KEYS.has(k) && !facts.participants) facts.participants = people(value);
    else return false;
    return true;
  };
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (front) {
    for (const line of front[1].split('\n')) {
      const m = PROPERTY.exec(line);
      if (m) property(m[1], m[2]);
    }
    text = text.slice(front[0].length);
  }
  const heading = /^\s*#\s+(.+?)\s*#*\s*(?:\n|$)/.exec(text);
  if (headingTitle && heading && (!front || facts.title === title || facts.title === heading[1])) {
    facts.title = heading[1];
    text = text.slice(heading[0].length);
  }
  // Notion writes the page's properties as "Key: value" lines under the title.
  const lines = text.split('\n');
  let at = 0;
  while (at < lines.length && !lines[at].trim()) at++;
  const block = [];
  for (let m; (m = PROPERTY.exec(lines[at + block.length] ?? ''));)
    block.push({ i: at + block.length, key: m[1].trim().toLowerCase(), value: m[2] });
  // Only a block with a date or people in it is properties; other "Agenda: …" lines are notes.
  if (block.some(({ key }) => DATE_KEYS.has(key) || PEOPLE_KEYS.has(key)))
    for (const { i, key, value } of block.reverse()) if (property(key, value)) lines.splice(i, 1);
  // Summary and Transcript sections (# or ##) come out of the notes.
  let summary = '',
    transcript = '';
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^(#{1,2})\s+(.+?)\s*#*$/.exec(lines[i]);
    const kind =
      h && (SUMMARY.test(h[2]) ? 'summary' : TRANSCRIPT.test(h[2]) ? 'transcript' : null);
    if (!kind) {
      kept.push(lines[i]);
      continue;
    }
    let end = i + 1;
    while (end < lines.length) {
      const next = /^(#{1,6})\s/.exec(lines[end]);
      if (next && next[1].length <= h[1].length) break;
      end++;
    }
    const body = lines
      .slice(i + 1, end)
      .join('\n')
      .trim();
    if (kind === 'summary') summary = summary ? `${summary}\n\n${body}` : body;
    else transcript = transcript ? `${transcript}\n${body}` : body;
    i = end - 1;
  }
  let notes = kept.join('\n').trim();
  let rows = transcript
    ? (parseTextTranscript(transcript) ?? [{ text: transcript, speaker: UNNAMED, timestamp: 0 }])
    : [];
  // A Markdown file that is only a transcript.
  if (!rows.length && !summary) {
    const whole = parseTextTranscript(notes);
    if (whole) {
      rows = whole;
      notes = '';
    }
  }
  return { ...facts, title: facts.title || title, notes, summary, transcript: rows };
}

// One file → { title, createdAt (ISO or null), participants, notes, summary, transcript }.
export function parseNoteFile(name, raw) {
  const ext = extension(name);
  if (!noteExtensions.includes(ext)) throw new Error('Unsupported file type.');
  const text = normalize(raw);
  if (!text.trim()) throw new Error('The file is empty.');
  if (text.length > 2_000_000)
    throw new Error('File exceeds the 2,000,000-character import limit.');
  const note = {
    title: fileTitle(name),
    createdAt: null,
    participants: '',
    notes: '',
    summary: '',
  };
  if (ext === 'vtt' || ext === 'srt') {
    const transcript = parseCues(text);
    if (!transcript.length) throw new Error('No captions were found in this file.');
    return { ...note, transcript };
  }
  if (ext === 'txt') {
    const transcript = parseTextTranscript(text);
    return transcript ? { ...note, transcript } : { ...note, notes: text.trim(), transcript: [] };
  }
  return parseMarkdown(text, note.title);
}
