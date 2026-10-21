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
async function setup(t, name) {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-ipc-'));
  const scenario = join(dir, 'scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({
      responses: [{ text: 'Enhanced evidence [1]' }, { text: 'Answer [1]' }],
      sessions: [
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
  return { call, win, events };
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
