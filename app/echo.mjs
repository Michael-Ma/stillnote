// Speaker echo: on a call without headphones the microphone re-records the other side from the
// speakers, so a sentence reaches the transcript twice, as `microphone` ("You") and as `system`
// ("Meeting audio"), a moment apart and nearly word for word. A microphone row is that echo when
// meeting audio said the same words at the same moments; it is left out. Your own speech must
// never go, so the match is strict: near-verbatim, word by word in time, with nothing of its own
// left over. Pure; shared by live capture and Retry.

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

const start = (row) => Math.max(0, Number(row.timestamp) || 0);
const timed = (row) => Array.isArray(row.runs) && row.runs.length > 0;
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

// The row's words and when each was said: from word timing where the recognizer gave it,
// otherwise spread evenly over the row.
export function timedWords(row) {
  const runs = timed(row)
    ? row.runs.filter(
        (run) =>
          Array.isArray(run) &&
          Number.isFinite(Number(run[0])) &&
          Number.isFinite(Number(run[1])) &&
          typeof run[3] === 'string',
      )
    : [];
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
        .map((char, i) => ({ char, time: times[match.index + i] }))
        .filter(({ char }) => !asianFillers.has(char));
      if (chars.length === 1)
        words.push({ word: chars[0].char, time: chars[0].time, weight: pairWeight });
      for (let i = 1; i < chars.length; i++)
        words.push({
          word: chars[i - 1].char + chars[i].char,
          time: chars[i - 1].time,
          weight: pairWeight,
        });
      continue;
    }
    const plain = word.normalize('NFKC').toLowerCase().replace(/’/g, "'");
    if (fillers.has(plain)) continue;
    words.push({ word: numbers.get(plain) ?? plain, time: times[match.index], weight: 1 });
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

// Whether a microphone row is the speakers' echo of meeting audio (`system` rows, any order), and
// how closely it matched.
export function echoMatch(row, systemRows, settings = defaultEcho, words = timedWords) {
  const options = { ...defaultEcho, ...settings };
  const own = words(row);
  const total = own.reduce((sum, w) => sum + w.weight, 0);
  const result = { echo: false, coverage: 0 };
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
  const matched = new Set(pairs.map(([i]) => i));
  const said = pairs.reduce((sum, [i]) => sum + own[i].weight, 0);
  // Words of its own: the longest stretch of the row that meeting audio did not say.
  let gap = 0,
    run = 0;
  own.forEach((w, i) => {
    run = matched.has(i) ? 0 : run + w.weight;
    gap = Math.max(gap, run);
  });
  const first = pairs[0],
    last = pairs.at(-1);
  const density = pairs.length / (last[1] - first[1] + 1);
  const shift = median(pairs.map(([i, j]) => own[i].time - heard[j].time));
  const allowed = Math.min(
    options.tolerance,
    Math.max(options.shift, (own[last[0]].time - own[first[0]].time) / 2),
  );
  Object.assign(result, { coverage: said / total, gap, density, shift });
  result.echo =
    said >= options.minimum &&
    result.coverage >= options.coverage &&
    gap <= options.gap &&
    density >= options.density &&
    Math.abs(shift) <= allowed;
  return result;
}

const remembered = () => {
  const cache = new WeakMap();
  return (row) => {
    if (!cache.has(row)) cache.set(row, timedWords(row));
    return cache.get(row);
  };
};

// Retry: every row is known up front. The rows without the microphone's echoes, in their order,
// and the echoes left out.
export function suppressEcho(segments, settings = defaultEcho) {
  const words = remembered();
  const system = segments.filter((s) => s.source === 'system');
  const removed = segments.filter(
    (s) => s.source === 'microphone' && echoMatch(s, system, settings, words).echo,
  );
  const gone = new Set(removed);
  return { segments: segments.filter((s) => !gone.has(s)), removed };
}

// Live capture: final rows arrive as each source finalizes them, in either order. `add` takes one
// and says whether it goes into the transcript (not a microphone echo of what meeting audio
// already said), and which microphone rows already in it a new meeting audio row shows to be
// echoes. A row with the `segmentId` of an earlier one replaces it.
export function createEchoFilter(settings = defaultEcho) {
  const options = { ...defaultEcho, ...settings };
  const words = remembered();
  let microphone = [],
    system = [],
    latest = 0;
  const others = (rows, row) => rows.filter((r) => !row.segmentId || r.segmentId !== row.segmentId);
  return {
    add(row) {
      if (!['microphone', 'system'].includes(row.source) || !String(row.text ?? '').trim())
        return { keep: true, remove: [] };
      latest = Math.max(latest, end(row));
      const recent = (r) => end(r) >= latest - options.horizon;
      microphone = others(microphone, row).filter(recent);
      system = others(system, row).filter(recent);
      if (row.source === 'microphone') {
        if (echoMatch(row, system, options, words).echo) return { keep: false, remove: [] };
        microphone.push(row);
        return { keep: true, remove: [] };
      }
      system.push(row);
      const from = start(row) - options.tolerance,
        to = end(row) + options.tolerance;
      const remove = microphone.filter(
        (r) => start(r) <= to && end(r) >= from && echoMatch(r, system, options, words).echo,
      );
      microphone = microphone.filter((r) => !remove.includes(r));
      return { keep: true, remove };
    },
  };
}
