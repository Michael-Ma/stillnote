import { translator } from './i18n/index.mjs';

const english = translator('en');
// Messages shown through a variable t(message); listed so the i18n coverage test sees them.
const msg = (text) => text;
// Built-in names stored as English data and translated only where shown: template names and the
// transcript's speaker labels.
export const builtInNames = [
  msg('Meeting notes'),
  msg('1:1'),
  msg('Customer discovery'),
  msg('Team standup'),
  msg('Interview'),
  msg('You'),
  msg('Meeting audio'),
  msg('Speaker'),
  msg('Imported transcript'),
];
// Dates and times follow the interface language (`locale` is t.locale). Formatters are reused:
// building one per row made long lists slow to draw.
const formatters = new Map();
export const dateFormat = (locale, options) => {
  const key = `${locale}|${JSON.stringify(options)}`;
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat(locale, options));
  return formatters.get(key);
};
export const date = (x, locale) =>
  dateFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(x));
export const time = (x, locale) =>
  dateFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(x));
// "320 MB", "1.2 GB": decimal units, as Finder counts them.
export function fileSize(bytes, locale) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = Math.max(0, Number(bytes) || 0),
    unit = 0;
  while (size >= 1000 && unit < units.length - 1) {
    size /= 1000;
    unit++;
  }
  const digits = unit > 0 && size < 10 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(size)} ${units[unit]}`;
}
export const duration = (x) =>
  `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
export function dayLabel(value, t = english) {
  const d = new Date(value),
    today = new Date();
  if (d.toDateString() === today.toDateString()) return t('Today');
  today.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return t('Yesterday');
  return dateFormat(t.locale, { weekday: 'long', month: 'short', day: 'numeric' }).format(d);
}

// Speaker labels Stillnote writes itself are stored in English and shown translated; names people
// type stay as typed. A built-in label left as shown is stored back in English.
const builtInSpeakers = ['You', 'Meeting audio', 'Speaker', 'Imported transcript'];
export const speakerLabel = (speaker, t) =>
  builtInSpeakers.includes(speaker) ? t(speaker) : speaker;
export const storedSpeaker = (label, t) =>
  builtInSpeakers.find((name) => t(name) === label.trim()) ?? label;

export function cleanError(error, { stopped = false, timedOut = false } = {}) {
  const raw = typeof error === 'string' ? error : (error?.message ?? String(error));
  const text = raw.replace(/^Error invoking remote method '[^']+':\s*(?:[\w.]*Error:\s*)?/, '');
  if (stopped) return msg('Stopped.');
  if (
    timedOut ||
    error?.name === 'TimeoutError' ||
    /TimeoutError:/.test(raw) ||
    /^Timed out after 5 minutes\./.test(text)
  )
    return msg('Timed out after 5 minutes. Your notes are unchanged.');
  if (
    error?.name === 'AbortError' ||
    /^(?:AbortError:|This operation was aborted|The operation was aborted|Stopped\.?$)/i.test(
      text,
    ) ||
    /AbortError:/.test(raw)
  )
    return msg('Stopped.');
  return text;
}

export function languageName(locale, displayLocale) {
  try {
    return (
      new Intl.DisplayNames(displayLocale, { type: 'language', languageDisplay: 'standard' }).of(
        locale,
      ) ?? locale
    );
  } catch {
    return locale;
  }
}

// A recording's language: one language, or Auto with its two candidates ("Auto (Chinese +
// English)"), named by language alone unless both share it.
export function recordingLanguage(locale, locales = [], displayLocale, t = english) {
  if (locale !== 'auto') return languageName(locale, displayLocale);
  const base = (code) => languageName(code.split('-')[0], displayLocale);
  const names = locales.map(base);
  const distinct = new Set(names).size === names.length;
  return t('Auto ({languages})', {
    languages: locales
      .map((code, i) => (distinct ? names[i] : languageName(code, displayLocale)))
      .join(' + '),
  });
}

export function languageOptions(languages, displayLocale) {
  const installed = new Set(languages?.installed ?? []);
  return [...new Set(languages?.supported ?? [])]
    .map((locale) => ({
      locale,
      name: languageName(locale, displayLocale),
      installed: installed.has(locale),
    }))
    .sort(
      (a, b) => a.name.localeCompare(b.name, displayLocale) || a.locale.localeCompare(b.locale),
    );
}

// Which sources have gone quiet: the device's name, or true when the helper did not say. A new
// recording, its end, or a failed start clears it; other errors (a calendar refresh) do not.
export function silentState(state, event, recordingId) {
  if (
    event.type === 'started' ||
    event.type === 'stopped' ||
    (event.type === 'error' && 'recording' in event && (!event.op || event.op === 'start'))
  )
    return {};
  if (
    !recordingId ||
    event.recordingId !== recordingId ||
    !['microphone', 'system'].includes(event.source)
  )
    return state;
  if (event.type === 'source-silent') return { ...state, [event.source]: event.device || true };
  if (event.type === 'source-signal') {
    const next = { ...state };
    delete next[event.source];
    return next;
  }
  return state;
}
