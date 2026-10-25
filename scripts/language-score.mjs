// Scores transcripts of the synthetic language fixtures sentence by sentence: CER for Chinese,
// WER for English, and which language each sentence came out in. Shared by
// scripts/language-eval.mjs and the arbiter's replay test.
const normalize = (lang, text) =>
  lang === 'zh'
    ? [...text.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]/gu, '')]
    : (text.toLowerCase().match(/[a-z0-9']+/g) ?? []);

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

export const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

// Each recognized word counts toward the reference sentence nearest its own timing, so a model
// that returns several sentences as one phrase is still scored sentence by sentence.
// `windows`: [{ lang: 'zh' | 'en', text, start, end }]; `languages`: { zh: 'zh-CN', en: 'en-US' }.
export function scoreSentences(windows, segments, languages) {
  const assigned = windows.map(() => []);
  const words = segments.flatMap((s) =>
    Array.isArray(s.runs) && s.runs.length
      ? s.runs.map((run) => ({ text: run[3], timestamp: run[0], end: run[1], locale: s.locale }))
      : [{ ...s, end: s.end ?? s.timestamp + 1 }],
  );
  for (const word of words) {
    const middle = (word.timestamp + word.end) / 2;
    const away = (w) => (middle < w.start ? w.start - middle : Math.max(0, middle - w.end));
    let best = 0;
    windows.forEach((w, i) => {
      if (away(w) < away(windows[best])) best = i;
    });
    assigned[best].push(word);
  }
  return windows.map((w, i) => {
    const hypothesis = assigned[i].map((s) => s.text).join('');
    const reference = normalize(w.lang, w.text);
    const time = {};
    for (const s of assigned[i]) time[s.locale] = (time[s.locale] ?? 0) + (s.end - s.timestamp);
    const locale = Object.entries(time).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {
      lang: w.lang,
      reference: w.text,
      hypothesis,
      error: distance(normalize(w.lang, hypothesis), reference) / reference.length,
      locale,
      languageCorrect: locale === languages[w.lang],
    };
  });
}
