import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain } from './fixtures/electron.mjs';

const hook = registerHooks({
  resolve(specifier, context, next) {
    return next(
      specifier === 'electron'
        ? new URL('./fixtures/electron.mjs', import.meta.url).href
        : specifier,
      context,
    );
  },
});
test.after(() => hook.deregister());
async function setup(t, name, sessions, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-ipc-'));
  const scenario = join(dir, 'scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({
      ...extra,
      responses: [{ text: 'Enhanced evidence [1]' }, { text: 'Answer [1]' }],
      sessions: sessions ?? [
        {
          mode: 'normal',
          events: [
            { type: 'source-silent', source: 'microphone', device: 'Fixture microphone' },
            { type: 'source-signal', source: 'microphone' },
            {
              type: 'device-changed',
              source: 'microphone',
              device: { uid: 'reconnected-mic', name: 'Reconnected microphone' },
            },
            { type: 'recording-status', sources: { microphone: { status: 'recording' } } },
          ],
        },
      ],
    }),
  );
  const previous = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'test',
    STILLNOTE_DATA_DIR: dir,
    STILLNOTE_TEST_ADAPTER: fileURLToPath(new URL('./e2e/adapter.mjs', import.meta.url)),
    STILLNOTE_E2E_SCENARIO_FILE: scenario,
  });
  app.removeAllListeners();
  ipcMain.handlers.clear();
  const priorWindows = BrowserWindow.instances.length;
  await import(`../app/main.mjs?test=${name}`);
  let win;
  for (let i = 0; i < 100; i++) {
    win = BrowserWindow.instances.at(-1);
    if (BrowserWindow.instances.length > priorWindows && win?.loaded) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(win?.loaded);
  const call = (name, ...args) =>
    ipcMain.handlers.get('stillnote:' + name)(
      { sender: win.webContents, senderFrame: win.webContents.mainFrame },
      ...args,
    );
  t.after(async () => {
    app.emit('before-quit', { preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
    win.destroy();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(dir, { recursive: true, force: true });
  });
  const events = () =>
    readFileSync(join(dir, 'adapter-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { call, win, events, dir };
}
test('main IPC consumes the native contract, bounds chat, and closes after 5 seconds', async (t) => {
  const { call, win, events } = await setup(t, 'ipc');
  await t.test('native discovery and installation return exact IPC shapes', async () => {
    assert.deepEqual(await call('audio-devices'), {
      inputs: [
        { uid: 'fixture-mic', name: 'Fixture microphone', isDefault: true, transport: 'built-in' },
      ],
    });
    assert.deepEqual(await call('languages'), {
      engine: 'speechTranscriber',
      supported: ['en-US', 'zh-CN', 'yue-CN'],
      installed: ['en-US'],
    });
    assert.deepEqual(await call('install-language', 'zh-CN'), {
      engine: 'speechTranscriber',
      supported: ['en-US', 'zh-CN', 'yue-CN'],
      installed: ['en-US', 'zh-CN'],
    });
    assert.ok(
      win.events.some(
        (e) => e.type === 'language-progress' && e.locale === 'zh-CN' && e.fraction === 1,
      ),
    );
  });
  const meeting = await call('create', {
    title: 'Atlas review',
    notes: 'Kubernetes decisions',
    participants: 'Alice, Bob',
  });
  await t.test('capture passes device, echo setting and hints; exposes native state', async () => {
    await call('setting', 'inputDevice', 'chosen-mic');
    await call('setting', 'echoCancellation', 'off');
    await call('setting', 'autoEnhance', false);
    await call('record', meeting.id);
    await new Promise((resolve) => setImmediate(resolve));
    const state = await call('state');
    assert.equal(state.recording.engine, 'speechTranscriber');
    assert.equal(state.recording.echoCancellation, false);
    assert.equal(state.recording.sources.microphone.device.uid, 'reconnected-mic');
    for (const type of ['source-silent', 'source-signal', 'device-changed']) {
      const event = win.events.find((e) => e.type === type);
      assert.ok(event);
      assert.equal(event.recordingId, state.recording.recordingId);
      assert.equal('recording' in event, false, 'protocol event is forwarded unchanged');
    }
    assert.equal(
      state.meetings.find((m) => m.id === meeting.id).recordings[0].sources.microphone.device.uid,
      'reconnected-mic',
    );
    const command = events().find((e) => e.type === 'native-command' && e.op === 'start');
    assert.deepEqual(command.context, ['Atlas', 'review', 'Alice', 'Bob', 'Kubernetes']);
    assert.equal(command.inputDevice, 'chosen-mic');
    assert.equal(command.echoCancellation, 'off');
    await call('stop');
    await new Promise((resolve) => setImmediate(resolve));
    const stopped = await call('state');
    const stored = stopped.meetings.find((m) => m.id === meeting.id);
    assert.equal(stopped.recording, null);
    assert.equal(
      win.events.filter((e) => e.type === 'meeting').at(-1).meeting.transcript.length,
      2,
    );
    await call('transcribe-recording', meeting.id, stored.recordings[0].id);
    assert.deepEqual(events().find((e) => e.op === 'transcribe').context, command.context);
    assert.deepEqual(command.locales, ['en-US']);
    // Auto: the retry transcribes in both languages and keeps the better one per sentence, and
    // the recording's language label follows what the retry used.
    await call('setting', 'autoLocales', ['zh-CN', 'en-US']);
    await call('setting', 'locale', 'auto');
    const auto = await call('transcribe-recording', meeting.id, stored.recordings[0].id);
    assert.deepEqual(
      events()
        .filter((e) => e.op === 'transcribe')
        .at(-1).locales,
      ['zh-CN', 'en-US'],
    );
    const session = auto.recordings.find((r) => r.id === stored.recordings[0].id);
    assert.equal(session.locale, 'auto');
    assert.deepEqual(session.locales, ['zh-CN', 'en-US']);
    assert.deepEqual(
      auto.transcript.filter((s) => s.recordingId === session.id).map((s) => [s.locale, s.text]),
      [['zh-CN', 'Fixture text in zh-CN.']],
    );
    await call('setting', 'locale', 'en-US');
    const fixed = await call('transcribe-recording', meeting.id, stored.recordings[0].id);
    const relabeled = fixed.recordings.find((r) => r.id === session.id);
    assert.equal(relabeled.locale, 'en-US');
    assert.equal('locales' in relabeled, false);
  });
  await t.test('AI enhancement marks summary source and chat returns context counts', async () => {
    const result = await call('ai', { kind: 'enhance', id: meeting.id });
    assert.equal(result.meeting.summarySource, 'ai');
    await call('create', { title: 'Oversized', notes: 'x'.repeat(400000) });
    const chat = await call('ai', { kind: 'chat', scope: 'all', question: 'Atlas' });
    assert.deepEqual(chat.context, { included: 1, total: 2 });
    const request = events()
      .filter((e) => e.type === 'ai-request')
      .at(-1);
    assert.match(request.input[0].content, /1 meetings omitted/);
    assert.equal(chat.message.sources[0].id, meeting.id);
  });
  await t.test('close falls back after 5000 ms when renderer never acknowledges', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    win.close();
    assert.equal(win.isDestroyed(), false);
    assert.equal(win.events.at(-1).type, 'flush-before-close');
    t.mock.timers.tick(4999);
    assert.equal(win.isDestroyed(), false);
    t.mock.timers.tick(1);
    assert.equal(win.isDestroyed(), true);
  });
});
test('renderer process loss closes even during capture and persists interrupted audio', async (t) => {
  const { call, win } = await setup(t, 'renderer-gone');
  const meeting = await call('create', { title: 'Interrupted capture' });
  await call('setting', 'autoEnhance', false);
  await call('record', meeting.id);
  await new Promise((resolve) => setImmediate(resolve));
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(win.isDestroyed(), true);
  const state = await call('state');
  assert.equal(state.recording, null);
  assert.equal(state.meetings[0].recordings[0].status, 'interrupted');
});
test('withdrawn provisional text is not saved, and track offsets are kept while recording', async (t) => {
  const { call } = await setup(t, 'withdrawn', [
    {
      mode: 'normal',
      events: [
        { type: 'partial', segmentId: 'cough', source: 'microphone', speaker: 'You', text: 'Hmm' },
        { type: 'partial-discard', source: 'microphone', locale: 'en-US', segmentIds: ['cough'] },
        { type: 'track-started', source: 'microphone', startOffset: 0.25 },
      ],
    },
  ]);
  const meeting = await call('create', { title: 'Withdrawn' });
  await call('setting', 'autoEnhance', false);
  await call('record', meeting.id);
  const recordingOf = async () => (await call('state')).meetings.find((m) => m.id === meeting.id);
  let during;
  for (let i = 0; i < 100 && !during?.recordings[0]?.tracks?.length; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    during = await recordingOf();
  }
  assert.deepEqual(during.recordings[0].tracks, [{ source: 'microphone', startOffset: 0.25 }]);
  await call('stop');
  let after;
  for (let i = 0; i < 100 && after?.recordings[0]?.status !== 'completed'; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    after = await recordingOf();
  }
  assert.equal(after.recordings[0].status, 'completed');
  assert.ok(after.transcript.length > 0);
  assert.ok(!after.transcript.some((s) => s.text === 'Hmm'), 'the withdrawn text is not saved');
});
test('calls open only fixed or calendar links; reminders join and detection prompts once', async (t) => {
  const { call, win, events } = await setup(t, 'calls', undefined, {
    calendar: [
      {
        id: 'call',
        title: 'Design call',
        startIn: 30_000,
        notes: 'https://meet.google.com/abc-defg-hij',
      },
      { id: 'plain', title: 'Desk time', startIn: 3_600_000 },
    ],
  });
  const opened = () =>
    events()
      .filter((e) => e.type === 'open-external')
      .map((e) => e.url);
  const until = async (check) => {
    for (let i = 0; i < 200 && !check(); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(check());
  };
  await assert.rejects(call('start-call', 'javascript:alert(1)'), /Unknown meeting service/);
  assert.equal((await call('start-call', 'zoom')).callService, 'zoom');
  assert.deepEqual(opened(), ['https://zoom.us/start/videomeeting']);

  const [design, desk] = await call('calendar');
  await assert.rejects(call('join-call', 'unknown@2026-10-25'), /no longer in your calendar/);
  await assert.rejects(call('join-call', `${desk.id}@${desk.start}`), /no Google Meet/);
  assert.equal(await call('join-call', `${design.id}@${design.start}`), 'meet');
  assert.equal(opened().at(-1), 'https://meet.google.com/abc-defg-hij');

  // The reminder invites the user to join; its click opens the note and the call.
  await until(() => globalThis.__stillnoteReminders.length === 1);
  const reminder = globalThis.__stillnoteReminders[0];
  assert.match(reminder.body, /Click to join, take notes and start recording\.$/);
  reminder.open();
  const opening = win.events.findLast((e) => e.type === 'open-meeting');
  assert.equal(opening.record, false); // main owns reminder recording and waits for raw capture
  assert.equal(win.events.findLast((e) => e.type === 'meeting').meeting.title, 'Design call');
  await until(() => opened().length === 3);
  await call('stop');
  await new Promise((resolve) => setImmediate(resolve));

  // Another app keeps the microphone busy: one prompt for the session, matched to the calendar.
  let raised = 0;
  win.show = () => raised++;
  await until(() => globalThis.__stillnoteMicrophone?.(false));
  globalThis.__stillnoteMicrophone(true);
  await until(() => globalThis.__stillnoteNotifications.some((n) => n.kind === 'detected'));
  const detected = globalThis.__stillnoteNotifications.find((n) => n.kind === 'detected');
  assert.equal(detected.title, 'Meeting detected — take notes?');
  assert.equal(detected.body, 'Click to record “Design call” in Stillnote.');
  assert.equal(win.events.findLast((e) => e.type === 'meeting-detected').event.id, 'call');
  assert.equal(raised, 0, 'by default a detected meeting only prompts');
  globalThis.__stillnoteMicrophone(false);
  globalThis.__stillnoteMicrophone(true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(globalThis.__stillnoteNotifications.filter((n) => n.kind === 'detected').length, 1);
  detected.open();
  const notes = (await call('state')).meetings.filter((m) => m.eventKey === `call@${design.start}`);
  assert.equal(notes.length, 1, 'the detected call reuses the occurrence’s note');
  assert.equal(win.events.findLast((e) => e.type === 'open-meeting').id, notes[0].id);

  // Opted in, the next call brings Stillnote forward by itself, onto its prompt.
  await call('setting', 'openOnMeetingDetected', true);
  globalThis.__stillnoteMicrophone(false);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const before = raised;
  globalThis.__stillnoteMicrophone(true);
  await until(
    () => globalThis.__stillnoteNotifications.filter((n) => n.kind === 'detected').length === 2,
  );
  assert.equal(raised, before + 1);

  // Meeting-end detection still watches the microphone; turning both off stops the helper watching.
  await call('setting', 'meetingDetection', false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    !events().some((e) => e.type === 'native-command' && e.op === 'watch-microphone' && !e.enabled),
  );
  await call('setting', 'meetingEnd', 'off');
  await until(() =>
    events().some((e) => e.type === 'native-command' && e.op === 'watch-microphone' && !e.enabled),
  );
});
test('one note per calendar event, and a reminder during a recording switches to the next', async (t) => {
  const { call, win, events } = await setup(t, 'back-to-back', undefined, {
    startDelay: 80,
    stopDelay: 80,
    calendar: [
      {
        id: 'next',
        title: 'Next call',
        startIn: 30_000,
        notes: 'https://meet.google.com/abc-defg-hij',
      },
    ],
  });
  const until = async (check) => {
    for (let i = 0; i < 300 && !(await check()); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(await check());
  };
  // Join clicked twice: both creates land on the same note.
  const once = await call('create', { title: 'Design call', eventKey: 'design@2026-10-25' });
  const twice = await call('create', { title: 'Design call', eventKey: 'design@2026-10-25' });
  assert.equal(twice.id, once.id);

  await call('setting', 'autoEnhance', false);
  const current = await call('create', { title: 'Weekly sync' });
  await call('record', current.id);
  await until(async () => {
    const state = await call('state');
    return state.recording?.id === current.id && !state.starting;
  });
  await call('calendar');
  await until(() => globalThis.__stillnoteReminders.length === 1);
  const [reminder] = globalThis.__stillnoteReminders;
  assert.match(reminder.body, /Click to save “Weekly sync”, then join and record this meeting\.$/);
  reminder.open();
  assert.equal(events().filter((e) => e.type === 'open-external').length, 0);
  assert.equal((await call('state')).recording.id, current.id);
  await until(() => events().some((e) => e.type === 'stopped'));
  assert.equal(
    events().filter((e) => e.type === 'open-external').length,
    0,
    'B must wait for its own raw capture',
  );
  const saved = (await call('state')).meetings.find((m) => m.id === current.id);
  assert.equal(saved.recordings[0].status, 'completed');
  await until(() => events().some((e) => e.type === 'open-external'));
  const next = (await call('state')).meetings.find((m) => m.title === 'Next call');
  assert.equal((await call('state')).recording.id, next.id);
  assert.equal(win.events.findLast((e) => e.type === 'open-meeting').id, next.id);
  const timeline = events();
  const stopped = timeline.findIndex((e) => e.type === 'stopped');
  const secondStart = timeline.findIndex(
    (e, i) => i > stopped && e.type === 'native-command' && e.op === 'start',
  );
  const ready = timeline.findIndex((e, i) => i > secondStart && e.type === 'started');
  const joined = timeline.findIndex((e) => e.type === 'open-external');
  assert.ok(stopped < secondStart && secondStart < ready && ready < joined);
  await call('stop');
  await until(async () => !(await call('state')).recording);
});
test('delete forever moves a trashed note’s audio to the Trash, then deletes the note', async (t) => {
  const { call, events } = await setup(t, 'delete-forever');
  await call('setting', 'autoEnhance', false);
  const note = await call('create', { title: 'Old call' });
  await call('record', note.id);
  const until = async (check) => {
    for (let i = 0; i < 300 && !(await check()); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(await check());
  };
  await until(async () => (await call('state')).recording?.id === note.id);
  await assert.rejects(call('delete-forever', [note.id]), /Trash before deleting/);
  await call('stop');
  await until(async () => (await call('state')).recording === null);
  await call('update', note.id, { deletedAt: true });
  assert.ok((await call('deletion-size', [note.id])) > 0, 'the saved audio is counted');
  assert.deepEqual(await call('delete-forever', [note.id]), [note.id]);
  assert.equal((await call('state')).meetings.length, 0);
  const trashed = events().filter((e) => e.type === 'trash-item');
  assert.equal(trashed.length, 1);
  assert.match(trashed[0].path, new RegExp(`recordings/${note.id}$`));
  await assert.rejects(call('delete-forever', [note.id]), /not found/);
  await assert.rejects(call('delete-forever', []), /Choose notes/);
});

const waitFor = async (check) => {
  for (let i = 0; i < 300 && !(await check()); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(await check());
};
for (const mode of ['hang-ignore-cancel', 'hang-acknowledge']) {
  test(`transcription timeout ${mode} recovers before allowing a new recording`, async (t) => {
    const { call, events } = await setup(t, mode, undefined, { transcribeMode: mode });
    await call('setting', 'autoEnhance', false);
    const note = await call('create', { title: 'Timeout recovery' });
    await call('record', note.id);
    await waitFor(async () => !(await call('state')).starting);
    await call('stop');
    await waitFor(async () => !(await call('state')).recording);
    const before = (await call('state')).meetings.find((m) => m.id === note.id);
    const oldHelper = globalThis.__stillnoteNatives[0];
    const setTimer = globalThis.setTimeout;
    const mock = t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) =>
      setTimer(fn, ms === 90_000 ? 25 : ms === 2000 ? 40 : ms, ...args),
    );
    const pending = call('transcribe-recording', note.id, before.recordings[0].id);
    const rejected = assert.rejects(pending, /timed out.*preserved/);
    await assert.rejects(call('record', note.id), /Wait for transcription/);
    await rejected;
    mock.mock.restore();
    assert.ok(
      events().some(
        (e) => e.op === 'cancel-transcribe' && e.recordingId === before.recordings[0].id,
      ),
    );
    assert.equal(
      events().some((e) => e.type === 'native-killed'),
      mode === 'hang-ignore-cancel',
    );
    assert.deepEqual(
      (await call('state')).meetings.find((m) => m.id === note.id).transcript,
      before.transcript,
    );
    await call('record', note.id);
    await waitFor(async () => !(await call('state')).starting);
    if (mode === 'hang-ignore-cancel') {
      oldHelper.emit({ type: 'error', message: 'Stale error from a retired helper' });
      oldHelper.emit({ type: 'stopped', duration: 999 });
      oldHelper.emit({
        type: 'retranscription-completed',
        recordingId: before.recordings[0].id,
        segments: [{ text: 'late replacement' }],
      });
      assert.ok((await call('state')).recording);
      assert.equal(events().filter((e) => e.type === 'native-created').length, 2);
    }
    await call('stop');
    await waitFor(async () => !(await call('state')).recording);
    assert.ok(
      !(await call('state')).meetings
        .find((m) => m.id === note.id)
        .transcript.some((s) => s.text === 'late replacement'),
    );
  });
}

test('Stop discards an expired Auto partial when periodic ticks have not run', async (t) => {
  const { call, win } = await setup(t, 'stop-expiry', [
    {
      mode: 'silent',
      events: [
        {
          type: 'partial',
          segmentId: 'expired-stop',
          source: 'microphone',
          locale: 'en-US',
          text: 'Obsolete provisional phrase',
          timestamp: 0,
        },
      ],
    },
  ]);
  await call('setting', 'autoEnhance', false);
  await call('setting', 'autoLocales', ['en-US', 'zh-CN']);
  await call('setting', 'locale', 'auto');
  const note = await call('create', { title: 'Expiry at Stop' });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await call('record', note.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(win.events.some((e) => e.type === 'partial' && e.segmentId === 'expired-stop'));
  now += 16_000;
  await call('stop');
  await new Promise((resolve) => setImmediate(resolve));
  const saved = (await call('state')).meetings.find((m) => m.id === note.id);
  assert.deepEqual(saved.transcript, []);
  assert.ok(
    win.events.some((e) => e.type === 'partial-discard' && e.segmentIds.includes('expired-stop')),
  );
});

test('a reminder never opens the call when its new capture fails', async (t) => {
  const { call, events, win } = await setup(t, 'handoff-failure', [{ mode: 'start-error' }], {
    calendar: [
      {
        id: 'fail-next',
        title: 'Unavailable microphone',
        startIn: 30_000,
        notes: 'https://meet.google.com/abc-defg-hij',
      },
    ],
  });
  await call('calendar');
  await waitFor(() => globalThis.__stillnoteReminders.length === 1);
  globalThis.__stillnoteReminders[0].open();
  await waitFor(() => win.events.some((e) => e.type === 'error'));
  assert.ok(!events().some((e) => e.type === 'open-external'));
  assert.equal((await call('state')).recording, null);
});

test('a failed retry preserves old text', async (t) => {
  const { call } = await setup(t, 'retry-failure', undefined, { transcribeMode: 'fail' });
  await call('setting', 'autoEnhance', false);
  const note = await call('create', { title: 'No replacement for one source' });
  await call('record', note.id);
  await waitFor(async () => !(await call('state')).starting);
  await call('stop');
  await waitFor(async () => !(await call('state')).recording);
  const before = (await call('state')).meetings.find((m) => m.id === note.id);
  await assert.rejects(
    call('transcribe-recording', note.id, before.recordings[0].id),
    /No candidate/,
  );
  assert.deepEqual(
    (await call('state')).meetings.find((m) => m.id === note.id).transcript,
    before.transcript,
  );
});

test('successful retry keeps explicit language fallback diagnostics', async (t) => {
  const fallback = { source: 'microphone', locale: 'zh-CN', reason: 'Injected missing language' };
  const { call } = await setup(t, 'retry-fallback', undefined, { transcribeFallbacks: [fallback] });
  await call('setting', 'autoEnhance', false);
  const note = await call('create', { title: 'Fallback metadata' });
  await call('record', note.id);
  await waitFor(async () => !(await call('state')).starting);
  await call('stop');
  await waitFor(async () => !(await call('state')).recording);
  const before = (await call('state')).meetings.find((m) => m.id === note.id);
  const updated = await call('transcribe-recording', note.id, before.recordings[0].id);
  assert.deepEqual(updated.recordings[0].diagnostics.languageFallbacks, [fallback]);
});

test('quitting while A saves cancels the pending B handoff', async (t) => {
  const { call, events } = await setup(t, 'quit-handoff', undefined, {
    stopDelay: 50,
    calendar: [
      {
        id: 'quit-next',
        title: 'Next call',
        startIn: 30_000,
        notes: 'https://meet.google.com/abc-defg-hij',
      },
    ],
  });
  await call('setting', 'autoEnhance', false);
  const note = await call('create', { title: 'Current call' });
  await call('record', note.id);
  await waitFor(async () => !(await call('state')).starting);
  await call('calendar');
  await waitFor(() => globalThis.__stillnoteReminders.length === 1);
  globalThis.__stillnoteReminders[0].open();
  app.emit('before-quit', { preventDefault() {} });
  await waitFor(() => events().some((e) => e.type === 'stopped'));
  assert.equal(events().filter((e) => e.type === 'native-command' && e.op === 'start').length, 1);
  assert.ok(!events().some((e) => e.type === 'open-external'));
});
test('a meeting that seems over asks, keeps recording on request, then stops and trims the silence', async (t) => {
  const session = { mode: 'normal', duration: 100, silentAfter: 20 };
  const { call, win, events } = await setup(t, 'meeting-end', [session, session], {
    meetingEnd: { held: 200, callQuiet: 300, countdown: 500 },
  });
  const until = async (check, tries = 300) => {
    for (let i = 0; i < tries && !check(); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(check());
  };
  const prompts = () => win.events.filter((e) => e.type === 'meeting-end');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await call('setting', 'autoEnhance', false);
  const meeting = await call('create', { title: 'Weekly sync' });
  // The call app is on the microphone when recording starts; Stillnote is in the background.
  win.isFocused = () => false;
  await until(() => globalThis.__stillnoteMicrophone?.(false));
  globalThis.__stillnoteMicrophone(true);
  await call('record', meeting.id);
  await until(() => win.events.some((e) => e.type === 'started'));
  await wait(300);
  globalThis.__stillnoteMicrophone(false);
  await until(() => prompts().length === 1);
  assert.equal(prompts()[0].reason, 'call');
  assert.ok(prompts()[0].deadline > Date.now());
  const notice = globalThis.__stillnoteNotifications.find((n) => n.kind === 'meeting-end');
  assert.equal(notice.title, 'The meeting seems to be over');
  assert.match(notice.body, /Recording stops in 60 seconds/);

  // Keep recording: no stop at the deadline, and no new prompt until the call app is used again.
  assert.equal(await call('keep-recording'), true);
  assert.ok(win.events.some((e) => e.type === 'meeting-end-cleared'));
  await wait(800);
  assert.equal(prompts().length, 1);
  assert.ok((await call('state')).recording, 'still recording');
  globalThis.__stillnoteMicrophone(true);
  await wait(300);
  globalThis.__stillnoteMicrophone(false);
  await until(() => prompts().length === 2);
  // The countdown runs out: the recording stops, and the 80 s of silence after 20 s of sound go.
  await until(() => win.events.some((e) => e.type === 'meeting-end-stopped'));
  const stopped = win.events.find((e) => e.type === 'meeting-end-stopped');
  assert.equal(stopped.reason, 'call');
  assert.equal(stopped.removed, 70);
  let saved = (await call('state')).meetings.find((m) => m.id === meeting.id);
  assert.equal(saved.recordings[0].duration, 30);
  assert.equal(saved.recordings[0].diagnostics.trailingSilenceRemoved, 70);
  assert.deepEqual(
    saved.recordings[0].tracks.map((track) => track.duration),
    [30, 30],
  );

  // Only ask: the prompt has no countdown and waits; a manual stop still trims.
  await call('setting', 'meetingEnd', 'prompt');
  globalThis.__stillnoteMicrophone(true);
  await call('record', meeting.id);
  await until(() => win.events.filter((e) => e.type === 'started').length === 2);
  await wait(300);
  globalThis.__stillnoteMicrophone(false);
  await until(() => prompts().length === 3);
  assert.equal(prompts()[2].deadline, null);
  await wait(800);
  assert.ok((await call('state')).recording, 'only asked, still recording');
  await call('stop');
  await until(() => win.events.some((e) => e.type === 'silence-trimmed'));
  assert.equal(win.events.find((e) => e.type === 'silence-trimmed').removed, 70);
  saved = (await call('state')).meetings.find((m) => m.id === meeting.id);
  assert.equal(saved.duration, 60, 'both recordings, trimmed');
  assert.ok(events().some((e) => e.type === 'native-command' && e.op === 'stop'));
});
test('the renderer can call exactly the operations main registers', () => {
  const read = (file) => readFileSync(new URL(`../app/${file}`, import.meta.url), 'utf8');
  const registered = [...read('main.mjs').matchAll(/register\(\s*'([\w-]+)'/g)].map((m) => m[1]);
  const allowed = [
    ...read('preload.cjs')
      .match(/const channels = \[([\s\S]*?)\]/)[1]
      .matchAll(/'([\w-]+)'/g),
  ].map((m) => m[1]);
  assert.deepEqual([...registered].sort(), [...allowed].sort());
});
