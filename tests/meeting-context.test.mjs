import test from 'node:test';
import assert from 'node:assert/strict';
import { readableContext, tidyNotes } from '../app/meeting-context.mjs';
import { eventNote } from '../app/reminders.mjs';
import { translator } from '../app/i18n/index.mjs';

// Shaped like a recruiting tool's Zoom invite (names, links and codes are made up).
const zoomInvite =
  'This is a Zoom meeting. Click this link to join: <a href="https://example.zoom.us/j/81234567890?pwd=AbC.1">https://example.zoom.us/j/81234567890?pwd=AbC.1</a><br />Meeting ID: 81234567890<br />Passcode: 1234567890 (desktop) | 1234567890 (dial-in)<br /><br />To cancel or reschedule, use this link: https://jobs.example.com/meeting/abc/ <p>Hi <span>Alex</span>,</p><p></p><p>You are scheduled for the following interview: </p><p></p><p><span>Mon, Oct 26, 2026</span></p><p>Schedule: </p><ul><li><p>8:00 AM - 8:30 AM (PDT) - Recruiter Screen</p><ul><li><p>Sam Lee (Senior Recruiter, <a target="_blank" href="https://www.linkedin.com/in/example">LinkedIn</a>)</p></li></ul></li></ul><p> Questions? Reply &amp; let me know.</p><p><a href="https://jobs.example.com/consent/xyz">Click here to opt-out</a></p>';

test('an HTML invite becomes the call details, then its own words as lines and bullets', () => {
  assert.equal(
    readableContext(zoomInvite),
    [
      'Zoom: https://example.zoom.us/j/81234567890?pwd=AbC.1',
      'Meeting ID 81234567890 · Passcode 1234567890',
      '',
      'Hi Alex,',
      'You are scheduled for the following interview:',
      'Mon, Oct 26, 2026',
      'Schedule:',
      '- 8:00 AM - 8:30 AM (PDT) - Recruiter Screen',
      '  - Sam Lee (Senior Recruiter, LinkedIn)',
      'Questions? Reply & let me know.',
    ].join('\n'),
  );
  assert.match(
    readableContext(zoomInvite, translator('zh-Hans')),
    /^Zoom: .*\n会议号 81234567890 · 密码 1234567890\n/,
  );
});

test('Google Meet and Teams text invites lose their dial-in instructions', () => {
  const meet =
    'Agenda: pricing, onboarding.\n\nJoin with Google Meet\nhttps://meet.google.com/abc-defg-hij\n\nJoin by phone\n(US) +1 314-555-0100 PIN: 123 456 789#\n\nMore phone numbers: https://tel.meet/abc-defg-hij?pin=1\n\nLearn more about Meet at: https://support.google.com/a/users/answer/9282720';
  assert.equal(
    readableContext(meet),
    'Google Meet: https://meet.google.com/abc-defg-hij\n\nAgenda: pricing, onboarding.',
  );
  const teams =
    'Quarterly review\n________________________________________________________________________________\nMicrosoft Teams meeting\nJoin on your computer, mobile app or room device\nClick here to join the meeting <https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0>\nMeeting ID: 123 456 789 012\nPasscode: aB3cD4\nDownload Teams | Join on the web\nLearn More | Meeting options\n________________________________________________________________________________';
  assert.equal(
    readableContext(teams),
    'Microsoft Teams: https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0\nMeeting ID 123 456 789 012 · Passcode aB3cD4\n\nQuarterly review',
  );
});

test('readable text keeps its words; dates and times are not taken for phone numbers', () => {
  const agenda = 'Agenda\n- 2026-10-26 kickoff\n- 9:30 demo\n\nBring the Q4 numbers.';
  assert.equal(readableContext(agenda), agenda);
  assert.equal(readableContext(''), '');
  assert.equal(readableContext('   \n '), '');
});

test('Tidy rewrites only notes that start with the meeting context, and is stable', () => {
  const raw = `Meeting context\n${zoomInvite}\nMy own line about the role.`;
  const tidied = tidyNotes(raw);
  assert.match(tidied, /^Meeting context\nZoom: https:\/\/example\.zoom\.us\/j\/81234567890/);
  assert.match(tidied, /\nMy own line about the role\.$/, 'what the user typed stays');
  assert.match(
    tidyNotes(
      `Meeting context\n<p>Hi</p><p></p><p>Agenda</p>\n\nFirst thought.\n\nSecond thought.`,
    ),
    /^Meeting context\nHi\nAgenda\n\nFirst thought\.\n\nSecond thought\.$/,
    'the user’s blank lines stay; the invite’s empty paragraphs go',
  );
  assert.equal(tidyNotes(tidied), tidied, 'tidy twice changes nothing');
  assert.equal(tidyNotes('Just my notes <b>bold</b>'), 'Just my notes <b>bold</b>');
});

test('a calendar meeting’s new note starts with the readable context', () => {
  const note = eventNote({ id: 'i', start: 's', title: 'Recruiter screen', notes: zoomInvite });
  assert.match(note.notes, /^Meeting context\nZoom: https:\/\/example\.zoom\.us\/j\/81234567890/);
  assert.ok(!note.notes.includes('<'), 'no HTML left');
  assert.equal(eventNote({ id: 'i', start: 's', notes: 'Join by phone' }).notes, '');
});
