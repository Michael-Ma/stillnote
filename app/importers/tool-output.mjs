// Reading MCP tool results whose shape each app chooses: structured JSON when the server sends
// it, JSON in a text part, or text with XML-like tags. Pure.
import { resultText } from '../mcp-client.mjs';
import { parseTextTranscript } from '../import-formats.mjs';

// The result as data: structuredContent, else its text parsed as JSON, else the text itself.
export function resultData(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object')
    return result.structuredContent;
  const text = resultText(result);
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object') return data;
  } catch {}
  return text;
}

// The first array of objects in `data` (searched a few levels deep) whose items have one of `keys`.
export function records(data, keys, depth = 0) {
  if (Array.isArray(data)) {
    const items = data.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
    if (items.some((item) => keys.some((key) => key in item))) return items;
  }
  if (data && typeof data === 'object' && depth < 4)
    for (const value of Object.values(data)) {
      const found = records(value, keys, depth + 1);
      if (found) return found;
    }
  return null;
}

// The value of the first of `keys` that `item` has; text inside an object ({ markdown }) counts.
export function pick(item, keys) {
  for (const key of keys) {
    let value = item?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value))
      value = value.markdown ?? value.text ?? value.content ?? value.value;
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decode = (text) =>
  String(text).replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (all, name) =>
    name[0] === '#'
      ? String.fromCodePoint(
          name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)),
        )
      : (entities[name.toLowerCase()] ?? all),
  );
export function attributes(source) {
  const found = {};
  for (const m of String(source).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    found[m[1].toLowerCase()] = decode(m[2] ?? m[3]);
  return found;
}
// Elements whose tag matches `name` (a regex alternation) in XML-like text, in document order.
export function elements(text, name) {
  const re = new RegExp(String.raw`<(${name})\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)`, 'gi');
  return [...String(text).matchAll(re)].map((m) => ({
    name: m[1].toLowerCase(),
    attrs: attributes(m[2]),
    body: m[3] ?? '',
  }));
}
// The trimmed body of the first element matching `name`, or ''.
export const child = (text, name) => elements(text, name)[0]?.body.trim() ?? '';

// Markup some apps put around words (mentions, page wrappers) taken out, the words kept.
export const withoutTags = (text) =>
  decode(String(text).replace(/<\/?[a-z][\w-]*(?:\s[^<>]*)?\/?>/gi, '')).trim();

// People as "Ada Lovelace, Alan Turing" from a list of names or people, or from text.
export function names(value) {
  const list = Array.isArray(value)
    ? value.map((person) =>
        typeof person === 'string'
          ? person
          : pick(person, ['name', 'display_name', 'displayName', 'full_name', 'email']),
      )
    : typeof value === 'string'
      ? value.split(/\n|,/)
      : [];
  return list
    .map((name) =>
      String(name ?? '')
        .replace(/<[^<>]*>/g, '')
        .replace(/^[-*•]\s*/, '')
        .trim(),
    )
    .filter((name) => name && !/^[a-z]+:\/\//i.test(name))
    .join(', ');
}

// Transcript text as rows: timed and per speaker when it reads like that, else one row.
export const transcriptRows = (text) => {
  const clean = String(text ?? '').trim();
  if (!clean) return [];
  return (
    parseTextTranscript(clean) ?? [{ text: clean, speaker: 'Imported transcript', timestamp: 0 }]
  );
};
