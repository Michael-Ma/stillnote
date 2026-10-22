import assert from 'node:assert/strict';

export const remindersScenario = {
  connected: false,
  calendar: [
    { id: 'fixture-standup', title: 'E2E standup', participants: 'Alex, Sam', startIn: 30_000 },
    { id: 'fixture-holiday', title: 'E2E holiday', startIn: 0, minutes: 24 * 60, allDay: true },
    { id: 'fixture-later', title: 'E2E later today', startIn: 3 * 3_600_000 },
  ],
};

const announced = (h) =>
  h.desktop.evaluate(() => globalThis.__stillnoteReminders.map((r) => r.event.title));

export async function reminders(h) {
  const page = await h.launch();
  // Connecting the calendar once enables background refresh and reminders.
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByText('E2E standup', { exact: true }).waitFor();
  assert.equal((await h.state()).settings.calendarConnected, true);

  await h.page.waitForTimeout(1000);
  assert.deepEqual(await announced(h), ['E2E standup'], 'only the starting, timed meeting is due');
  const body = await h.desktop.evaluate(() => globalThis.__stillnoteReminders[0].body);
  assert.match(body, /^Starts in 1 min · Click to take notes and start recording\.$/);

  // Clicking the reminder opens a note for that occurrence and starts recording.
  await h.desktop.evaluate(() => globalThis.__stillnoteReminders[0].open());
  await page.getByRole('button', { name: 'Stop recording', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'Meeting title', exact: true }).inputValue(),
    'E2E standup',
  );
  assert.equal(
    await page.getByRole('textbox', { name: 'Participants', exact: true }).inputValue(),
    'Alex, Sam',
  );
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await page.getByRole('button', { name: 'Start recording', exact: true }).waitFor();
  const linked = (await h.state()).meetings.filter((m) =>
    m.eventKey?.startsWith('fixture-standup@'),
  );
  assert.equal(linked.length, 1);
  assert.equal(linked[0].recordings.length, 1);

  // The same occurrence is never announced twice, and Coming up reopens its existing note.
  await h.page.waitForTimeout(800);
  assert.deepEqual(await announced(h), ['E2E standup']);
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await page.locator('.upcoming-event').filter({ hasText: 'E2E standup' }).click();
  await page.getByRole('textbox', { name: 'Meeting title', exact: true }).waitFor();
  assert.equal(
    (await h.state()).meetings.filter((m) => m.eventKey?.startsWith('fixture-standup@')).length,
    1,
    'Coming up reuses the reminder note',
  );

  // With auto-record off, a reminder only opens the note.
  await h.call('setting', 'reminderAutoRecord', false);
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await h.desktop.evaluate(() => globalThis.__stillnoteReminders[0].open());
  await page.getByRole('textbox', { name: 'Meeting title', exact: true }).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.getByRole('button', { name: 'Stop recording', exact: true }).count(), 0);
}
