// Speaker echo in the audio itself. Beside a cut echo the recognizer often leaves a word or two,
// and the text alone cannot say whether they are more of the echo or the user's own. The two
// tracks' loudness can: an echo is meeting audio played back by the speakers, a moment later and
// fading as the room does, so it is never much louder than meeting audio makes it there, while the
// user's own voice rises above that, if only in meeting audio's pauses between syllables. How
// loud and how late the echo is comes from echo already known nearby, never from across an input
// restart, since another device hears the speakers differently. Every doubt keeps the words.
// Pure; shared by live capture and Retry.

export const defaultAudio = {
  playing: -45, // dB: meeting audio this loud is playing
  share: 0.6, // of a stretch's frames during which meeting audio must be playing
  reach: 0.25, // seconds: the most the microphone's echo may lead or lag meeting audio's track
  fade: 1, // dB per 10 ms that the room's echo of a sound is taken to fade, at the slowest
  tail: 0.3, // seconds of that fading
  margin: 3, // dB above the most the known echo reached that counts as the microphone's own
  voiced: 3, // frames of 10 ms in a row that loud: the user said something
  audible: -50, // dB: an echo at least this loud could hide a voice under it, so it must also
  follows: 0.92, // correlate with meeting audio at least this closely in loudness
  shape: 0.92, // and in decibels, where the quiet between syllables counts as much
  near: 30, // seconds: how far known echo may be from what it calibrates
  needed: 50, // frames of known echo, with meeting audio playing, to calibrate on
  restart: 5, // frames of exact silence: the input restarted, maybe on another device
};

const rate = 100; // frames a second

// Mean power every 10 ms of 16-bit samples.
export function levels(samples, sampleRate = 16000) {
  const size = sampleRate / rate;
  const out = new Float32Array(Math.floor(samples.length / size));
  for (let f = 0; f < out.length; f++) {
    let sum = 0;
    for (let i = f * size; i < (f + 1) * size; i++) sum += (samples[i] / 32768) ** 2;
    out[f] = sum / size;
  }
  return out;
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

// How closely the microphone's loudness follows meeting audio's `lag` frames earlier, over frames.
function correlation(mic, sys, frames, lag, scale = Math.sqrt) {
  let n = 0,
    sx = 0,
    sy = 0,
    sxx = 0,
    syy = 0,
    sxy = 0;
  for (const f of frames) {
    const x = sys(f - lag),
      y = mic(f);
    if (x === undefined || y === undefined) continue;
    const a = scale(x),
      b = scale(y);
    n++;
    sx += a;
    sy += b;
    sxx += a * a;
    syy += b * b;
    sxy += a * b;
  }
  const spread = n ? (sxx / n - (sx / n) ** 2) * (syy / n - (sy / n) ** 2) : 0;
  return spread > 0 ? (sxy / n - (sx / n) * (sy / n)) / Math.sqrt(spread) : -1;
}

// Whether the microphone between `from` and `to` (seconds) heard nothing but the speakers.
// `microphone` and `system` are `{ start, power }`, power every 10 ms from `start` seconds; `known`
// are stretches, as `[from, to]`, already known to be echo.
export function onlyEcho(microphone, system, [from, to], known = [], settings = defaultAudio) {
  const o = { ...defaultAudio, ...settings };
  const track = (t) => (f) => {
    const k = f - Math.round(t.start * rate);
    return k >= 0 && k < t.power.length ? t.power[k] : undefined;
  };
  const mic = track(microphone),
    sys = track(system);
  const reach = Math.round(o.reach * rate),
    tail = Math.round(o.tail * rate),
    first = Math.floor(from * rate),
    last = Math.ceil(to * rate);
  if (!(last > first)) return false;
  const span = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  if (span.some((f) => mic(f) === undefined || sys(f - reach - tail) === undefined)) return false;
  if (span.some((f) => sys(f + reach) === undefined)) return false;
  // Input restarts are written as exact silence; nothing is learned across one.
  const near = o.near * rate,
    restarts = [];
  for (let f = first - near, run = 0; f <= last + near + 1; f++) {
    if (mic(f) === 0) run++;
    else {
      if (run >= o.restart) restarts.push([f - run, f - 1]);
      run = 0;
    }
  }
  const across = (a, b) => restarts.some(([x, y]) => x <= b && y >= a);
  if (across(first - tail, last)) return false;
  const reference = known
    .map(([a, b]) => [Math.floor(a * rate), Math.ceil(b * rate)])
    .filter(([a, b]) => b >= first - near && a <= last + near)
    .filter(([a, b]) => !across(Math.min(a, first), Math.max(b, last)))
    .flatMap(([a, b]) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i))
    .filter(
      (f) => mic(f) > 0 && sys(f - reach - tail) !== undefined && sys(f + reach) !== undefined,
    );
  if (reference.length < o.needed) return false;
  // How late the echo is here, then what meeting audio would make of it a frame at a time: the
  // loudest of what was just played, faded as a room fades it.
  let lag = 0,
    best = -2;
  for (let l = -reach; l <= reach; l++) {
    const c = correlation(mic, sys, reference, l);
    if (c > best) [best, lag] = [c, l];
  }
  const fade = 10 ** (-o.fade / 10);
  const expected = (f) => {
    let most = 0;
    for (let k = -2, weight = 1; k <= tail; k++) {
      most = Math.max(most, (sys(f - lag - k) ?? 0) * weight);
      if (k >= 0) weight *= fade;
    }
    return most;
  };
  const playing = 10 ** (o.playing / 10);
  if (span.filter((f) => expected(f) >= playing).length < o.share * span.length) return false;
  // How loud the speakers make it: the most the known echo reached of what was expected.
  const ratios = reference.flatMap((f) => {
    const e = expected(f);
    return e >= playing ? [mic(f) / e] : [];
  });
  if (ratios.length < o.needed) return false;
  const most = percentile(ratios, 0.95),
    louder = most * 10 ** (o.margin / 10);
  for (let f = first, run = 0; f <= last; f++) {
    run = mic(f) > louder * Math.max(expected(f), playing / 10) ? run + 1 : 0;
    if (run >= o.voiced) return false;
  }
  // An echo too quiet to hide speech under it is told apart by loudness alone. A louder one could
  // drown out a quieter voice, so there the microphone must also have risen and fallen with
  // meeting audio, its loudness and its quiet between syllables alike.
  if (Math.max(...span.map(expected)) * most < 10 ** (o.audible / 10)) return true;
  const around = Array.from({ length: last - first + 101 }, (_, i) => first - 50 + i);
  const decibels = (v) => 10 * Math.log10(Math.max(v, 1e-7));
  return (
    correlation(mic, sys, around, lag) >= o.follows &&
    correlation(mic, sys, around, lag, decibels) >= o.shape
  );
}
