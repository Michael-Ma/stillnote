import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const meetLink = 'https://meet.google.com/abc-defg-hij';
export const callsScenario = {
  connected: false,
  calendar: [
    {
      id: 'fixture-review',
      title: 'E2E design review',
      participants: 'Priya, Sam',
      startIn: 30_000,
      notes: `Join with Google Meet: ${meetLink}`,
    },
    {
      id: 'fixture-customer',
      title: 'E2E customer call',
      participants: 'Taylor',
      startIn: 2 * 3_600_000,
      location: 'https://us02web.zoom.us/j/81234567890?pwd=fixture',
    },
    { id: 'fixture-focus', title: 'E2E focus time', startIn: 3 * 3_600_000 },
  ],
};

export async function calls(h) {
  const page = await h.launch();
  const main = (fn, arg) => h.desktop.evaluate(fn, arg);
  const opened = () => main(() => globalThis.__stillnoteOpened.slice());
  const detected = () =>
    main(() => globalThis.__stillnoteNotifications.filter((n) => n.kind === 'detected').length);
  // Playwright passes the electron module first, then the argument.
  const microphone = (active) =>
    main((_electron, value) => globalThis.__stillnoteMicrophone?.(value), active);
  const until = async (check, message) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await page.waitForTimeout(100);
    }
    assert.fail(message);
  };
  const stopButton = page.getByRole('button', { name: 'Stop recording', exact: true });
  const title = () =>
    page.getByRole('textbox', { name: 'Meeting title', exact: true }).inputValue();
  const stop = async () => {
    await stopButton.click();
    await page.getByRole('button', { name: 'Start recording', exact: true }).waitFor();
  };
  const home = () => page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  const startCommands = () =>
    readFileSync(join(h.dataDir, 'adapter-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((e) => e.type === 'native-command' && e.op === 'start');

  // The helper watches the microphone from launch, for meeting detection.
  await until(() => microphone(false), 'the helper was never told to watch the microphone');

  // One click opens a new Google Meet and records it, with meeting audio, in a new note.
  await page.getByRole('button', { name: 'Start Google Meet', exact: true }).click();
  await stopButton.waitFor();
  assert.deepEqual(await opened(), ['https://meet.google.com/new']);
  assert.match(await title(), /^Google Meet · \d{1,2}:\d{2}\s?[AP]M$/);
  assert.equal(startCommands().at(-1).systemAudio, true);
  const meet = await h.state();
  assert.equal(meet.recording.id, meet.meetings.find((m) => m.title.startsWith('Google Meet')).id);
  await stop();

  // The chevron offers Zoom; choosing it starts a Zoom meeting and makes Zoom the default.
  await home();
  await page.getByRole('button', { name: 'Choose meeting app', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^Zoom/ }).waitFor();
  await h.screenshot('start-meeting-menu');
  await page.getByRole('menuitemradio', { name: /^Zoom/ }).click();
  await stopButton.waitFor();
  assert.equal((await opened()).at(-1), 'https://zoom.us/start/videomeeting');
  assert.match(await title(), /^Zoom · /);
  await stop();
  await home();
  await page.getByRole('button', { name: 'Start Zoom', exact: true }).waitFor();
  assert.equal((await h.state()).settings.callService, 'zoom');

  // Calendar meetings with a Meet, Zoom or Teams link offer Join & record.
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const row = (text) => page.locator('.upcoming-event').filter({ hasText: text });
  const joinButton = (text) =>
    row(text).getByRole('button', { name: 'Join & record', exact: true });
  await joinButton('E2E design review').waitFor();
  // Join & record starts recording at once, so a meeting hours away offers it only near its start.
  assert.equal(await joinButton('E2E customer call').count(), 0);
  assert.equal(await joinButton('E2E focus time').count(), 0, 'no link, no Join & record');
  assert.match(await row('E2E design review').innerText(), /Google Meet/);
  assert.match(await row('E2E customer call').innerText(), /Zoom/);
  await page.mouse.move(0, 0);
  await h.screenshot('home-calls');

  // Its reminder invites the user to join.
  await until(() => main(() => globalThis.__stillnoteReminders.length === 1), 'no reminder');
  const reminder = await main(() => globalThis.__stillnoteReminders[0].body);
  assert.match(reminder, /^Starts in 1 min · Click to join, take notes and start recording\.$/);

  await joinButton('E2E design review').click();
  await stopButton.waitFor();
  assert.equal((await opened()).at(-1), meetLink);
  assert.equal(await title(), 'E2E design review');
  assert.equal(
    await page.getByRole('textbox', { name: 'Participants', exact: true }).inputValue(),
    'Priya, Sam',
  );
  await stop();

  // Clicking the reminder reopens that note, records again, and joins the call.
  await home();
  const before = (await opened()).length;
  await main(() => globalThis.__stillnoteReminders[0].open());
  await stopButton.waitFor();
  assert.equal(await title(), 'E2E design review');
  await until(async () => (await opened()).length === before + 1, 'the reminder did not join');
  assert.equal((await opened()).at(-1), meetLink);
  await stop();
  const linked = (await h.state()).meetings.filter((m) =>
    m.eventKey?.startsWith('fixture-review@'),
  );
  assert.equal(linked.length, 1);
  assert.equal(linked[0].recordings.length, 2);

  // Another app keeps the microphone busy: Stillnote asks once, by notification and in the app.
  await home();
  await microphone(true);
  const prompt = page.locator('.meeting-prompt');
  await prompt.waitFor();
  assert.match(await prompt.innerText(), /Meeting detected — take notes\?/);
  assert.match(await prompt.innerText(), /E2E design review/);
  assert.equal(await detected(), 1);
  const notification = await main(() => {
    const { title, body } = globalThis.__stillnoteNotifications.find((n) => n.kind === 'detected');
    return { title, body };
  });
  assert.equal(notification.title, 'Meeting detected — take notes?');
  assert.equal(notification.body, 'Click to record “E2E design review” in Stillnote.');
  await h.screenshot('meeting-detected');
  await prompt.getByRole('button', { name: 'Take notes', exact: true }).click();
  await stopButton.waitFor();
  assert.equal(await title(), 'E2E design review');
  assert.equal(await prompt.count(), 0);
  await stop();
  // The call goes on after the recording stops: still the same session, so no second prompt.
  await page.waitForTimeout(700);
  assert.equal(await detected(), 1);
  assert.equal(await prompt.count(), 0);

  // A new call after a pause asks again; clicking the notification records.
  await microphone(false);
  await page.waitForTimeout(1700);
  await microphone(true);
  await until(async () => (await detected()) === 2, 'a new call was not detected');
  await main(() =>
    globalThis.__stillnoteNotifications.findLast((n) => n.kind === 'detected').open(),
  );
  await stopButton.waitFor();
  assert.equal(await title(), 'E2E design review');

  // A call that starts while Stillnote records never asks, during or after the recording.
  await microphone(false);
  await page.waitForTimeout(1700);
  await microphone(true);
  await page.waitForTimeout(700);
  await stop();
  await page.waitForTimeout(700);
  assert.equal(await detected(), 2);

  // Detection can be turned off; the helper then stops watching.
  await microphone(false);
  await home();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Recording', exact: true }).click();
  // The calendar connected on Home: reminders say they are on, not how to connect.
  await page
    .getByText('Notify me a minute before calendar meetings while Stillnote is open.')
    .waitFor();
  const toggle = page.getByRole('switch', { name: 'Detect meetings', exact: true });
  assert.equal(await toggle.isChecked(), true, 'on by default');
  await toggle.scrollIntoViewIfNeeded();
  await h.screenshot('settings-detection');
  // The switch follows the saved setting, so it flips once the main process has stored it.
  await toggle.click();
  await until(async () => !(await toggle.isChecked()), 'the switch did not turn off');
  assert.equal((await h.state()).settings.meetingDetection, false);
  // Noticing that a meeting ended still watches the microphone, until it is off too.
  assert.equal(await microphone(false), true);
  await page.getByLabel('When a meeting seems over', { exact: true }).selectOption('off');
  await until(async () => (await microphone(true)) === false, 'the helper kept watching');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  assert.equal(await detected(), 2);

  // The same screens in 简体中文.
  await h.call('setting', 'meetingDetection', true);
  await h.call('setting', 'meetingEnd', 'auto');
  await h.call('setting', 'uiLanguage', 'zh-Hans');
  await page.reload();
  await page.getByRole('button', { name: '发起 Zoom', exact: true }).waitFor();
  await row('E2E design review').getByRole('button', { name: '加入并录音', exact: true }).waitFor();
  await page.mouse.move(0, 0);
  await h.screenshot('home-calls-zh');
  await page.getByRole('button', { name: '选择会议应用', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^Google Meet/ }).waitFor();
  await h.screenshot('start-meeting-menu-zh');
  await page.keyboard.press('Escape');
  await until(() => microphone(false), 'detection did not resume');
  await page.waitForTimeout(1700);
  await microphone(true);
  await page.locator('.meeting-prompt').waitFor();
  assert.match(await page.locator('.meeting-prompt').innerText(), /检测到会议，要记笔记吗？/);
  assert.equal(
    await main(() => globalThis.__stillnoteNotifications.at(-1).title),
    '检测到会议，要记笔记吗？',
  );
  await h.screenshot('meeting-detected-zh');
  await page.getByRole('button', { name: '忽略', exact: true }).click();
  await microphone(false);
  await h.call('setting', 'uiLanguage', 'en');
  await page.reload();
  await page.getByRole('button', { name: 'New note', exact: true }).waitFor();
  h.assertNoRendererErrors();
}
