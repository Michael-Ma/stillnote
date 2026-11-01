// Speaker echo: on a call without headphones the microphone re-records the other side from the
// speakers, so a sentence reaches the transcript twice, as `microphone` ("You") and as `system`
// ("Meeting audio"), a moment apart and nearly word for word. A microphone row is that echo when
// meeting audio said the same words at the same moments; it is left out. Your own speech must
// never go, so the match is strict: near-verbatim, word by word in time, with nothing of its own
// left over. The recognizer also joins the echo and your own words into one long row when nobody
// pauses: such a row loses only the stretches held to that same standard, and keeps the rest.
// Pure; shared by live capture and Retry.

import { piece } from './language-arbiter.mjs';

export const defaultEcho = {
  tolerance: 1.5, // seconds between a word and its echo
  coverage: 0.8, // share of the microphone row's words that meeting audio said, in order
  density: 0.6, // share of meeting audio's words, across the stretch it matched, that matched
  minimum: 4, // words; shorter rows ("Yeah.", "Thank you.") are always kept
  gap: 1.5, // the most consecutive words of the row that meeting audio did not say
  // Seconds the row may lag or lead meeting audio: an echo is heard while the words are said, a
  // sentence someone repeats comes after. Half the matched stretch for long rows, at most
  // `tolerance`. Measured echoes with word timing are within 0.25 s.
  shift: 0.6,
  stretch: 6, // words; the least that can go from inside a row, which needs word timing
  horizon: 120, // seconds of rows a live filter remembers
};

const asian = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const tokens = new RegExp(`[${asian}]+|(?:(?![${asian}])[\\p{L}\\p{N}])+(?:['’]\\p{L}+)*`, 'gu');
const isAsian = new RegExp(`[${asian}]`, 'u');
const asianChars = new RegExp(`[${asian}]`, 'gu');
const fillers = new Set('um umm uh uhh uhm er erm ah hm hmm mm mmm mhm'.split(' '));
const asianFillers = new Set(['嗯', '呃']);
// Recognizers write small numbers as words or digits from one sentence to the next.
const numbers = new Map(
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'
    .split(' ')
    .map((word, i) => [word, String(i)]),
);
// A Chinese or Japanese word is about one and a half characters. CJK runs count by neighbouring
// character pairs (single characters such as 我, 们 and 的 are in almost every sentence), each
// weighing two thirds of a word.
const pairWeight = 2 / 3;
// Words a stretch never takes with it when meeting audio did not say them: if the row has one,
// the user may have been speaking there.
const firstPerson = new Set(
  "i i'm i'd i'll i've me my mine we we're we'd we'll we've us our 我 咱 俺".split(' '),
);

const start = (row) => Math.max(0, Number(row.timestamp) || 0);
const timed = (row) => Array.isArray(row.runs) && row.runs.length > 0;
const wordRuns = (row) =>
  timed(row)
    ? row.runs.filter(
        (run) =>
          Array.isArray(run) &&
          Number.isFinite(Number(run[0])) &&
          Number.isFinite(Number(run[1])) &&
          typeof run[3] === 'string',
      )
    : [];
// Without the recognizer's end, about three words or four and a half CJK characters a second.
const estimates = new WeakMap();
function end(row) {
  const from = start(row);
  if (Number(row.end) > from) return Number(row.end);
  if (!estimates.has(row)) {
    const text = String(row.text ?? '');
    const han = text.match(asianChars)?.length ?? 0;
    const words = text.replace(asianChars, ' ').match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
    estimates.set(row, Math.max(0.5, words / 3 + han / 4.5));
  }
  return from + estimates.get(row);
}

// The row's words, when each was said, and where in the row's text (`at`, one place for a word and
// two for a pair of characters): from word timing where the recognizer gave it, otherwise spread
// evenly over the row.
export function timedWords(row) {
  const runs = wordRuns(row);
  const pieces = runs.length
    ? runs.map((run) => [run[3], Number(run[0]), Math.max(Number(run[0]), Number(run[1]))])
    : [[String(row.text ?? ''), start(row), end(row)]];
  let text = '';
  const times = [];
  for (const [piece, from, to] of pieces) {
    // The span starts with its first letter (runs begin with the space before their word).
    const lead = Math.max(0, piece.search(/[\p{L}\p{N}]/u));
    for (let i = 0; i < piece.length; i++)
      times.push(from + ((to - from) * Math.max(0, i - lead)) / (piece.length - lead || 1));
    text += piece;
  }
  const words = [];
  for (const match of text.matchAll(tokens)) {
    const word = match[0];
    if (isAsian.test(word)) {
      const chars = [...word]
        .map((char, i) => ({ char, at: match.index + i, time: times[match.index + i] }))
        .filter(({ char }) => !asianFillers.has(char));
      if (chars.length === 1)
        words.push({
          word: chars[0].char,
          time: chars[0].time,
          weight: pairWeight,
          at: [chars[0].at],
        });
      for (let i = 1; i < chars.length; i++)
        words.push({
          word: chars[i - 1].char + chars[i].char,
          time: chars[i - 1].time,
          weight: pairWeight,
          at: [chars[i - 1].at, chars[i].at],
        });
      continue;
    }
    const plain = word.normalize('NFKC').toLowerCase().replace(/’/g, "'");
    if (fillers.has(plain)) continue;
    words.push({
      word: numbers.get(plain) ?? plain,
      time: times[match.index],
      weight: 1,
      at: [match.index],
    });
  }
  return words;
}

// The longest in-order match of the row's words in meeting audio's, pairing only words said
// within `tolerance` seconds of each other; among equally long matches, the one closest in time.
function align(own, heard, tolerance) {
  const width = heard.length + 1,
    size = (own.length + 1) * width;
  const weight = new Float64Array(size),
    cost = new Float64Array(size),
    step = new Uint8Array(size);
  const better = (w, c, at) => w > weight[at] + 1e-9 || (w > weight[at] - 1e-9 && c < cost[at]);
  for (let i = 1; i <= own.length; i++)
    for (let j = 1; j <= heard.length; j++) {
      const at = i * width + j,
        up = at - width,
        left = at - 1,
        diagonal = up - 1;
      weight[at] = weight[up];
      cost[at] = cost[up];
      step[at] = 1;
      if (better(weight[left], cost[left], at)) {
        weight[at] = weight[left];
        cost[at] = cost[left];
        step[at] = 2;
      }
      const a = own[i - 1],
        b = heard[j - 1],
        shift = Math.abs(a.time - b.time);
      if (
        a.word === b.word &&
        shift <= tolerance &&
        better(weight[diagonal] + a.weight, cost[diagonal] + shift, at)
      ) {
        weight[at] = weight[diagonal] + a.weight;
        cost[at] = cost[diagonal] + shift;
        step[at] = 3;
      }
    }
  const pairs = [];
  for (let i = own.length, j = heard.length; i > 0 && j > 0;) {
    const s = step[i * width + j];
    if (s === 3) pairs.push([--i, --j]);
    else if (s === 2) j--;
    else i--;
  }
  return pairs.reverse();
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b),
    middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// What a row says, by place in its text: a word, or a CJK character. A character heard wrong costs
// the two pairs around it but only itself here, so a word heard wrong weighs about the same in
// Chinese as in English.
function spoken(own) {
  const units = new Map();
  for (const word of own)
    word.at.forEach((at, i) =>
      units.set(at, {
        text: word.at.length > 1 ? [...word.word][i] : word.word,
        weight: word.weight,
      }),
    );
  return units;
}

// How closely `units` of the row follow meeting audio, with `pairs` the words of theirs it matched.
function closeness(units, own, heard, pairs) {
  const said = new Set(pairs.flatMap(([i]) => own[i].at));
  let total = 0,
    covered = 0,
    gap = 0, // words of its own: the longest stretch that meeting audio did not say
    run = 0;
  for (const [at, { weight }] of units) {
    total += weight;
    if (said.has(at)) covered += weight;
    run = said.has(at) ? 0 : run + weight;
    gap = Math.max(gap, run);
  }
  return {
    matched: pairs.reduce((sum, [i]) => sum + own[i].weight, 0),
    coverage: covered / total,
    gap,
    density: pairs.length / (pairs.at(-1)[1] - pairs[0][1] + 1),
    shift: median(pairs.map(([i, j]) => own[i].time - heard[j].time)),
  };
}

// The parts of a row that meeting audio said, each from its first matched word to its last, held
// to what a whole row is held to. Word timing is what lets them be cut, so a stretch has no
// allowance for estimated times. A word of the first person ends a stretch.
function echoStretches(units, own, heard, pairs, options) {
  const said = new Set(pairs.flatMap(([i]) => own[i].at));
  const unsaid = [...units].filter(([at]) => !said.has(at));
  const groups = [];
  pairs.forEach((pair, k) => {
    const between = k
      ? unsaid.filter(([at]) => at > own[pairs[k - 1][0]].at[0] && at < own[pair[0]].at.at(-1))
      : [];
    const weight = between.reduce((sum, [, unit]) => sum + unit.weight, 0);
    if (!k || weight > options.gap || between.some(([, unit]) => firstPerson.has(unit.text)))
      groups.push([]);
    groups.at(-1).push(pair);
  });
  return groups.flatMap((group) => {
    const from = own[group[0][0]].at[0],
      to = own[group.at(-1)[0]].at.at(-1);
    const inside = new Map([...units].filter(([at]) => at >= from && at <= to));
    const stretch = closeness(inside, own, heard, group);
    return stretch.matched >= options.stretch &&
      stretch.coverage >= options.coverage &&
      stretch.density >= options.density &&
      Math.abs(stretch.shift) <= options.shift
      ? [[from, to]]
      : [];
  });
}

// Whether a microphone row is the speakers' echo of meeting audio (`system` rows, any order), how
// closely it matched, and which stretches of it are the echo when the whole of it is not.
export function echoMatch(row, systemRows, settings = defaultEcho, words = timedWords) {
  const options = { ...defaultEcho, ...settings };
  const own = words(row);
  const total = own.reduce((sum, w) => sum + w.weight, 0);
  const result = { echo: false, coverage: 0, stretches: [] };
  if (total < options.minimum) return result;
  const from = start(row) - options.tolerance,
    to = end(row) + options.tolerance;
  const nearby = systemRows
    .filter((s) => s.source === 'system' && start(s) <= to && end(s) >= from)
    .sort((a, b) => start(a) - start(b));
  // One recognizer's phrases follow each other: a phrase without word timing whose estimated end
  // runs into the next one stops where that one starts.
  const heard = nearby.flatMap((s, k) => {
    const next = nearby[k + 1];
    return !timed(s) && next && start(next) > start(s) && end(s) > start(next)
      ? timedWords({ ...s, end: start(next) })
      : words(s);
  });
  const pairs = align(own, heard, options.tolerance);
  if (!pairs.length) return result;
  const units = spoken(own);
  const { matched, ...close } = closeness(units, own, heard, pairs);
  const first = pairs[0],
    last = pairs.at(-1);
  const allowed = Math.min(
    options.tolerance,
    Math.max(options.shift, (own[last[0]].time - own[first[0]].time) / 2),
  );
  Object.assign(result, close, {
    stretches: echoStretches(units, own, heard, pairs, options),
  });
  result.echo =
    matched >= options.minimum &&
    result.coverage >= options.coverage &&
    result.gap <= options.gap &&
    result.density >= options.density &&
    Math.abs(result.shift) <= allowed;
  return result;
}

// What stays of a microphone row: `null` when all of it does, nothing when it is the echo, and
// otherwise the parts around its echoed stretches, in the row's place. A cut falls between the
// recognizer's runs, and a run with a word outside the stretch stays whole.
function remainder(row, systemRows, options, words) {
  const match = echoMatch(row, systemRows, options, words);
  if (match.echo) return [];
  if (!match.stretches.length || !timed(row) || !row.segmentId) return null;
  const inside = (at) => match.stretches.some(([from, to]) => at >= from && at <= to);
  const places = words(row).flatMap((word) => word.at);
  const parts = [[]];
  let offset = 0,
    cut = false;
  for (const run of wordRuns(row)) {
    const from = offset;
    offset += run[3].length;
    const own = places.filter((at) => at >= from && at < offset);
    if (own.length ? own.every(inside) : inside(from)) {
      cut = true;
      parts.push([]);
    } else parts.at(-1).push(run);
  }
  if (!cut) return null;
  const kept = parts.filter((runs) => runs.some((run) => /[\p{L}\p{N}]/u.test(run[3])));
  return kept.map((runs, i) => piece(row, runs, i, kept.length));
}

const remembered = () => {
  const cache = new WeakMap();
  return (row) => {
    if (!cache.has(row)) cache.set(row, timedWords(row));
    return cache.get(row);
  };
};

// Retry: every row is known up front. The rows without the microphone's echoes, in their order,
// the echoes left out, and the rows that lost part of themselves with what is left of each.
export function suppressEcho(segments, settings = defaultEcho) {
  const options = { ...defaultEcho, ...settings };
  const words = remembered();
  const system = segments.filter((s) => s.source === 'system');
  const removed = [],
    trimmed = [];
  const kept = segments.flatMap((row) => {
    const pieces = row.source === 'microphone' ? remainder(row, system, options, words) : null;
    if (!pieces) return [row];
    if (pieces.length) trimmed.push({ row, pieces });
    else removed.push(row);
    return pieces;
  });
  return { segments: kept, removed, trimmed };
}

// Live capture: final rows arrive as each source finalizes them, in either order. `add` takes one
// and says whether it goes into the transcript (not a microphone echo of what meeting audio
// already said), which microphone rows already in it a new meeting audio row shows to be echoes,
// and which rows, this one included, keep only `pieces` of themselves. A row with the `segmentId`
// of an earlier one replaces it, and the parts of it.
export function createEchoFilter(settings = defaultEcho) {
  const options = { ...defaultEcho, ...settings };
  const words = remembered();
  let microphone = [],
    system = [],
    latest = 0;
  const others = (rows, row) => rows.filter((r) => !row.segmentId || r.segmentId !== row.segmentId);
  const partsOf = (row) =>
    row.segmentId ? microphone.filter((r) => r.parent?.id === row.segmentId) : [];
  return {
    add(row) {
      if (!['microphone', 'system'].includes(row.source) || !String(row.text ?? '').trim())
        return { keep: true, remove: [], trim: [] };
      latest = Math.max(latest, end(row));
      const recent = (r) => end(r) >= latest - options.horizon;
      const parts = partsOf(row);
      microphone = others(microphone, row)
        .filter((r) => !parts.includes(r))
        .filter(recent);
      system = others(system, row).filter(recent);
      if (row.source === 'microphone') {
        const pieces = remainder(row, system, options, words);
        if (pieces?.length === 0) return { keep: false, remove: parts, trim: [] };
        microphone.push(...(pieces ?? [row]));
        return { keep: true, remove: parts, trim: pieces ? [{ row, pieces }] : [] };
      }
      system.push(row);
      const from = start(row) - options.tolerance,
        to = end(row) + options.tolerance;
      const remove = [],
        trim = [];
      microphone = microphone.flatMap((r) => {
        if (start(r) > to || end(r) < from) return [r];
        const pieces = remainder(r, system, options, words);
        if (!pieces) return [r];
        if (pieces.length) trim.push({ row: r, pieces });
        else remove.push(r);
        return pieces;
      });
      return { keep: true, remove, trim };
    },
  };
}
