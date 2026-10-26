import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectedPanel,
  meetingEndPanel,
  panelBounds,
  panelSize,
  reminderPanel,
  timeRange,
} from '../app/panel.mjs';
import { translator } from '../app/i18n/index.mjs';

const now = Date.parse('2026-10-26T18:29:00Z');
const event = (extra = {}) => ({
  id: 'sync',
  title: 'Xincheng Ma and Sam Goode',
  start: '2026-10-26T18:30:00Z',
  end: '2026-10-26T19:00:00Z',
  color: '#1BADF8',
  ...extra,
});
const ids = (panel) => [panel.primary.id, ...panel.menu.map((item) => item.id)];

test('a reminder with a call link joins and takes notes in one click', () => {
  const panel = reminderPanel(event({ notes: 'https://meet.google.com/abc-defg-hij' }), { now });
  assert.equal(panel.kind, 'reminder');
  assert.equal(panel.key, 'sync@2026-10-26T18:30:00Z');
  assert.equal(panel.title, 'Xincheng Ma and Sam Goode');
  assert.equal(panel.detail, timeRange(event(), 'en'));
  assert.equal(panel.color, '#1badf8', 'the calendar’s own color');
  assert.deepEqual(panel.primary, { id: 'join', label: 'Join and take notes' });
  assert.deepEqual(ids(panel), ['join', 'notes', 'dismiss']);
  assert.equal(panel.menu[0].label, 'Take notes without joining');
  // It stays until a minute after the start, and at least half a minute.
  assert.equal(panel.expires, Date.parse(event().start) + 60_000);
  assert.equal(
    reminderPanel(event(), { now: now + 5 * 60_000 }).expires,
    now + 5 * 60_000 + 30_000,
  );
});

test('without a call link the menu can start a Google Meet or Zoom call with the notes', () => {
  const panel = reminderPanel(event({ color: 'blue' }), { now });
  assert.deepEqual(panel.primary, { id: 'notes', label: 'Take notes' });
  assert.deepEqual(ids(panel), ['notes', 'start-meet', 'start-zoom', 'dismiss']);
  assert.deepEqual(
    panel.menu.slice(0, 2).map((item) => item.label),
    ['Start Google Meet and take notes', 'Start Zoom and take notes'],
  );
  assert.equal(panel.color, null, 'anything but #rrggbb falls back to the default');
});

test('during another recording, the reminder says that note is saved first', () => {
  const panel = reminderPanel(event(), { now, recording: 'Weekly sync' });
  assert.match(panel.detail, / · Saves “Weekly sync” first$/);
});

test('reminders, detection and meeting end read in Chinese', () => {
  const t = translator('zh-Hans');
  const reminder = reminderPanel(event({ location: 'https://zoom.us/j/123' }), { now, t });
  assert.equal(reminder.primary.label, '加入并记笔记');
  assert.equal(reminder.more, '更多选项');
  const detected = detectedPanel(event(), { now, t });
  assert.match(detected.detail, /^检测到会议 · /);
  const ended = meetingEndPanel('call', { deadline: now + 60_000, t });
  assert.equal(ended.title, '会议好像结束了');
  assert.equal(ended.countdown, '{n} 秒后停止录音');
});

test('a detected call offers to take notes, named after the calendar meeting if there is one', () => {
  const panel = detectedPanel(event(), { now });
  assert.equal(panel.title, 'Xincheng Ma and Sam Goode');
  assert.match(panel.detail, /^Meeting detected · /);
  assert.deepEqual(ids(panel), ['notes', 'dismiss']);
  assert.equal(panel.expires, now + 60_000);
  const bare = detectedPanel(null, { now });
  assert.equal(bare.title, 'Meeting detected');
  assert.equal(bare.detail, 'Another app is using your microphone.');
  assert.equal(bare.key, null);
});

test('the meeting-end panel keeps recording or stops, counting down only when automatic', () => {
  const auto = meetingEndPanel('calendar', { deadline: now + 60_000 });
  assert.equal(auto.detail, 'The calendar meeting has ended and no one is speaking.');
  assert.deepEqual(ids(auto), ['keep', 'stop']);
  assert.equal(auto.deadline, now + 60_000);
  assert.equal(auto.countdown, 'Stopping in {n} s');
  assert.equal(auto.expires, undefined, 'it never goes by itself');
  const ask = meetingEndPanel('quiet', {});
  assert.equal(ask.deadline, undefined);
  assert.equal(ask.detail, 'No one has spoken for a while.');
});

test('the panel sits at the top right of the display’s work area', () => {
  const bounds = panelBounds({ x: 0, y: 25, width: 1512, height: 920 });
  assert.deepEqual(bounds, {
    x: 1512 - panelSize.width - 4,
    y: 27,
    width: panelSize.width,
    height: panelSize.height,
  });
  // A second display to the left of the main one.
  assert.equal(panelBounds({ x: -1920, y: 0, width: 1920, height: 1050 }).x, -panelSize.width - 4);
});
