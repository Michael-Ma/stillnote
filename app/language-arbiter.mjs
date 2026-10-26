// Auto language: the same audio is transcribed once per candidate language, and for every stretch
// of speech the more convincing candidate wins. Pure; shared by live capture and Retry.

const count = (text, pattern) => text.match(pattern)?.length ?? 0;
const isChinese = (locale = '') => /^(zh|yue)(-|$)/i.test(locale);
const duration = (s) => Math.max(0.05, s.end - s.start);
const spokenRuns = (segment) => (segment.runs ?? []).filter((run) => /[\p{L}\p{N}]/u.test(run[3]));

// A model ends a phrase where it next hears its own language, so a phrase's range can run on
// through the other language's speech. Where word timing exists, a phrase spans its words.
function spoken(segment) {
  const words = spokenRuns(segment);
  if (!words.length) return segment;
  return { ...segment, timestamp: words[0][0], end: Math.max(words[0][0], words.at(-1)[1]) };
}

// What to transcribe with: a fixed language, or both Auto candidates (primary first).
export function recognitionPlan(settings = {}) {
  if (settings.locale !== 'auto')
    return { label: settings.locale ?? 'en-US', locales: [settings.locale ?? 'en-US'] };
  const locales = settings.autoLocales ?? ['zh-CN', 'en-US'];
  return { label: 'auto', locales };
}

export const defaultWeights = {
  coverage: 0.25, // per unit of coverage behind the best candidate
  latinInChinese: 0.3, // a Chinese model writing mostly Latin was hearing English
  sticky: 0.04, // short utterances lean to the previous winner
  tie: 0.03,
  minimumAlone: 0.2, // a group only one language heard is kept above this confidence
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
  const runs = spokenRuns(segment);
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

// Where a row in one language starts before the previous row in another has finished speaking,
// its first words are that model's version of speech the previous row already has (a garbled
// echo of its last word): drop them. Rows span their spoken words, so a word starting after the
// previous row's last word is new speech. `before` is the last row already in the transcript
// (live mode commits in batches).
function trimSeams(rows, before = null) {
  const out = before ? [before] : [];
  for (const row of rows) {
    const last = out.at(-1);
    if (!last || last.locale === row.locale || row.timestamp >= last.end) {
      out.push(row);
      continue;
    }
    if (!Array.isArray(row.runs) || !row.runs.length) {
      out.push(row);
      continue;
    }
    const runs = row.runs.filter((r) => r[0] >= last.end);
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
  return before ? out.slice(1) : out;
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
      .map((s) => spoken({ ...s, end: Math.max(s.end ?? s.timestamp, s.timestamp) }));
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

// Live arbitration. Candidate events arrive as each transcriber produces them; a stretch of speech
// is judged once every active language has finalized past it, or a language has said nothing for
// `settle` ms (it heard silence, or nothing it understands). Until then the leading language's text
// is shown provisionally. Pure: the caller passes the clock and applies the returned actions:
//   { type: 'partial', event }      show or update provisional text (renderer only)
//   { type: 'segment', segment }    a decided transcript row
//   { type: 'discard', segmentIds } remove provisional text that will not become a row
export function createLiveArbiter({
  locales,
  startedAt = 0,
  settle = 3500,
  stall = 15000,
  weights = defaultWeights,
}) {
  const sources = new Map();
  const base = (id = '') => id.split(':')[0];
  const state = (source) => {
    if (!sources.has(source))
      sources.set(source, {
        pending: [],
        heard: Object.fromEntries(locales.map((l) => [l, startedAt])),
        through: {},
        progress: {}, // finalized-through watermark per locale, from the helper
        dropped: new Set(),
        previous: null,
        leading: locales[0],
        lastRow: null,
        shown: new Map(), // provisional segmentId → locale
        drawn: new Map(), // provisional segmentId → the text and start last sent for it
        volatile: new Map(), // latest partial per segmentId, every locale
      });
    return sources.get(source);
  };
  const show = (s, event) => {
    s.shown.set(event.segmentId, event.locale);
    s.drawn.set(event.segmentId, `${event.timestamp}|${event.text}`);
    return { type: 'partial', event: { ...event, type: 'partial', partial: true } };
  };
  // Waiting pieces are offered on every pass; only new or changed ones are sent again.
  const showChanged = (s, event) =>
    s.shown.has(event.segmentId) &&
    s.drawn.get(event.segmentId) === `${event.timestamp}|${event.text}`
      ? []
      : [show(s, event)];
  // Takes provisional text off the screen; it will not become a row of its own.
  const withdraw = (s, ids) => {
    for (const id of ids) s.volatile.delete(id);
    const gone = ids.filter((id) => s.shown.has(id));
    for (const id of gone) s.shown.delete(id);
    return gone.length ? [{ type: 'discard', segmentIds: gone }] : [];
  };
  // Provisional text not updated for `stall` ms will never be finalized (its phrase was revised
  // away): it stops holding decisions back, leaves the screen, and is not saved at stop.
  const expire = (s, now) =>
    withdraw(
      s,
      [...s.volatile.values()].filter((e) => now - e.seenAt >= stall).map((e) => e.segmentId),
    );

  function resolve(source, s, now, force) {
    if (!s.pending.length) return [];
    const active = locales.filter((l) => !s.dropped.has(l));
    // How far each language has finalized. With the helper's watermarks that is exact, silence
    // included; a language that has sent nothing for `stall` ms stops holding the others back
    // (models can take seconds to load). Without watermarks: up to the start of a phrase still in
    // progress, else its last final while it spoke recently.
    const watermarks = Object.keys(s.progress).length > 0;
    let horizon = Infinity;
    for (const locale of active) {
      if (force) break;
      const quiet = now - s.heard[locale];
      // A phrase still showing provisional text has not delivered its final yet, even if the
      // watermark already moved past it.
      const working = [...s.volatile.values()]
        .filter((e) => e.locale === locale && now - e.seenAt < stall)
        .map((e) => e.timestamp);
      if (watermarks) {
        if (quiet < stall)
          horizon = Math.min(
            horizon,
            Math.max(s.progress[locale] ?? -Infinity, s.through[locale] ?? -Infinity),
            ...working,
          );
        continue;
      }
      if (working.length && quiet < settle * 2) horizon = Math.min(horizon, ...working);
      else if (!working.length && quiet < settle)
        horizon = Math.min(horizon, s.through[locale] ?? -Infinity);
    }
    if (horizon === -Infinity) return [];
    const cuts = boundaries(
      Number.isFinite(horizon) ? [...s.pending, { timestamp: horizon, end: horizon }] : s.pending,
      weights.merge,
    );
    const pieces = alignToBoundaries(s.pending, cuts, weights.merge).map((p) => ({
      ...p,
      start: p.timestamp,
    }));
    const winners = [],
      kept = [],
      consumed = new Set();
    let previous = s.previous;
    for (const group of groupBySlices(pieces, cuts)) {
      if (group.end > horizon + 0.05) {
        kept.push(...group.segments);
        continue;
      }
      for (const piece of group.segments) consumed.add(base(piece.segmentId));
      // With one language left there is nothing to choose: keep what it heard.
      const winner =
        active.length === 1
          ? { locale: active[0], segments: group.segments.filter((p) => p.locale === active[0]) }
          : judge(group, previous, active, weights);
      if (!winner) continue;
      previous = winner.locale;
      winners.push(...winner.segments.sort((a, b) => a.start - b.start));
    }
    s.pending = kept;
    const rows = trimSeams(stitch(winners), s.lastRow);
    // The language of what reached the transcript: a late candidate whose rows were all trimmed
    // away does not become the previous or leading language.
    if (rows.length) {
      s.lastRow = rows.at(-1);
      s.previous = rows.at(-1).locale;
    }
    const actions = [];
    const emitted = new Set(rows.map((r) => r.segmentId));
    const stale = [...s.shown.keys()].filter((id) => consumed.has(base(id)) && !emitted.has(id));
    for (const id of [...stale, ...emitted]) s.shown.delete(id);
    if (stale.length) actions.push({ type: 'discard', segmentIds: stale });
    actions.push(...rows.map((row) => ({ type: 'segment', segment: row })));
    // Speech the leading language finalized but that is not decided yet stays visible.
    let switched = false;
    if (s.previous && s.previous !== s.leading) {
      const old = [...s.shown].filter(([, locale]) => locale === s.leading).map(([id]) => id);
      for (const id of old) s.shown.delete(id);
      if (old.length) actions.push({ type: 'discard', segmentIds: old });
      s.leading = s.previous;
      switched = true;
      for (const event of s.volatile.values())
        if (event.locale === s.leading) actions.push(show(s, event));
    }
    // A phrase cut into pieces shows as its pieces (not as the pieces and the whole phrase);
    // after a switch, the new leading language's phrases waiting for a decision show too.
    const cut = new Set();
    for (const piece of kept) {
      if (piece.locale !== s.leading) continue;
      const whole = piece.segmentId === base(piece.segmentId);
      if (whole && !switched) continue;
      if (!whole) cut.add(base(piece.segmentId));
      actions.push(...showChanged(s, { ...piece, timestamp: piece.start }));
    }
    const replaced = [...cut].filter((id) => s.shown.has(id));
    for (const id of replaced) s.shown.delete(id);
    if (replaced.length) actions.push({ type: 'discard', segmentIds: replaced });
    return actions;
  }

  return {
    push(event, now) {
      const source = event.source ?? 'microphone';
      const s = state(source);
      if (!locales.includes(event.locale) || s.dropped.has(event.locale)) return [];
      s.heard[event.locale] = now;
      if (event.type === 'recognition-progress') {
        s.progress[event.locale] = Math.max(s.progress[event.locale] ?? -Infinity, event.through);
        return resolve(source, s, now, false);
      }
      if (event.type === 'partial') {
        // A phrase's provisional start moves forward as it grows; it has finalized nothing until
        // its final arrives, so keep the earliest start it reported.
        const prior = s.volatile.get(event.segmentId);
        s.volatile.set(event.segmentId, {
          ...event,
          seenAt: now,
          timestamp: Math.min(prior?.timestamp ?? Infinity, event.timestamp),
        });
        return event.locale === s.leading ? [show(s, event)] : [];
      }
      s.volatile.delete(event.segmentId);
      const end = Math.max(event.end ?? event.timestamp, event.timestamp);
      // The language has finalized through the phrase's own end; its words say where it spoke.
      s.pending.push(spoken({ ...event, end }));
      s.through[event.locale] = Math.max(s.through[event.locale] ?? -Infinity, end);
      const actions = event.locale === s.leading ? [show(s, event)] : [];
      return [...actions, ...resolve(source, s, now, false)];
    },
    tick(now) {
      return [...sources].flatMap(([source, s]) => [
        ...expire(s, now),
        ...resolve(source, s, now, false),
      ]);
    },
    // The helper withdrew provisional text (revised to nothing, or covered by another final).
    discard(event, now) {
      const source = event.source ?? 'microphone';
      const s = state(source);
      return [...withdraw(s, event.segmentIds ?? []), ...resolve(source, s, now, false)];
    },
    // A language stopped working for this source: decide without it from now on.
    drop(source, locale, now) {
      const s = state(source);
      if (s.dropped.has(locale)) return [];
      s.dropped.add(locale);
      s.pending = s.pending.filter((p) => p.locale !== locale);
      const gone = [...s.shown].filter(([, l]) => l === locale).map(([id]) => id);
      for (const id of gone) s.shown.delete(id);
      const actions = gone.length ? [{ type: 'discard', segmentIds: gone }] : [];
      if (s.leading === locale) {
        s.leading = locales.find((l) => !s.dropped.has(l)) ?? locale;
        for (const event of s.volatile.values())
          if (event.locale === s.leading) actions.push(show(s, event));
      }
      return [...actions, ...resolve(source, s, now, false)];
    },
    // Recording stopped: decide everything still pending and clear provisional text.
    flush(now) {
      const actions = [];
      for (const [source, s] of sources) {
        actions.push(...expire(s, now));
        for (const event of s.volatile.values())
          if (!s.dropped.has(event.locale))
            s.pending.push({
              ...event,
              end: Math.max(event.end ?? event.timestamp, event.timestamp),
            });
        s.volatile.clear();
        actions.push(...resolve(source, s, now, true));
        if (s.shown.size) actions.push({ type: 'discard', segmentIds: [...s.shown.keys()] });
        s.shown.clear();
      }
      return actions;
    },
  };
}
