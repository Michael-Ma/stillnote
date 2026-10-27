// Meeting-end detection while Stillnote records. Pure: the main process reports what it observes
// (the call app's microphone use, speech, the calendar meeting's end) and asks on a timer whether
// the meeting seems over, and why. Every signal also needs everyone to have stopped talking, so a
// quiet moment in a call or a meeting that runs over is not taken for its end:
// - 'call': the call app let go of the microphone (after holding it for `held` during this
//   recording) and nobody has spoken for `callQuiet` since. Muting keeps Zoom on the microphone;
//   the quiet requirement covers apps that let go of it while muted.
// - 'calendar': the calendar meeting's end has passed and nobody has spoken for `calendarQuiet`.
// - 'quiet': nobody has spoken for `quiet` (`quietInCall` while a call app still holds the
//   microphone), once someone has spoken at all: a recording started before people join waits.
// "Keep recording" (`dismiss`) answers the prompt: the call signal then needs the microphone taken
// and let go again, the calendar signal is spent, and silence counts again from then.
export function meetingEndDetector({
  held = 60_000,
  callQuiet = 10_000,
  calendarQuiet = 2 * 60_000,
  quiet = 10 * 60_000,
  quietInCall = 20 * 60_000,
} = {}) {
  let heardAt = 0,
    spoke = false,
    microphone = false,
    holdingSince = 0,
    releasedAt = null,
    called = false,
    end = null,
    calendarSpent = false;
  return {
    // Recording began (audio is being saved); `microphone` is whether a call app holds it now.
    start(now, { microphone: on = false, end: ends = null } = {}) {
      heardAt = now;
      microphone = on;
      holdingSince = now;
      this.calendar(ends);
    },
    // A brief release (switching microphones) continues the same hold.
    microphone(on, now) {
      if (on === microphone) return;
      microphone = on;
      if (on) {
        if (releasedAt === null || now - releasedAt >= callQuiet) holdingSince = now;
        releasedAt = null;
      } else {
        if (now - holdingSince >= held) called = true;
        releasedAt = now;
      }
    },
    heard(now) {
      heardAt = Math.max(heardAt, now);
      spoke = true;
    },
    calendar(ends) {
      end = Number.isFinite(ends) ? ends : null;
    },
    check(now) {
      if (microphone && now - holdingSince >= held) called = true;
      if (!microphone && called && now - Math.max(releasedAt, heardAt) >= callQuiet) return 'call';
      if (end !== null && !calendarSpent && now >= end && now - heardAt >= calendarQuiet)
        return 'calendar';
      if (spoke && now - heardAt >= (microphone ? quietInCall : quiet)) return 'quiet';
      return null;
    },
    dismiss(now) {
      called = false;
      holdingSince = now;
      if (end !== null && now >= end) calendarSpent = true;
      heardAt = Math.max(heardAt, now);
    },
  };
}

// For a source that is not transcribed, whether it carries sustained sound: audio levels (two a
// second) louder than `threshold` RMS for `needed` of the last `span` ms. Room noise, a click or a
// cough is not; someone talking is.
export function sustainedSound({ threshold = 0.006, needed = 8, span = 10_000 } = {}) {
  const loud = [];
  return (rms, now) => {
    while (loud.length && now - loud[0] >= span) loud.shift();
    if (Number(rms) > threshold) loud.push(now);
    return loud.length >= needed;
  };
}

// Where a stopped recording's long trailing silence starts, in seconds from its start, or null to
// keep it whole. Speech is the later of the last transcript line's end and the last sustained
// sound on any track (`sounds`, from lastSound); `pad` of quiet stays after it. Only a silence of
// at least `minimum` is cut, and a recording where nothing was heard at all is left alone.
export function trailingCut({ duration, speech = 0, sounds = [], pad = 10, minimum = 60 }) {
  const heard = Math.max(0, Number(speech) || 0, ...sounds.map((s) => Number(s) || 0));
  if (!(duration > 0) || heard <= 0) return null;
  const keep = heard + pad;
  return duration - keep >= minimum ? keep : null;
}
