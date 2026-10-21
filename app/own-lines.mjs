// Granola-style emphasis: enhanced lines that restate the user's own rough notes stay in ink,
// everything the model added is rendered quieter. Pure and deterministic; no model involvement.
const words = (text) =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).flatMap((w) =>
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(w)
      ? [...w]
      : w.length > 2
        ? [w]
        : [],
  );

export function ownLineMatcher(notes = '') {
  const lines = notes
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ''))
    .map((line) => new Set(words(line)))
    .filter((set) => set.size >= 2);
  return (text = '') => {
    const candidate = new Set(words(text));
    if (candidate.size < 2) return false;
    return lines.some((line) => {
      let shared = 0;
      for (const w of line) if (candidate.has(w)) shared++;
      return shared / line.size >= 0.6 && shared / candidate.size >= 0.3;
    });
  };
}
