// Calendar reminders, Granola-style: announce a meeting shortly before it starts. Pure, so the
// main process, the renderer and the tests share one definition of "this meeting, this time".
import { translator } from './i18n/index.mjs';
import { meetingLink } from './calls.mjs';
import { readableContext } from './meeting-context.mjs';

export const LEAD_MS = 60_000;
// A reminder that arrives late (the app opened after the start) is still useful for a while.
export const LATE_MS = 5 * 60_000;

// EventKit gives every occurrence of a recurring meeting the same identifier, so the start time
// is part of the key: each weekly sync gets its own reminder and its own note.
export const eventKey = (event) => `${event.id}@${event.start}`;

// The note an occurrence starts with: its title and attendees, with the event's own notes, made
// readable, kept as context for enhancing.
export const eventNote = (event, t = translator('en')) => {
  const context = readableContext(String(event.notes ?? '').slice(0, 1_000_000), t);
  return {
    title: String(event.title ?? '').slice(0, 300),
    participants: String(event.participants ?? '').slice(0, 2_000_000),
    notes: context ? `Meeting context\n${context}` : '',
    eventKey: eventKey(event),
  };
};

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

// What clicking a reminder does: record when that is on, and join the call the event links to.
// A reminder answered after the meeting ended only opens the note.
export function reminderAction(event, now, autoRecord) {
  const end = Date.parse(event.end);
  const over = Number.isFinite(end) && now >= end;
  return { record: autoRecord && !over, join: over ? null : meetingLink(event) };
}

export const meetingForEvent = (meetings, key) =>
  (Array.isArray(meetings) ? meetings : []).find((m) => !m.deletedAt && m.eventKey === key);
