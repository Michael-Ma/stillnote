// The floating panel Stillnote shows at the top right instead of a system notification, like
// Granola's: what it says and offers. Pure; the main process shows it and runs the chosen action.
//
// A panel is { kind, key (the calendar occurrence, if any), title, detail, color, primary:
// { id, label }, menu: [{ id, label }], more (the menu button's name), and either `expires` (it
// goes by itself then, the bar shrinking towards it) or `deadline` (the bar counts down to an
// automatic stop; `countdown` says so, with {n} seconds left) }. Clicking its text is the action
// 'open'; 'dismiss' closes it.
import { translator } from './i18n/index.mjs';
import { callServices, meetingLink, startableServices } from './calls.mjs';
import { time } from './format.mjs';
import { eventKey } from './reminders.mjs';

// Window size, with room around the card for its shadow.
export const panelSize = { width: 520, height: 112 };

// Top right of the work area (below the menu bar), on the display in use.
export function panelBounds(workArea, size = panelSize) {
  return {
    x: Math.round(workArea.x + workArea.width - size.width - 4),
    y: Math.round(workArea.y + 2),
    width: size.width,
    height: size.height,
  };
}

// A calendar's own color, when it is a plain #rrggbb; otherwise the panel's default.
const color = (value) => (/^#[0-9a-f]{6}$/i.test(String(value ?? '')) ? value.toLowerCase() : null);

// "11:30 AM – 12:00 PM", in the interface language.
export const timeRange = (event, locale) =>
  `${time(event.start, locale)} – ${time(event.end, locale)}`;

// A calendar meeting about to start. The main button joins its call and takes notes in one go;
// without a call link it takes notes, and the menu can start a Google Meet or Zoom call with
// them. `recording` is the title of another note being recorded, which is saved first.
export function reminderPanel(event, { now, recording = null, t = translator('en') }) {
  const link = meetingLink(event);
  return {
    kind: 'reminder',
    key: eventKey(event),
    title: event.title,
    detail: [
      timeRange(event, t.locale),
      recording !== null && t('Saves “{title}” first', { title: recording }),
    ]
      .filter(Boolean)
      .join(' · '),
    color: color(event.color),
    primary: link
      ? { id: 'join', label: t('Join and take notes') }
      : { id: 'notes', label: t('Take notes') },
    menu: [
      ...(link
        ? [{ id: 'notes', label: t('Take notes without joining') }]
        : startableServices.map((service) => ({
            id: `start-${service}`,
            label: t('Start {service} and take notes', { service: callServices[service].name }),
          }))),
      { id: 'dismiss', label: t('Dismiss') },
    ],
    more: t('More options'),
    // Until a minute after the meeting starts, and at least half a minute.
    expires: Math.max(now + 30_000, Date.parse(event.start) + 60_000),
  };
}

// Another app is using the microphone: a call is under way, so taking notes is all it offers.
export function detectedPanel(event, { now, t = translator('en') }) {
  return {
    kind: 'detected',
    key: event ? eventKey(event) : null,
    title: event?.title || t('Meeting detected'),
    detail: event
      ? `${t('Meeting detected')} · ${timeRange(event, t.locale)}`
      : t('Another app is using your microphone.'),
    color: color(event?.color),
    primary: { id: 'notes', label: t('Take notes') },
    menu: [{ id: 'dismiss', label: t('Dismiss') }],
    more: t('More options'),
    expires: now + 60_000,
  };
}

// The meeting being recorded seems to be over. With a deadline the recording stops by itself
// then; without one (Only ask) the panel waits.
export function meetingEndPanel(reason, { deadline = null, t = translator('en') }) {
  return {
    kind: 'meeting-end',
    key: null,
    title: t('The meeting seems to be over'),
    detail:
      reason === 'call'
        ? t('The call has ended and no one is speaking.')
        : reason === 'calendar'
          ? t('The calendar meeting has ended and no one is speaking.')
          : t('No one has spoken for a while.'),
    color: null,
    primary: { id: 'keep', label: t('Keep recording') },
    menu: [{ id: 'stop', label: t('Stop now') }],
    more: t('More options'),
    ...(deadline ? { deadline, countdown: t('Stopping in {n} s') } : {}),
  };
}
