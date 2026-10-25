// Auto language: the same audio is transcribed once per candidate language, and for every stretch
// of speech the more convincing candidate wins. Pure; shared by live capture and Retry.

const count = (text, pattern) => text.match(pattern)?.length ?? 0;
const isChinese = (locale = '') => /^(zh|yue)(-|$)/i.test(locale);
const duration = (s) => Math.max(0.05, s.end - s.start);

export const defaultWeights = {
  coverage: 0.25, // per unit of coverage behind the best candidate
  latinInChinese: 0.3, // a Chinese model writing mostly Latin was hearing English
  sticky: 0.04, // short utterances lean to the previous winner
  tie: 0.03,
  minimumAlone: 0.3, // a group only one language heard is kept above this confidence
  merge: 0.3, // seconds; phrase boundaries closer than this count as one
};

// Builds one piece of a phrase from some of its timed runs ([start, end, confidence or -1, text]).
function piece(segment, runs, index, count) {
  const known = runs.filter((run) => run[2] >= 0);
  const weight = known.reduce((sum, run) => sum + Math.max(1, run[3].length), 0);
  return {
    ...segment,
    segmentId: `${segment.segmentId}:${index}`,
    parent: { id: segment.segmentId, index, count },
    text: runs
      .map((run) => run[3])
      .join('')
      .trim(),
    timestamp: runs[0][0],
    end: runs.at(-1)[1],
    confidence: weight
      ? known.reduce((sum, run) => sum + run[2] * Math.max(1, run[3].length), 0) / weight
      : segment.confidence,
    runs,
  };
}

// Where a phrase evidently changes language inside: a Chinese model switching between Han
// characters and Latin words, or another model's confidence crossing 0.5. Both sides must be
// substantial (two Han characters, three Latin words, two words either side of the confidence
// change), so English terms inside a Chinese sentence ("这个 feature 的 deadline") do not cut it.
export function switchPoints(segment) {
  const runs = (segment.runs ?? []).filter((run) => /[\p{L}\p{N}]/u.test(run[3]));
  const chinese = isChinese(segment.locale);
  const kind = (run) =>
    chinese
      ? /\p{Script=Han}/u.test(run[3])
        ? 'han'
        : 'latin'
      : run[2] >= 0.5 || run[2] < 0
        ? 'sure'
        : 'unsure';
  const stretches = [];
  for (const run of runs) {
    const k = kind(run);
    if (stretches.at(-1)?.kind === k) stretches.at(-1).runs.push(run);
    else stretches.push({ kind: k, runs: [run] });
  }
  const substantial = ({ kind, runs }) => {
    const text = runs.map((run) => run[3]).join('');
    if (kind === 'han') return count(text, /\p{Script=Han}/gu) >= 2;
    if (kind === 'latin') return count(text, /[A-Za-z]+/g) >= 3;
    return runs.length >= 2;
  };
  const points = [];
  for (let i = 1; i < stretches.length; i++)
    if (substantial(stretches[i - 1]) && substantial(stretches[i]))
      points.push((stretches[i - 1].runs.at(-1)[1] + stretches[i].runs[0][0]) / 2);
  return points;
}

// Every candidate's phrase starts and ends, plus language switches inside phrases, merged when
// closer than `merge` seconds.
export function boundaries(segments, merge = defaultWeights.merge) {
  return [
    ...new Set(segments.flatMap((s) => [s.timestamp, s.end ?? s.timestamp, ...switchPoints(s)])),
  ]
    .sort((a, b) => a - b)
    .filter((t, i, all) => i === 0 || t - all[i - 1] >= merge);
}

// Models end phrases at pauses in their own language, so one may return several sentences as a
// single phrase. Every phrase with word timing is cut at the shared boundaries, giving each word
// to the side of the cut its midpoint falls on; the candidates then line up sentence by sentence.
export function alignToBoundaries(segments, cuts, merge = defaultWeights.merge) {
  return segments.flatMap((segment) => {
    const runs = segment.runs;
    const end = segment.end ?? segment.timestamp;
    const inside = cuts.filter((t) => t > segment.timestamp + merge && t < end - merge);
    if (!Array.isArray(runs) || runs.length < 2 || !inside.length) return [segment];
    const pieces = [[]];
    let next = 0;
    for (const run of runs) {
      const middle = (run[0] + run[1]) / 2;
      while (next < inside.length && middle >= inside[next]) {
        if (pieces.at(-1).length) pieces.push([]);
        next++;
      }
      pieces.at(-1).push(run);
    }
    const kept = pieces.filter((p) => p.length);
    return kept.length > 1
      ? kept.map((runs, i) => piece(segment, runs, i, kept.length))
      : [segment];
  });
}

// One group per time slice between shared boundaries: the candidates' versions of the same
// stretch of speech. A piece that spans several slices (no word timing to cut it) joins them.
export function groupBySlices(pieces, cuts) {
  const slice = (t) => Math.max(0, cuts.filter((c) => c <= t).length - 1);
  // Word-timed pieces were already cut at every boundary; a word that absorbed a pause may poke
  // past one, so they count by their midpoint. Untimed phrases cover every slice they span.
  const spans = pieces
    .map((p) => {
      if (Array.isArray(p.runs) && p.runs.length) {
        const at = slice((p.start + p.end) / 2);
        return { p, from: at, to: at };
      }
      const inset = Math.min(0.05, (p.end - p.start) / 2);
      return { p, from: slice(p.start + inset), to: slice(p.end - inset) };
    })
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const groups = [];
  for (const span of spans) {
    const last = groups.at(-1);
    if (last && span.from <= last.to) {
      last.to = Math.max(last.to, span.to);
      last.segments.push(span.p);
    } else groups.push({ from: span.from, to: span.to, segments: [span.p] });
  }
  return groups.map(({ segments }) => ({
    start: Math.min(...segments.map((s) => s.start)),
    end: Math.max(...segments.map((s) => s.end)),
    segments,
  }));
}

// A Han character is about one spoken word, so Chinese text is compared with English by words.
function profile(segments) {
  const text = segments.map((s) => s.text).join(' ');
  const han = count(text, /\p{Script=Han}/gu),
    words = count(text, /[A-Za-z]+/g);
  return { han, words, mostlyLatin: words >= 3 && words > 2 * han };
}

// Duration-weighted confidence, less what the candidate failed to cover compared with the best
// candidate, less a penalty when a Chinese model wrote mostly Latin (it was hearing English).
// Chinese with a few English terms inside is normal and not penalised.
export function scoreCandidates(group, previous, weights = defaultWeights) {
  const byLocale = new Map();
  for (const segment of group.segments) {
    if (!byLocale.has(segment.locale)) byLocale.set(segment.locale, []);
    byLocale.get(segment.locale).push(segment);
  }
  const span = Math.max(0.05, group.end - group.start);
  const candidates = [...byLocale.entries()].map(([locale, segments]) => {
    const covered = segments.reduce((sum, s) => sum + duration(s), 0);
    const confidence =
      segments.reduce((sum, s) => sum + (s.confidence ?? 0.5) * duration(s), 0) / covered;
    const mismatch = isChinese(locale) && profile(segments).mostlyLatin;
    return { locale, segments, confidence, coverage: Math.min(1, covered / span), mismatch };
  });
  const best = Math.max(...candidates.map((c) => c.coverage));
  for (const c of candidates)
    c.score =
      c.confidence -
      weights.coverage * (best - c.coverage) -
      (c.mismatch ? weights.latinInChinese : 0) +
      (c.locale === previous ? weights.sticky * Math.max(0, Math.min(1, 1 - span / 2)) : 0);
  return candidates.sort((a, b) => b.score - a.score);
}

// Picks one candidate for a group. Near-ties prefer the script the audio evidently was, then the
// source's previous winner, then the first candidate language.
export function judge(group, previous, locales = [], weights = defaultWeights) {
  const scored = scoreCandidates(group, previous, weights);
  if (scored.length === 1) {
    const [alone] = scored;
    return alone.segments.some((s) => s.confidence === undefined) ||
      alone.confidence >= weights.minimumAlone
      ? alone
      : null;
  }
  const [first, second] = scored;
  if (first.score - second.score >= weights.tie) return first;
  const close = scored.filter((c) => first.score - c.score < weights.tie);
  const chinese = close.find((c) => isChinese(c.locale));
  if (chinese) {
    const { han, words } = profile(chinese.segments);
    if (han >= words) return chinese;
    const other = close.find((c) => !isChinese(c.locale));
    if (other) return other;
  }
  return (
    close.find((c) => c.locale === previous) ?? close.find((c) => c.locale === locales[0]) ?? first
  );
}

// Consecutive winning pieces of one phrase become that phrase again, so the transcript keeps the
// model's own rows (and ids) wherever one language won the whole phrase.
function stitch(winners) {
  const out = [];
  for (const segment of winners) {
    const last = out.at(-1);
    if (
      last?.parent &&
      segment.parent &&
      last.parent.id === segment.parent.id &&
      last.parent.last + 1 === segment.parent.index
    ) {
      last.runs = [...last.runs, ...segment.runs];
      last.text = last.runs
        .map((run) => run[3])
        .join('')
        .trim();
      last.end = segment.end;
      last.confidence =
        ((last.confidence ?? 0.5) * last.weight +
          (segment.confidence ?? 0.5) * segment.text.length) /
        (last.weight + segment.text.length);
      last.weight += segment.text.length;
      last.parent.last = segment.parent.index;
    } else
      out.push({
        ...segment,
        weight: segment.text.length,
        parent: segment.parent && { ...segment.parent, last: segment.parent.index },
      });
  }
  return out.map(({ parent, weight, start, ...segment }) => ({
    ...segment,
    timestamp: start,
    ...(parent
      ? {
          segmentId:
            parent.index === 0 && parent.last === parent.count - 1
              ? parent.id
              : `${parent.id}:${parent.index}`,
        }
      : {}),
  }));
}

// Where a row in one language starts inside the previous row in another, its first words are
// that model's version of speech the previous row already has (a garbled tail): drop them.
function trimSeams(rows) {
  const out = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (!last || last.locale === row.locale || row.timestamp >= last.end - 0.05) {
      out.push(row);
      continue;
    }
    if (!Array.isArray(row.runs) || !row.runs.length) {
      out.push(row);
      continue;
    }
    // A word that starts inside the previous row belongs to it, even when it absorbed the pause.
    const runs = row.runs.filter((r) => r[0] >= last.end - 0.15);
    if (!runs.length) continue;
    out.push({
      ...row,
      runs,
      timestamp: runs[0][0],
      text: runs
        .map((r) => r[3])
        .join('')
        .trim(),
    });
  }
  return out;
}

// Offline arbitration (Retry, evaluation): every candidate segment is known up front. Segments
// use `timestamp` (start) and `end`; the result keeps the winners' own fields and ids.
export function arbitrateOffline(segments, locales = [], weights = defaultWeights) {
  const result = [];
  const sources = [...new Set(segments.map((s) => s.source ?? 'microphone'))];
  for (const source of sources) {
    let previous = null;
    const own = segments
      .filter((s) => (s.source ?? 'microphone') === source)
      .map((s) => ({ ...s, end: Math.max(s.end ?? s.timestamp, s.timestamp) }));
    const cuts = boundaries(own, weights.merge);
    const pieces = alignToBoundaries(own, cuts, weights.merge).map((s) => ({
      ...s,
      start: s.timestamp,
    }));
    const winners = [];
    for (const group of groupBySlices(pieces, cuts)) {
      const winner = judge(group, previous, locales, weights);
      if (!winner) continue;
      previous = winner.locale;
      winners.push(...winner.segments.sort((a, b) => a.start - b.start));
    }
    result.push(...trimSeams(stitch(winners)));
  }
  return result.sort((a, b) => a.timestamp - b.timestamp);
}
