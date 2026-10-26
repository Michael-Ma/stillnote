import assert from 'node:assert/strict';

// Each recording has 20 s of sound and 80 s of silence; the call ends within a second.
const session = { mode: 'normal', duration: 100, silentAfter: 20 };
export const meetingEndScenario = {
  connected: false,
  meetingEnd: { held: 300, callQuiet: 400, countdown: 2500 },
  sessions: [session, session, session, session],
};

export async function meetingEnd(h) {
  const page = await h.launch();
  const main = (fn, arg) => h.desktop.evaluate(fn, arg);
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
  const startButton = page.getByRole('button', { name: 'Start recording', exact: true });
  const prompt = page.locator('.meeting-prompt');
  const recordings = async () =>
    (await h.state()).meetings.find((m) => m.title === 'Weekly sync')?.recordings ?? [];
  await until(() => microphone(false), 'the helper was never told to watch the microphone');

  // A call is under way: take notes from the prompt, then the call app lets go of the microphone.
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await page.getByRole('textbox', { name: 'Meeting title', exact: true }).fill('Weekly sync');
  await microphone(true);
  await startButton.click();
  await stopButton.waitFor();
  await page.waitForTimeout(500);
  await microphone(false);
  await page.getByText(/^The meeting seems to be over\. Stopping in \d+ s$/).waitFor();
  assert.match(await prompt.innerText(), /The call has ended and no one is speaking\./);
  await h.screenshot('meeting-end-prompt');

  // Away from Stillnote (it is not in front), the floating panel says so too, counting down.
  const panel = await h.panel();
  assert.equal(
    await panel.locator('.panel-words strong').innerText(),
    'The meeting seems to be over',
  );
  assert.match(
    await panel.locator('.panel-words small').innerText(),
    /^Stopping in \d+ s · The call has ended and no one is speaking\.$/,
  );
  await h.panelScreenshot('meeting-end-panel');

  // Keep recording in the panel: both prompts go and the recording carries on past the countdown.
  await panel.getByRole('button', { name: 'Keep recording', exact: true }).click();
  await until(async () => (await prompt.count()) === 0, 'the prompt stayed');
  assert.equal(await panel.locator('.panel').count(), 0);
  await page.waitForTimeout(3000);
  assert.equal(await stopButton.count(), 1, 'still recording');

  // The call app takes the microphone and lets go again: this time the countdown runs out.
  await microphone(true);
  await page.waitForTimeout(500);
  await microphone(false);
  await prompt.waitFor();
  await startButton.waitFor({ timeout: 10_000 });
  const stopped = page.locator('.notice');
  await stopped
    .getByText('Recording stopped: the meeting seemed to be over.', { exact: false })
    .waitFor();
  assert.match(await stopped.innerText(), /Removed 1:10 of silence at the end\./);
  await h.screenshot('meeting-end-stopped');
  const [first] = await recordings();
  assert.equal(first.duration, 30);
  assert.equal(first.diagnostics.trailingSilenceRemoved, 70);

  // Resume records into the same note; a manual stop trims the silence too.
  await stopped.getByRole('button', { name: 'Resume recording', exact: true }).click();
  await stopButton.waitFor();
  await page.waitForTimeout(300);
  await stopButton.click();
  await startButton.waitFor();
  await page.locator('.notice').getByText('Removed 1:10 of silence at the end.').waitFor();
  assert.deepEqual(
    (await recordings()).map((r) => r.duration),
    [30, 30],
  );

  // Settings: stop after a countdown by default; Only ask keeps recording until told.
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Recording', exact: true }).click();
  const choice = page.getByLabel('When a meeting seems over', { exact: true });
  assert.equal(await choice.inputValue(), 'auto');
  await choice.scrollIntoViewIfNeeded();
  await h.screenshot('settings-meeting-end');
  await choice.selectOption('prompt');
  await until(async () => (await h.state()).settings.meetingEnd === 'prompt', 'not saved');
  await page.keyboard.press('Escape');
  await page.locator('.note-row').filter({ hasText: 'Weekly sync' }).click();
  await microphone(true);
  await startButton.click();
  await stopButton.waitFor();
  await page.waitForTimeout(500);
  await microphone(false);
  await page.getByText('The meeting seems to be over', { exact: true }).waitFor();
  await page.waitForTimeout(3000);
  assert.equal(await stopButton.count(), 1, 'only asked');
  await prompt.getByRole('button', { name: 'Stop now', exact: true }).click();
  await startButton.waitFor();
  assert.equal(await prompt.count(), 0);

  // The prompt in 简体中文.
  await h.call('setting', 'meetingEnd', 'auto');
  await h.call('setting', 'uiLanguage', 'zh-Hans');
  await page.reload();
  await page.locator('.note-row').filter({ hasText: 'Weekly sync' }).click();
  await microphone(true);
  await page.getByRole('button', { name: '开始录音', exact: true }).click();
  await page.getByRole('button', { name: '停止录音', exact: true }).waitFor();
  await page.waitForTimeout(500);
  await microphone(false);
  await page.getByText(/^会议好像结束了，\d+ 秒后停止录音$/).waitFor();
  assert.match(await prompt.innerText(), /通话已结束，也没有人在说话。/);
  await h.screenshot('meeting-end-prompt-zh');
  await prompt.getByRole('button', { name: '现在停止', exact: true }).click();
  await page.getByRole('button', { name: '开始录音', exact: true }).waitFor();
  await h.call('setting', 'uiLanguage', 'en');
  await page.reload();
  await page.getByRole('button', { name: 'New note', exact: true }).waitFor();
  h.assertNoRendererErrors();
}
