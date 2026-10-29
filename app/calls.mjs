// Video calls, Granola-style: start a new Google Meet or Zoom call, join the call a calendar event
// links to, and notice a meeting that starts on its own. Pure, so the main process, the renderer
// and the tests share one definition; only the main process opens these links.
import { translator } from './i18n/index.mjs';
import { time } from './format.mjs';

// A new call opens in the browser or meeting app the Mac uses for these links.
// - Google Meet: meet.google.com/new creates a meeting for the signed-in Google account.
// - Zoom: zoom.us/start/videomeeting is zoom.us's own "Host a meeting" link. It starts an instant
//   meeting for the signed-in account and hands it to the Zoom app (or Zoom's web client). Zoom's
//   zoommtg:// links need an existing meeting number and Zoom no longer supports them, so they
//   cannot start a new meeting by themselves.
export const callServices = {
  meet: { name: 'Google Meet', start: 'https://meet.google.com/new' },
  zoom: { name: 'Zoom', start: 'https://zoom.us/start/videomeeting' },
  teams: { name: 'Microsoft Teams' },
};
export const startableServices = ['meet', 'zoom'];

// The hosts and paths each service's meeting links use. Nothing else is ever opened.
const rules = {
  meet: {
    host: (host) => host === 'meet.google.com',
    path: /^\/(?:[a-z]{3}-[a-z]{4}-[a-z]{3}|lookup\/[\w-]+)\/?$/i,
  },
  zoom: {
    host: (host) => /^(?:[a-z0-9-]+\.)*zoom(?:gov)?\.(?:us|com)$/.test(host),
    path: /^\/(?:j|s|w|my|wc)\/[^/]/i,
  },
  teams: {
    host: (host) => host === 'teams.microsoft.com' || host === 'teams.live.com',
    path: /^\/(?:l\/meetup-join|meet)\/[^/]/i,
  },
};

// The service and normalized address of a plain https meeting link, or null.
export function callLink(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  for (const [service, rule] of Object.entries(rules))
    if (rule.host(url.hostname) && rule.path.test(url.pathname)) return { service, url: url.href };
  return null;
}

// The first meeting link in a calendar event: its URL field, then location, then notes. Calendar
// notes are often HTML or wrap links in <…>, and sentences end right after them.
const candidates = /https:\/\/[^\s<>"'()[\]{}]+/gi;
export function meetingLink(event) {
  for (const field of [event?.url, event?.location, event?.notes]) {
    if (typeof field !== 'string') continue;
    for (const [raw] of field.slice(0, 100_000).replaceAll('&amp;', '&').matchAll(candidates)) {
      const link = callLink(raw.replace(/[.,;:!?*]+$/, ''));
      if (link) return link;
    }
  }
  return null;
}

// A call's note title in the interface language: "Google Meet · 2:05 PM", or "Meeting · 2:05 PM".
export const callTitle = (service, at, t = translator('en')) =>
  callServices[service]
    ? t('{service} · {time}', { service: callServices[service].name, time: time(at, t.locale) })
    : t('Meeting · {time}', { time: time(at, t.locale) });

// The calendar meeting under way, or starting within `lead`, when a call is detected, so the notes
// go into that occurrence's note. The one starting nearest to now wins. Only meetings count (a
// call link or attendees): a call during a long "Focus time" block gets a note of its own.
export function currentEvent(events, now, lead = 5 * 60_000) {
  let best = null;
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.allDay) continue;
    if (!meetingLink(event) && !String(event.participants ?? '').trim()) continue;
    const start = Date.parse(event.start),
      end = Date.parse(event.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start - lead > now || now >= end)
      continue;
    if (!best || Math.abs(start - now) < Math.abs(Date.parse(best.start) - now)) best = event;
  }
  return best;
}

// Apps that use a microphone without being in a call, by bundle identifier (helpers included:
// com.granola.app.helper). macOS's screen and audio capture service holds an input for as long as
// anything records meeting audio, Stillnote included; other note-takers hold the microphone while
// they take notes, Granola until it decides the call is over. Counting them would hide both a
// call's start and its end. Dictation listens for as long as someone speaks, often longer than a
// call takes to settle: macOS's own (its speech service, corespeechd), push-to-talk apps that
// default to the fn key (Wispr Flow, Typeless), and input methods with voice typing.
export const nonCallApps = [
  'com.apple.replayd',
  'local.stillnote.app',
  'com.granola.app',
  'notion.id',
  'com.goodsnooze.MacWhisper',
  'com.superduper.superwhisper',
  'com.apple.VoiceMemos',
  'com.apple.CoreSpeech',
  'com.electron.wispr-flow',
  'now.typeless.desktop',
  'com.prakashjoshipax.VoiceInk',
  'com.electron.aqua-voice',
  'app.spokenly',
  'com.seewillow.WillowMac',
  'com.zeitalabs.jottleai',
  'com.pais.handy',
  'com.gizmolabs.openwhispr',
  'com.tencent.inputmethod.wetype',
  'com.sogou.inputmethod.sogou',
];
const nonCall = (app) =>
  nonCallApps.some((id) => {
    const name = String(app).toLowerCase(),
      other = id.toLowerCase();
    return name === other || name.startsWith(`${other}.`);
  });

// Whether a call is using the microphone, from the helper's report: the apps using it (macOS 14)
// or, without them (macOS 13), only whether anything else is.
export const callOnMicrophone = ({ active, apps }) =>
  Array.isArray(apps) ? apps.some((app) => !nonCall(app)) : active === true;

// Meeting detection. Another app's microphone use counts as a meeting once it has lasted `settle`
// ms without a break (a quick voice memo does not, nor do two of them a minute apart; dictation
// apps never count, see nonCallApps); a pause shorter than `gap` (muting, switching microphones)
// continues the same session.
// A session prompts at most once, and never when Stillnote recorded during it. `session` numbers
// sessions, so a prompt acted on later can tell whether its call is still the one under way.
export function meetingDetector({ settle = 5000, gap = 90_000 } = {}) {
  let active = false,
    since = 0,
    quietSince = -Infinity,
    handled = false,
    session = 0;
  return {
    observe(on, now) {
      if (on && !active) {
        if (now - quietSince >= gap) {
          handled = false;
          session++;
        }
        since = now;
        active = true;
      } else if (!on && active) {
        active = false;
        quietSince = now;
      }
    },
    // True once per session, when it has lasted long enough and Stillnote is not recording.
    due(now, busy) {
      if (!active || handled) return false;
      if (busy) handled = true;
      else if (now - since >= settle) {
        handled = true;
        return true;
      }
      return false;
    },
    // How long until `due` can next turn true, or null when it cannot.
    next(now) {
      return active && !handled ? Math.max(0, since + settle - now) : null;
    },
    active: () => active,
    session: () => session,
  };
}
