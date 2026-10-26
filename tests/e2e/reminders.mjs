import assert from 'node:assert/strict';

export const remindersScenario = {
  connected: false,
  calendar: [
    { id: 'fixture-standup', title: 'E2E standup', participants: 'Alex, Sam', startIn: 30_000 },
    { id: 'fixture-holiday', title: 'E2E holiday', startIn: 0, minutes: 24 * 60, allDay: true },
    { id: 'fixture-later', title: 'E2E later today', startIn: 3 * 3_600_000 },
    // Comes due a quarter of a minute in, for a second reminder.
    { id: 'fixture-retro', title: 'E2E retro', startIn: 75_000 },
  ],
};

const announced = (h) =>
  h.desktop.evaluate(() => globalThis.__stillnoteReminders.map((r) => r.title));

export async function reminders(h) {
  const page = await h.launch();
  // Connecting the calendar once enables background refresh and reminders.
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByText('E2E standup', { exact: true }).waitFor();
  assert.equal((await h.state()).settings.calendarConnected, true);

  await h.page.waitForTimeout(1000);
  assert.deepEqual(await announced(h), ['E2E standup'], 'only the starting, timed meeting is due');
  // The floating panel: the meeting, its time, and Take notes (no call link) with more choices.
  const panel = await h.panel();
  assert.equal(await panel.locator('.panel-words strong').innerText(), 'E2E standup');
  assert.match(await panel.locator('.panel-words small').innerText(), /^\d{1,2}:\d{2} [AP]M – /);
  await h.panelScreenshot('reminder-panel');

  // Take notes opens a note for that occurrence and starts recording.
  await panel.getByRole('button', { name: 'Take notes', exact: true }).click();
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
  assert.equal((await announced(h)).filter((title) => title === 'E2E standup').length, 1);
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  const standup = page.locator('.upcoming-event').filter({ hasText: 'E2E standup' });
  await standup.getByRole('button', { name: /^E2E standup/ }).click();
  await page.getByRole('textbox', { name: 'Meeting title', exact: true }).waitFor();
  assert.equal(
    (await h.state()).meetings.filter((m) => m.eventKey?.startsWith('fixture-standup@')).length,
    1,
    'Coming up reuses the reminder note',
  );
  await page.waitForTimeout(300);
  assert.equal(
    await page.getByRole('button', { name: 'Stop recording', exact: true }).count(),
    0,
    'the row itself only opens the note',
  );

  // With auto-record off, the next reminder's Take notes only opens its note.
  await h.call('setting', 'reminderAutoRecord', false);
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  for (let i = 0; i < 300 && !(await announced(h)).includes('E2E retro'); i++)
    await page.waitForTimeout(100);
  const retro = await h.panel();
  await retro.getByText('E2E retro', { exact: true }).waitFor();
  await retro.getByRole('button', { name: 'Take notes', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Meeting title"]')?.value === 'E2E retro',
  );
  await page.waitForTimeout(500);
  assert.equal(await page.getByRole('button', { name: 'Stop recording', exact: true }).count(), 0);

  // "Start now" records right away, whatever the reminder setting, in the occurrence's note.
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  assert.equal(
    await page
      .locator('.upcoming-event')
      .filter({ hasText: 'E2E later today' })
      .getByRole('button', { name: 'Start now' })
      .count(),
    0,
    'only a meeting about to start offers Start now',
  );
  await standup.getByRole('button', { name: 'Start now', exact: true }).click();
  await page.getByRole('button', { name: 'Stop recording', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'Meeting title', exact: true }).inputValue(),
    'E2E standup',
  );
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await page.getByRole('button', { name: 'Start recording', exact: true }).waitFor();
  const started = (await h.state()).meetings.filter((m) =>
    m.eventKey?.startsWith('fixture-standup@'),
  );
  assert.equal(started.length, 1);
  assert.equal(started[0].recordings.length, 2);
}
