export const date = (x) =>
  new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(x));
export const time = (x) =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(x));
export const duration = (x) =>
  `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
export function dayLabel(value) {
  const d = new Date(value),
    today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  today.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

export function cleanError(error, { stopped = false, timedOut = false } = {}) {
  const raw = typeof error === 'string' ? error : (error?.message ?? String(error));
  const text = raw.replace(/^Error invoking remote method '[^']+':\s*(?:[\w.]*Error:\s*)?/, '');
  if (stopped) return 'Stopped.';
  if (
    timedOut ||
    error?.name === 'TimeoutError' ||
    /TimeoutError:/.test(raw) ||
    /^Timed out after 5 minutes\./.test(text)
  )
    return 'Timed out after 5 minutes. Your notes are unchanged.';
  if (
    error?.name === 'AbortError' ||
    /^(?:AbortError:|This operation was aborted|The operation was aborted|Stopped\.?$)/i.test(
      text,
    ) ||
    /AbortError:/.test(raw)
  )
    return 'Stopped.';
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
export function recordingLanguage(locale, locales = [], displayLocale) {
  if (locale !== 'auto') return languageName(locale, displayLocale);
  const base = (code) => languageName(code.split('-')[0], displayLocale);
  const names = locales.map(base);
  const distinct = new Set(names).size === names.length;
  return `Auto (${locales.map((code, i) => (distinct ? names[i] : languageName(code, displayLocale))).join(' + ')})`;
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

export function silentState(state, event, recordingId) {
  if (
    event.type === 'started' ||
    event.type === 'stopped' ||
    (event.type === 'error' && 'recording' in event)
  )
    return {};
  if (
    !recordingId ||
    event.recordingId !== recordingId ||
    !['microphone', 'system'].includes(event.source)
  )
    return state;
  if (event.type === 'source-silent')
    return {
      ...state,
      [event.source]:
        event.device || (event.source === 'microphone' ? 'microphone' : 'meeting audio'),
    };
  if (event.type === 'source-signal') {
    const next = { ...state };
    delete next[event.source];
    return next;
  }
  return state;
}
