// Calendar reminders, Granola-style: announce a meeting shortly before it starts. Pure, so the
// main process, the renderer and the tests share one definition of "this meeting, this time".
import { translator } from './i18n/index.mjs';
import { meetingLink } from './calls.mjs';

export const LEAD_MS = 60_000;
// A reminder that arrives late (the app opened after the start) is still useful for a while.
export const LATE_MS = 5 * 60_000;

// EventKit gives every occurrence of a recurring meeting the same identifier, so the start time
// is part of the key: each weekly sync gets its own reminder and its own note.
export const eventKey = (event) => `${event.id}@${event.start}`;

// The note an occurrence starts with: its title and attendees, with the event's own notes kept as
// context for enhancing.
export const eventNote = (event) => ({
  title: String(event.title ?? '').slice(0, 300),
  participants: String(event.participants ?? '').slice(0, 2_000_000),
  notes: event.notes ? `Meeting context\n${event.notes}` : '',
  eventKey: eventKey(event),
});

export function dueReminders(events, now, announced, lead = LEAD_MS) {
  return (Array.isArray(events) ? events : []).filter((event) => {
    if (!event || event.allDay || announced.has(eventKey(event))) return false;
    const start = Date.parse(event.start),
      end = Date.parse(event.end);
    if (!Number.isFinite(start)) return false;
    const closes = Math.min(Number.isFinite(end) ? end : Infinity, start + LATE_MS);
    return start - lead <= now && now < closes;
  });
}

export function reminderBody(event, now, autoRecord, t = translator('en')) {
  // Round toward the start: 29 s ahead is "in 1 min", not "now".
  const ms = Date.parse(event.start) - now;
  const when =
    ms > 0
      ? t('Starts in {n} min', { n: Math.ceil(ms / 60_000) })
      : ms > -60_000
        ? t('Starting now')
        : t('Started {n} min ago', { n: Math.floor(-ms / 60_000) });
  const action = meetingLink(event)
    ? autoRecord
      ? t('Click to join, take notes and start recording.')
      : t('Click to join and take notes.')
    : autoRecord
      ? t('Click to take notes and start recording.')
      : t('Click to take notes.');
  return `${when} · ${action}`;
}

// What clicking a reminder does: record when that is on, and join the call the event links to.
// A reminder clicked in Notification Center after the meeting ended only opens the note.
export function reminderAction(event, now, autoRecord) {
  const end = Date.parse(event.end);
  const over = Number.isFinite(end) && now >= end;
  return { record: autoRecord && !over, join: over ? null : meetingLink(event) };
}

export const meetingForEvent = (meetings, key) =>
  (Array.isArray(meetings) ? meetings : []).find((m) => !m.deletedAt && m.eventKey === key);
