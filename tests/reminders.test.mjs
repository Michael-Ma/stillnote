import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEAD_MS,
  LATE_MS,
  dueReminders,
  eventKey,
  eventNote,
  meetingForEvent,
  reminderAction,
} from '../app/reminders.mjs';

const now = Date.parse('2026-10-21T10:00:00Z');
const event = (id, startOffset, minutes = 30, extra = {}) => ({
  id,
  title: id,
  start: new Date(now + startOffset).toISOString(),
  end: new Date(now + startOffset + minutes * 60_000).toISOString(),
  ...extra,
});

test('a meeting is due from one minute before its start until a few minutes after', () => {
  const events = [
    event('early', LEAD_MS + 1000),
    event('soon', LEAD_MS - 1000),
    event('now', 0),
    event('late', -LATE_MS + 1000),
    event('too-late', -LATE_MS - 1000),
  ];
  assert.deepEqual(
    dueReminders(events, now, new Set()).map((e) => e.id),
    ['soon', 'now', 'late'],
  );
});

test('ended, all-day, malformed and already announced meetings are skipped', () => {
  const short = event('short', -2 * 60_000, 1);
  const announced = new Set([eventKey(event('done', 0))]);
  const events = [short, event('day', 0, 60 * 24, { allDay: true }), { id: 'x' }, event('done', 0)];
  assert.deepEqual(dueReminders(events, now, announced), []);
  assert.deepEqual(dueReminders(null, now, new Set()), []);
});

test('each occurrence of a recurring meeting has its own key', () => {
  const monday = event('weekly', 0);
  const nextWeek = { ...monday, start: new Date(now + 7 * 86_400_000).toISOString() };
  assert.notEqual(eventKey(monday), eventKey(nextWeek));
  assert.equal(dueReminders([monday], now, new Set([eventKey(nextWeek)])).length, 1);
});

test('a reminder click records and joins, unless the meeting is already over', () => {
  const call = event('a', 60_000, 30, { notes: 'https://meet.google.com/abc-defg-hij' });
  assert.deepEqual(reminderAction(call, now, true), {
    record: true,
    join: { service: 'meet', url: 'https://meet.google.com/abc-defg-hij' },
  });
  assert.equal(reminderAction(call, now, false).record, false);
  assert.equal(reminderAction(event('b', 0), now, true).join, null);
  // Clicked in Notification Center an hour later: open the note only.
  assert.deepEqual(reminderAction(call, now + 3_600_000, true), { record: false, join: null });
});

test('an occurrence’s note starts from its title, attendees and calendar notes', () => {
  const standup = event('standup', 0, 15, { participants: 'Alex, Sam', notes: 'Agenda' });
  assert.deepEqual(eventNote(standup), {
    title: 'standup',
    participants: 'Alex, Sam',
    notes: 'Meeting context\nAgenda',
    eventKey: eventKey(standup),
  });
  assert.deepEqual(eventNote({ id: 'x', start: 'y' }), {
    title: '',
    participants: '',
    notes: '',
    eventKey: 'x@y',
  });
});

test('an existing, non-trashed note is reused for the same occurrence', () => {
  const key = eventKey(event('a', 0));
  const meetings = [
    { id: 'old', eventKey: key, deletedAt: '2026-10-20T00:00:00Z' },
    { id: 'live', eventKey: key, deletedAt: null },
  ];
  assert.equal(meetingForEvent(meetings, key)?.id, 'live');
  assert.equal(meetingForEvent(meetings, 'other'), undefined);
});
