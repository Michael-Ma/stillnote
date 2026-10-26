// Shared FTS normalization for the notebook and the read-only MCP server.
// CJK characters are individual tokens searched as phrases; embedded Latin terms remain words.
const cjkCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export const searchable = (value) =>
  value.replace(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    ' $& ',
  );

export function searchQuery(query, { any = false } = {}) {
  const terms = String(query ?? '')
    .slice(0, 1000)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return null;
  const phrase = (tokens, prefix) =>
    '"' + tokens.join(' ').replaceAll('"', '""') + '"' + (prefix ? '*' : '');
  const parts = terms.flatMap((term) => {
    const tokens = searchable(term)
      .trim()
      .split(/\s+/)
      .filter((token) => /[\p{L}\p{N}]/u.test(token));
    if (!tokens.length) return [];
    if (!any) return [phrase(tokens, !cjkCharacter.test(tokens.at(-1)))];
    const out = [];
    let run = [];
    const pairs = () => {
      if (run.length === 1) out.push(phrase(run, false));
      for (let i = 0; i + 1 < run.length; i++) out.push(phrase(run.slice(i, i + 2), false));
      run = [];
    };
    for (const token of tokens)
      if (cjkCharacter.test(token)) run.push(token);
      else {
        pairs();
        out.push(phrase([token], true));
      }
    pairs();
    return out;
  });
  return parts.join(any ? ' OR ' : ' AND ');
}
