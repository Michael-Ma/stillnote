import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const captureScenario = {
  sessions: [
    { mode: 'normal' },
    { mode: 'partial' },
    { mode: 'empty', duration: 35 },
    { mode: 'recognition-error' },
    { mode: 'start-error' },
    { mode: 'normal', text: 'A second session appends without overwriting the first.' },
    { mode: 'system-unavailable', declined: true },
    { mode: 'normal', startOffsets: { microphone: 0.6, system: 1 } },
    {
      mode: 'script',
      script: [
        {
          source: 'microphone',
          at: 0,
          afterMs: 300,
          candidates: {
            'zh-CN': { text: '今天开会讨论招聘。', confidence: 0.95 },
            'en-US': { text: 'Jin tian kai hui tao lun.', confidence: 0.2 },
          },
        },
        {
          source: 'system',
          at: 2.5,
          afterMs: 600,
          candidates: {
            'zh-CN': { text: 'Sank you see you.', confidence: 0.4 },
            'en-US': { text: 'Thank you, see you Friday.', confidence: 0.96 },
          },
        },
      ],
    },
  ],
};

async function start(h) {
  await h.page.getByRole('button', { name: 'Start recording', exact: true }).click();
  await h.waitForState((s) => !!s.recording && !s.starting);
  await h.page.getByRole('button', { name: 'Stop recording', exact: true }).waitFor();
}

async function stop(h, id, expected) {
  await h.page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  const state = await h.waitForState(
    (s, { id, expected }) =>
      !s.recording &&
      (s.meetings.find((m) => m.id === id)?.recordings?.filter((r) => r.tracks?.length).length ??
        0) === expected,
    { id, expected },
  );
  return state.meetings.find((m) => m.id === id);
}

async function playback(h, expectedSessions = 1) {
  const page = h.page;
  await h.sheet('Recordings');
  assert.equal(await page.locator('.saved-recording').count(), expectedSessions);
  const audio = page.locator('audio[aria-label="Microphone recording"]').first();
  await audio.waitFor({ state: 'attached' });
  await page.waitForFunction(() => {
    const element = document.querySelector('audio[aria-label="Microphone recording"]');
    return element?.readyState >= 1 || element?.error;
  });
  await audio.evaluate(async (element) => {
    if (element.error) throw new Error('Audio metadata failed: ' + element.error.message);
    if (!Number.isFinite(element.duration) || element.duration <= 0)
      throw new Error('No playable audio duration');
    // Mute synthetic tones: verify decoding and the playback clock without noise.
    element.muted = true;
    await element.play();
  });
  await page.waitForFunction(
    () => document.querySelector('audio[aria-label="Microphone recording"]')?.currentTime > 0.05,
  );
  await audio.evaluate((element) => element.pause());
  const system = page.locator('audio[aria-label="Meeting audio recording"]').first();
  await system.waitFor({ state: 'attached' });
  await page.waitForFunction(
    () => document.querySelector('audio[aria-label="Meeting audio recording"]')?.readyState >= 1,
  );
  assert.equal(await page.locator('.audio-track-error').count(), 0);
}

function verifyWaveArtifacts(h, meeting) {
  const events = readFileSync(join(h.dataDir, 'adapter-events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const recording of meeting.recordings.filter((r) => r.tracks?.length)) {
    const command = events.find(
      (event) =>
        event.type === 'native-command' &&
        event.op === 'start' &&
        event.recordingId === recording.id,
    );
    assert.ok(command, 'Persisted recording must match the native capture session');
    for (const track of recording.tracks) {
      const bytes = readFileSync(join(command.audioDir, track.fileName));
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
      assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
      assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
      assert.ok(bytes.length > 44, 'Raw audio must contain samples');
      assert.equal(bytes.length, track.bytes);
    }
  }
}

export async function capture(h) {
  await h.launch();
  await h.call('setting', 'autoEnhance', false);
  await h.call('setting', 'systemAudio', true);
  const first = await h.create(
    'E2E capture and restart',
    'Rough notes stay separate from recognition.',
  );
  await start(h);
  // Closing the window mid-recording stops it, saves the audio, then quits.
  await h.exitDuring(() =>
    h.desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()),
  );
  await h.launch();
  let saved = (await h.state()).meetings.find((m) => m.id === first.id);
  assert.equal(saved.recordings[0].status, 'completed', 'Closing must save the active capture');
  await h.open(first.title);
  assert.deepEqual(
    saved.transcript.map((s) => s.text),
    [
      'Alex will ship the revised onboarding flow on Friday.',
      'Sam confirms the acceptance criteria.',
    ],
  );
  assert.equal(saved.recordings[0].tracks.length, 2);
  verifyWaveArtifacts(h, saved);
  const mediaResult = await h.call('recording-url', first.id, saved.recordings[0].id, 'microphone');
  const mediaUrl = typeof mediaResult === 'string' ? mediaResult : mediaResult.url;
  const range = await h.desktop.evaluate(async ({ net }, url) => {
    const response = await net.fetch(url, { headers: { Range: 'bytes=0-43' } });
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      length: bytes.length,
      magic: bytes.toString('ascii', 0, 4),
      range: response.headers.get('content-range'),
    };
  }, mediaUrl);
  assert.equal(range.status, 206, 'The media protocol must support byte ranges');
  assert.equal(range.length, 44);
  assert.equal(range.magic, 'RIFF');
  assert.match(range.range, /^bytes 0-43\/\d+$/);
  await playback(h);
  await h.screenshot('saved-audio');
  const backupPath = join(h.output, 'recording-notebook.json');
  await h.saveDialog(backupPath);
  await h.page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await h.page.getByRole('button', { name: 'Settings', exact: true }).click();
  await h.page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await h.page.getByRole('button', { name: 'Back up notebook', exact: true }).click();
  await h.page.getByRole('status').filter({ hasText: 'Backup saved' }).waitFor();
  const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
  assert.equal(backup.audioIncluded, false, 'JSON backup must disclose that raw audio is excluded');
  assert.ok(!JSON.stringify(backup).includes(h.dataDir), 'Backup must not grant local audio paths');
  const snapshot = JSON.stringify(saved.recordings);
  await h.restart();
  await h.open(first.title);
  saved = (await h.state()).meetings.find((m) => m.id === first.id);
  assert.equal(JSON.stringify(saved.recordings), snapshot, 'Audio metadata must survive restart');
  assert.equal(saved.transcript.length, 2);
  await playback(h);
  await h.screenshot('playback-after-restart');
  await h.desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1024, 768),
  );
  await h.page.getByRole('button', { name: /^Chat with this meeting/ }).click();
  await h.screenshot('recordings-compact-chat');
  assert.equal(
    await h.page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await h.page.getByRole('button', { name: 'Close chat', exact: true }).click();
  await h.desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 940),
  );

  const partial = await h.create('E2E partial recognition');
  await start(h);
  await h.sheet('Transcript');
  await h.page
    .getByText('A partially recognized sentence survives stop.', { exact: true })
    .waitFor();
  const partialSaved = await stop(h, partial.id, 1);
  assert.deepEqual(
    partialSaved.transcript.map((s) => s.text),
    ['A partially recognized sentence survives stop.'],
    'Latest partial is persisted once at stop',
  );
  verifyWaveArtifacts(h, partialSaved);

  const empty = await h.create('E2E empty recognition');
  await start(h);
  const emptySaved = await stop(h, empty.id, 1);
  assert.equal(emptySaved.transcript.length, 0);
  assert.equal(
    emptySaved.recordings[0].tracks.length,
    2,
    'Recognition silence must not discard raw audio',
  );
  await h.page.getByText('Review transcript coverage', { exact: true }).waitFor();
  await h.sheet('Recordings');
  await h.page
    .locator('.saved-recording')
    .getByRole('button', { name: 'Retry transcription', exact: true })
    .click();
  const recovered = await h.waitForState(
    (s, id) =>
      s.meetings
        .find((m) => m.id === id)
        .transcript.some((x) => x.text.includes('Recovered complete')),
    empty.id,
  );
  assert.equal(
    recovered.meetings.find((m) => m.id === empty.id).recordings.length,
    1,
    'Retranscription reuses the saved session',
  );

  const failed = await h.create('E2E failed recognition');
  await start(h);
  await h.page
    .getByRole('alert')
    .filter({ hasText: 'Fixture speech recognition unavailable' })
    .waitFor();
  const failedSaved = await stop(h, failed.id, 1);
  assert.equal(failedSaved.transcript.length, 0);
  verifyWaveArtifacts(h, failedSaved);
  await h.page.getByRole('button', { name: 'Start recording', exact: true }).click();
  await h.page
    .getByRole('alert')
    .filter({ hasText: 'Fixture microphone permission denied' })
    .waitFor();
  await h.waitForState((s) => !s.recording && !s.starting);
  await h.page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await h.open(first.title);
  await start(h);
  const multiple = await stop(h, first.id, 2);
  assert.equal(multiple.transcript.length, 4);
  assert.equal(
    multiple.transcript[0].text,
    'Alex will ship the revised onboarding flow on Friday.',
  );
  assert.equal(
    multiple.transcript[2].text,
    'A second session appends without overwriting the first.',
  );
  assert.ok(multiple.transcript[2].timestamp >= 2, 'A resumed session starts after prior audio');
  assert.ok(multiple.duration >= 4);
  assert.equal(new Set(multiple.recordings.map((r) => r.id)).size, multiple.recordings.length);
  verifyWaveArtifacts(h, multiple);
  await playback(h, 2);
  const microphoneOnly = await h.create('E2E unavailable system audio');
  await start(h);
  assert.equal((await h.state()).recording.systemAudio, false);
  // A permission denial says what to change and links to the right Settings pane.
  const denied = h.page.getByRole('alert').filter({ hasText: 'microphone is still recording' });
  await denied.waitFor();
  // The test adapter records links instead of opening them.
  await denied.getByRole('button', { name: 'Open Settings', exact: true }).click();
  assert.deepEqual(await h.desktop.evaluate(() => globalThis.__stillnoteOpened), [
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  ]);
  const microphoneSaved = await stop(h, microphoneOnly.id, 1);
  assert.deepEqual(
    microphoneSaved.recordings[0].tracks.map((track) => track.source),
    ['microphone'],
  );
  verifyWaveArtifacts(h, microphoneSaved);
  await h.sheet('Recordings');
  await h.page.locator('audio[aria-label="Microphone recording"]').waitFor({ state: 'attached' });
  assert.equal(await h.page.locator('audio[aria-label="Meeting audio recording"]').count(), 0);

  // Every source starts after 0:00, as on real hardware; Play from the start must still play.
  const offset = await h.create('E2E offset playback');
  await start(h);
  const offsetSaved = await stop(h, offset.id, 1);
  assert.deepEqual(
    offsetSaved.recordings[0].tracks.map((track) => track.startOffset),
    [0.6, 1],
  );
  await h.sheet('Recordings');
  await h.page.waitForFunction(
    () =>
      document.querySelectorAll('audio').length === 2 &&
      [...document.querySelectorAll('audio')].every((a) => a.readyState >= 1),
  );
  await h.page.evaluate(() => document.querySelectorAll('audio').forEach((a) => (a.muted = true)));
  await h.page.getByRole('button', { name: 'Play recording', exact: true }).click();
  await h.page.waitForFunction(
    () => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0.05),
    null,
    { timeout: 4000 },
  );
  await h.page.getByRole('button', { name: 'Pause recording', exact: true }).click();

  // Auto language: each sentence is kept in the language that transcribed it convincingly; the
  // other language's version never reaches the transcript. The candidates are the defaults.
  // A setting changed behind the interface's back needs a reload for the interface to see it.
  await h.call('setting', 'locale', 'auto');
  await h.page.reload();
  await h.page.getByRole('button', { name: 'New note', exact: true }).waitFor();
  const auto = await h.create('E2E auto language');
  await start(h);
  await h.waitForState(
    (s, id) => s.meetings.find((m) => m.id === id).transcript.length === 2,
    auto.id,
  );
  const autoSaved = await stop(h, auto.id, 1);
  assert.deepEqual(
    autoSaved.transcript.map((segment) => [segment.locale, segment.text]),
    [
      ['zh-CN', '今天开会讨论招聘。'],
      ['en-US', 'Thank you, see you Friday.'],
    ],
  );
  assert.equal(autoSaved.recordings[0].locale, 'auto');
  await h.sheet('Recordings');
  await h.page.getByText('Auto (Chinese + English)', { exact: false }).first().waitFor();
  assert.equal(
    await h.page
      .locator('.saved-recording')
      .first()
      .getByRole('button', { name: 'Retry transcription', exact: true })
      .getAttribute('title'),
    null,
    'Retry in the same Auto languages needs no language note',
  );
  await h.call('setting', 'locale', 'en-US');
  h.assertNoRendererErrors();
}
