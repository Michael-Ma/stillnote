import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEAD_MS,
  LATE_MS,
  dueReminders,
  eventKey,
  meetingForEvent,
  reminderBody,
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

test('reminder text says when the meeting starts and what a click does', () => {
  assert.equal(
    reminderBody(event('a', 60_000), now, true),
    'Starts in 1 min · Click to take notes and start recording.',
  );
  assert.equal(reminderBody(event('a', 0), now, false), 'Starting now · Click to take notes.');
  assert.match(reminderBody(event('a', -3 * 60_000), now, false), /^Started 3 min ago/);
  assert.match(reminderBody(event('a', 29_000), now, false), /^Starts in 1 min/);
  assert.match(reminderBody(event('a', -30_000), now, false), /^Starting now/);
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
