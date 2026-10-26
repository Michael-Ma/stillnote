// Calendar invites arrive as HTML, or as text full of join instructions. A meeting's note keeps
// their substance readable: the call link (with meeting ID and passcode) first, then the invite's
// own words as plain lines and bullets, without dial-in numbers and boilerplate. Pure.
import { translator } from './i18n/index.mjs';
import { callLink, callServices, meetingLink } from './calls.mjs';

const named = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};
const decode = (text) =>
  text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name[0] !== '#') return named[name.toLowerCase()] ?? match;
    const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
  });
const blocks = /^(?:p|div|h[1-6]|tr|table|blockquote|section|article|header|footer)$/;

// Block ends and <br> break lines, list items become bullets indented by depth, and links keep
// their words (or their address, when the words are the address). Breaks made from tags are marked
// (U+2029) and collapse to one, so empty spacer paragraphs leave no blank lines; line breaks
// already in the text (what someone typed below the invite) stay as they are.
const tagBreak = '\u2029';
function htmlToText(html) {
  let depth = 0;
  const text = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(
      /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_, q, href, label) => {
        const words = decode(label.replace(/<[^>]*>/g, '')).trim();
        return !words || /^https?:\/\/\S+$/i.test(words) ? decode(href) : words;
      },
    )
    .replace(/<(\/?)([a-z][\w-]*)\b[^>]*>/gi, (_, closing, tag) => {
      const name = tag.toLowerCase();
      if (name === 'ul' || name === 'ol') {
        depth = Math.max(0, depth + (closing ? -1 : 1));
        return tagBreak;
      }
      if (name === 'li')
        return closing ? tagBreak : `${tagBreak}${'  '.repeat(Math.max(0, depth - 1))}- `;
      return name === 'br' || blocks.test(name) ? tagBreak : '';
    })
    .replace(/\u2029(?:[ \t]*\u2029)+/g, tagBreak)
    // A list item's paragraph starts on the bullet's own line.
    .replace(/(^|\u2029)([ ]*- )[ \t]*\u2029[ \t]*/g, '$1$2')
    .replaceAll(tagBreak, '\n');
  return decode(text);
}

// Lines that only tell people how to dial in or manage the invite.
const boilerplate = [
  /^this is an? (?:zoom|google meet|microsoft teams|teams) meeting\b/i,
  /^(?:click|tap) (?:this|the) link to join\b/i,
  /^join (?:zoom meeting|with google meet|by phone|on your computer|on the web|the meeting|microsoft teams meeting)\b/i,
  /^(?:meeting id|passcode|password|pin|conference id)\b/i,
  /^(?:one tap mobile|dial by your location|find your local number|join by sip|join by h\.323|or dial|more phone numbers|meeting link|google meet joining info)\b/i,
  /^\(?[a-z]{2}\)?\s+\+\d/i,
  /^\+\d[\d\s().,#*-]{7,}/,
  /^\d[\d\s().-]{6,}(?:,,|#)/,
  /^[_\-=]{8,}$/,
  /^microsoft teams meeting$/i,
  /^(?:click here to join the meeting|download teams|join on the web|learn more|meeting options|need help\?|for organizers:)/i,
  /^to (?:cancel or reschedule|reschedule or cancel)\b/i,
  /^click here to opt[- ]?out\.?$/i,
  /^(?:invitation from google calendar|you are receiving this|forwarding this invitation|view all guest info|reply for)\b/i,
];
const urls = /https?:\/\/[^\s<>"']+/gi;

// The invite's text made readable, with the call's details first. Already-readable text without a
// call link comes back with its lines tidied but its words unchanged.
export function readableContext(text, t = translator('en')) {
  if (typeof text !== 'string' || !text.trim()) return '';
  // Links written as <https://…> (Teams, plain-text mail) are links, not tags.
  const unwrapped = text.replace(/<(https?:\/\/[^\s<>]+)>/gi, '$1');
  const html = /<\/?[a-z][^>]*>|&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(unwrapped);
  const plain = html ? htmlToText(unwrapped) : unwrapped;
  const link = meetingLink({ notes: plain });
  const id = plain.match(/meeting id:?\s*(\d[\d ]{6,}\d)/i)?.[1].replace(/\s+/g, ' ');
  const code = plain.match(/(?:passcode|password):?\s*([^\s|<]+)/i)?.[1];
  const lines = [];
  for (const raw of plain.replace(/\r\n?/g, '\n').split('\n')) {
    const bullet = raw.match(/^(\s*)- (.*)$/);
    const words = (bullet ? bullet[2] : raw).replace(/\s+/g, ' ').trim();
    if (!words) {
      if (lines.length && lines.at(-1) !== '') lines.push('');
      continue;
    }
    if (boilerplate.some((pattern) => pattern.test(words))) continue;
    // A line that is little more than the call link is said once, at the top.
    const rest = words.replace(urls, (url) => (callLink(url) ? '' : url)).trim();
    if (rest !== words && rest.replace(/[\s:·|,-]+/g, '').length < 20) continue;
    lines.push(bullet ? `${bullet[1]}- ${words}` : words);
  }
  while (lines.at(-1) === '') lines.pop();
  const details = [id && t('Meeting ID {id}', { id }), code && t('Passcode {code}', { code })]
    .filter(Boolean)
    .join(' · ');
  const header = [
    link && `${callServices[link.service].name}: ${link.url}`,
    link && details,
  ].filter(Boolean);
  return [...header, ...(header.length && lines.length ? [''] : []), ...lines].join('\n');
}

// A note created from a calendar event starts with "Meeting context" (kept in English: the enhance
// prompt reads it). Tidying rewrites what follows; everything else in Stillnote is left alone.
export const contextHeader = 'Meeting context\n';
export function tidyNotes(notes, t = translator('en')) {
  if (typeof notes !== 'string' || !notes.startsWith(contextHeader)) return notes;
  return contextHeader + readableContext(notes.slice(contextHeader.length), t);
}
