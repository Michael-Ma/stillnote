import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CalendarFeeds,
  feedUrl,
  mergeCalendars,
  parseFeed,
  recognizeFeed,
} from '../app/calendar-feed.mjs';
import { meetingLink } from '../app/calls.mjs';

const ics = (name) => readFileSync(new URL(`./fixtures/calendar/${name}`, import.meta.url), 'utf8');
const window = { from: new Date('2026-11-02T00:00:00Z'), to: new Date('2026-11-24T00:00:00Z') };
// Test-only reversible adapter. Production uses Electron safeStorage backed by macOS Keychain.
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString(),
};

test('a Google calendar: repeats across the clock change, skips, moves and cancellations', () => {
  const events = parseFeed(ics('google.ics'), { feed: 'f1', ...window });
  assert.deepEqual(
    events.map((e) => [e.title, e.start, e.end]),
    [
      ['Team sync (moved)', '2026-11-02T22:00:00Z', '2026-11-02T22:30:00Z'],
      ['Design review', '2026-11-04T17:00:00Z', '2026-11-04T18:00:00Z'],
      ['Offsite', events[2].start, events[2].end],
      ['Team sync', '2026-11-16T18:00:00Z', '2026-11-16T18:30:00Z'],
      ['Team sync', '2026-11-23T18:00:00Z', '2026-11-23T18:30:00Z'],
    ],
  );
  assert.equal(events[2].allDay, true);
  assert.equal(events[0].allDay, false);
  const review = events[1];
  assert.equal(review.id, 'ics:f1:single@google.test');
  assert.equal(review.participants, 'Ada Lovelace, alan@example.test');
  assert.equal(review.location, 'Room 4');
  assert.equal(review.notes, 'Agenda\nfirst item');
  assert.equal(meetingLink(review).service, 'meet');
  assert.equal(events[3].participants, 'Ada Lovelace');
});

test('an Outlook calendar: its own zone names and Teams links; a zone only named by IANA id', () => {
  const events = parseFeed(ics('outlook.ics'), { feed: 'f2', ...window });
  assert.deepEqual(
    events.map((e) => [e.title, e.start]),
    [
      ['Beijing standup', '2026-11-04T01:00:00Z'],
      ['Customer call', '2026-11-04T17:00:00Z'],
    ],
  );
  assert.equal(meetingLink(events[1]).service, 'teams');
});

test('a long-running daily meeting is expanded quickly, and non-calendars are refused', () => {
  const daily = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:d\nSUMMARY:Daily\nDTSTART:20150101T090000Z\nDTEND:20150101T091500Z\nRRULE:FREQ=DAILY\nEND:VEVENT\nEND:VCALENDAR\n`;
  const started = Date.now();
  assert.equal(
    parseFeed(daily, { from: new Date('2026-11-02'), to: new Date('2026-11-09') }).length,
    7,
  );
  assert.ok(Date.now() - started < 2000);
  assert.throws(() => parseFeed('<html>Sign in</html>', window), /did not return a calendar/);
  assert.throws(() => parseFeed('', window), /did not return a calendar/);
});

test('calendar links: webcal becomes https, others are refused, the clipboard gives only a link', () => {
  assert.equal(
    feedUrl(' webcal://p01-caldav.icloud.com/published/2/abc '),
    'https://p01-caldav.icloud.com/published/2/abc',
  );
  for (const bad of [
    '',
    'not a link',
    'http://example.com/a.ics',
    'file:///etc/passwd',
    'https://localhost/a.ics',
    'https://user:pass@example.com/a.ics',
  ])
    assert.throws(() => feedUrl(bad), /full calendar link/);
  const google =
    'https://calendar.google.com/calendar/ical/me%40example.test/private-abc123/basic.ics';
  assert.deepEqual(recognizeFeed(`copied: ${google} thanks`), {
    kind: 'google',
    url: google,
    host: 'calendar.google.com',
  });
  assert.equal(
    recognizeFeed('https://outlook.office365.com/owa/calendar/abc@x/def/calendar.ics').kind,
    'outlook',
  );
  assert.equal(recognizeFeed('webcal://p01-caldav.icloud.com/published/2/abc').kind, 'icloud');
  assert.equal(recognizeFeed('my password is hunter2'), null);
  assert.equal(recognizeFeed('https://example.com/calendar.ics'), null);
});

test('a meeting in both calendars stays as the Mac’s; the rest merge in time order', () => {
  const mac = [
    { id: 'mac', title: 'Sync', start: '2026-11-04T17:00:00Z', end: '2026-11-04T18:00:00Z' },
  ];
  const feed = [
    { id: 'ics:a', title: 'Sync', start: '2026-11-04T17:00:00.000Z', end: '2026-11-04T18:00:00Z' },
    { id: 'ics:b', title: 'Earlier', start: '2026-11-04T09:00:00Z', end: '2026-11-04T10:00:00Z' },
  ];
  assert.deepEqual(
    mergeCalendars(mac, feed).map((e) => e.id),
    ['ics:b', 'mac'],
  );
});

test('links stay encrypted and out of sight, a bad link is refused, outages keep the last events', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-feeds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const url = 'https://calendar.google.com/calendar/ical/x/private-secret/basic.ics';
  let answer = () => new Response(ics('google.ics'));
  const fetch = async () => answer();
  const make = () =>
    new CalendarFeeds({
      path: join(dir, 'feeds.enc'),
      encryption,
      fetch,
      now: () => new Date('2026-11-02T12:00:00Z'),
    });
  const feeds = make();
  const listed = await feeds.add(url);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['host', 'id', 'problem']);
  assert.equal(listed[0].host, 'calendar.google.com');
  assert.ok(!JSON.stringify(listed).includes('private-secret'));
  await assert.rejects(feeds.add(url), /already added/);
  const reopened = make();
  reopened.load();
  assert.equal(reopened.list().length, 1);

  const events = await feeds.events();
  assert.ok(events.some((e) => e.title === 'Design review'));
  answer = () => new Response('gone', { status: 404 });
  assert.equal((await feeds.events()).length, events.length, 'an outage keeps the last events');
  assert.match(feeds.list()[0].problem, /stopped working \(404\)/);
  answer = () => new Response(ics('google.ics'));
  await feeds.events();
  assert.equal(feeds.list()[0].problem, null);

  answer = () => new Response('<html>Sign in</html>');
  await assert.rejects(
    feeds.add('https://example.com/not-a-calendar'),
    /did not return a calendar/,
  );
  assert.equal(feeds.list().length, 1);
  assert.deepEqual(feeds.remove(listed[0].id), []);
  assert.deepEqual(await feeds.events(), []);
});
