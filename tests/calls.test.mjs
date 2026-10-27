import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callLink,
  callOnMicrophone,
  callServices,
  callTitle,
  currentEvent,
  meetingDetector,
  meetingLink,
  startableServices,
} from '../app/calls.mjs';
import { translator } from '../app/i18n/index.mjs';

test('Start meeting opens fixed https addresses that the link rules accept', () => {
  assert.deepEqual(startableServices, ['meet', 'zoom']);
  assert.equal(callServices.meet.start, 'https://meet.google.com/new');
  assert.equal(callServices.zoom.start, 'https://zoom.us/start/videomeeting');
  for (const service of startableServices)
    assert.equal(new URL(callServices[service].start).protocol, 'https:');
});

test('Google Meet, Zoom and Teams links are found in an event’s URL, location or notes', () => {
  assert.deepEqual(
    meetingLink({ notes: 'Join with Google Meet: https://meet.google.com/abc-defg-hij\nOr dial…' }),
    { service: 'meet', url: 'https://meet.google.com/abc-defg-hij' },
  );
  assert.deepEqual(meetingLink({ location: 'https://us02web.zoom.us/j/81234567890?pwd=AbC123' }), {
    service: 'zoom',
    url: 'https://us02web.zoom.us/j/81234567890?pwd=AbC123',
  });
  const teams =
    'https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjA%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d';
  assert.deepEqual(meetingLink({ notes: `Microsoft Teams meeting\nJoin: <${teams}>` }), {
    service: 'teams',
    url: teams,
  });
  assert.equal(
    meetingLink({ notes: 'Meeting ID: https://teams.microsoft.com/meet/2345678?p=abc' })?.service,
    'teams',
  );
  assert.equal(
    meetingLink({ location: 'https://company.zoom.us/my/alex.' })?.url,
    'https://company.zoom.us/my/alex',
  );
  assert.equal(meetingLink({ url: 'https://zoomgov.com/j/1601234567' })?.service, 'zoom');
});

test('the URL field wins, then location, then notes; non-meeting links are skipped', () => {
  const event = {
    url: 'https://calendar.google.com/event?eid=abc',
    location: 'Room 4 · https://zoom.us/j/111',
    notes: 'https://meet.google.com/abc-defg-hij',
  };
  assert.equal(meetingLink(event).url, 'https://zoom.us/j/111');
  assert.equal(
    meetingLink({ ...event, url: 'https://meet.google.com/xyz-abcd-efg' }).service,
    'meet',
  );
  assert.equal(
    meetingLink({ notes: 'See https://example.com/docs, then https://zoom.us/j/222).' }).url,
    'https://zoom.us/j/222',
  );
});

test('HTML calendar notes and trailing punctuation do not leak into the link', () => {
  assert.equal(
    meetingLink({ notes: '<a href="https://zoom.us/j/333?pwd=x&amp;uname=y">Join</a>' }).url,
    'https://zoom.us/j/333?pwd=x&uname=y',
  );
  assert.equal(
    meetingLink({ notes: 'Join: https://meet.google.com/abc-defg-hij.' }).url,
    'https://meet.google.com/abc-defg-hij',
  );
});

test('only plain https links on the services’ own hosts are opened', () => {
  for (const value of [
    'http://meet.google.com/abc-defg-hij',
    'https://meet.google.com.example.com/abc-defg-hij',
    'https://evilzoom.us/j/123',
    'https://zoom.us.example.com/j/123',
    'https://user:pass@zoom.us/j/123',
    'https://zoom.us:8443/j/123',
    'https://meet.google.com/new',
    'https://meet.google.com/',
    'https://zoom.us/pricing',
    'https://teams.microsoft.com/v2/',
    'javascript:alert(1)',
    'zoommtg://zoom.us/join?confno=123',
    `https://zoom.us/j/${'1'.repeat(3000)}`,
    42,
  ])
    assert.equal(callLink(value), null, String(value).slice(0, 80));
  assert.equal(meetingLink(null), null);
  assert.equal(meetingLink({ notes: 'No call today.' }), null);
});

test('call notes are named after the service and the time, in the interface language', () => {
  const at = new Date(2026, 9, 25, 14, 5);
  assert.equal(callTitle('meet', at), 'Google Meet · 2:05 PM');
  assert.equal(callTitle('zoom', at), 'Zoom · 2:05 PM');
  assert.equal(callTitle(null, at), 'Meeting · 2:05 PM');
  const zh = translator('zh-Hans');
  assert.equal(callTitle('meet', at, zh), 'Google Meet 会议 · 14:05');
  assert.equal(callTitle(undefined, at, zh), '会议 · 14:05');
});

test('a detected call goes into the calendar meeting under way or about to start', () => {
  const now = Date.parse('2026-10-25T10:00:00Z');
  const event = (id, startMinutes, minutes = 30, extra = {}) => ({
    id,
    start: new Date(now + startMinutes * 60_000).toISOString(),
    end: new Date(now + (startMinutes + minutes) * 60_000).toISOString(),
    participants: 'Priya, Sam',
    ...extra,
  });
  assert.equal(currentEvent([event('ended', -40), event('later', 20)], now), null);
  assert.equal(currentEvent([event('running', -10), event('soon', 3)], now).id, 'soon');
  assert.equal(currentEvent([event('running', -10), event('soon', 12)], now).id, 'running');
  assert.equal(currentEvent([event('day', -600, 1440, { allDay: true })], now), null);
  assert.equal(currentEvent(null, now), null);
  // A long block with no call link and no attendees is not a meeting a call belongs to.
  const focus = event('focus', -120, 480, { participants: '' });
  assert.equal(currentEvent([focus], now), null);
  assert.equal(
    currentEvent([{ ...focus, notes: 'https://meet.google.com/abc-defg-hij' }], now).id,
    'focus',
  );
});

test('a call is on the microphone only when a call app uses it, not another recorder', () => {
  // What the helper reported during a Google Meet call that Stillnote recorded with meeting audio.
  assert.equal(
    callOnMicrophone({
      active: true,
      apps: ['com.apple.replayd', 'com.google.Chrome', 'local.stillnote.app'],
    }),
    true,
  );
  // After hanging up: macOS's capture service (meeting audio) and Granola, helpers included, stay.
  assert.equal(
    callOnMicrophone({
      active: true,
      apps: ['com.apple.replayd', 'com.granola.app.helper', 'COM.GRANOLA.APP'],
    }),
    false,
  );
  assert.equal(callOnMicrophone({ active: true, apps: ['com.granola.appx'] }), true);
  assert.equal(callOnMicrophone({ active: false, apps: [] }), false);
  // macOS 13 names no apps: anything else on the microphone counts.
  assert.equal(callOnMicrophone({ active: true }), true);
  assert.equal(callOnMicrophone({ active: false }), false);
});

test('detection waits for the call to settle and prompts once per session', () => {
  const detector = meetingDetector({ settle: 5000, gap: 60_000 });
  assert.equal(detector.next(0), null);
  detector.observe(true, 1000);
  assert.equal(detector.due(3000, false), false, 'a short use is not a meeting yet');
  assert.equal(detector.next(3000), 3000);
  assert.equal(detector.due(6000, false), true);
  assert.equal(detector.due(7000, false), false, 'never twice');
  assert.equal(detector.next(7000), null);
  // Muting or switching microphones briefly continues the same session.
  detector.observe(false, 10_000);
  detector.observe(true, 40_000);
  assert.equal(detector.due(50_000, false), false);
  // A new call after a real pause prompts again.
  detector.observe(false, 60_000);
  detector.observe(true, 130_000);
  assert.equal(detector.active(), true);
  assert.equal(detector.due(136_000, false), true);
});

test('two short microphone uses a minute apart do not add up to a meeting', () => {
  const detector = meetingDetector({ settle: 5000, gap: 90_000 });
  detector.observe(true, 0);
  detector.observe(false, 3000);
  const first = detector.session();
  detector.observe(true, 60_000);
  assert.equal(detector.due(60_000, false), false, 'settling counts the current stretch');
  assert.equal(detector.next(60_000), 5000);
  assert.equal(detector.session(), first, 'still the same session');
  detector.observe(false, 62_000);
  assert.equal(detector.due(70_000, false), false);
  // A use that does last is still found, and a new session gets a new number.
  detector.observe(true, 200_000);
  assert.ok(detector.session() > first);
  assert.equal(detector.due(205_000, false), true);
});

test('a short microphone use that ends before settling never prompts', () => {
  const detector = meetingDetector({ settle: 5000, gap: 60_000 });
  detector.observe(true, 0);
  detector.observe(false, 2000);
  assert.equal(detector.due(6000, false), false);
  assert.equal(detector.active(), false);
});

test('a session Stillnote records in never prompts, even after the recording stops', () => {
  const detector = meetingDetector({ settle: 5000, gap: 60_000 });
  detector.observe(true, 0);
  assert.equal(detector.due(1000, true), false);
  assert.equal(detector.due(10_000, false), false);
  // The same holds for a call that starts while Stillnote is already recording.
  const later = meetingDetector({ settle: 5000, gap: 60_000 });
  assert.equal(later.due(0, true), false, 'nothing to claim without a session');
  later.observe(true, 1000);
  later.due(1000, true);
  assert.equal(later.due(20_000, false), false);
});
