// Fresh install + upgrade using the production installer and a disposable existing notebook.
// Never replaces, launches, or quits /Applications/Stillnote.app; never reads the real notebook.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';
import { recordingDirectory, inspectRecordingTracks } from '../app/recordings.mjs';
import { wav } from '../tests/e2e/adapter.mjs';
import { installApp, packagedApp } from './install-local.mjs';

assert.equal(process.platform, 'darwin', 'Installation testing requires macOS');
const testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'stillnote-install-test-')));
const dataDir = join(testRoot, 'notebook');
const built = packagedApp();
const existingApp = '/Applications/Stillnote.app';
const firstBuild = existsSync(existingApp) ? existingApp : built;
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const existingAppHash = existsSync(existingApp)
  ? digest(join(existingApp, 'Contents/Resources/app.asar'))
  : null;
const oldText = 'Existing notes survive a local app update.';
const store = new Store(dataDir);
const folder = store.addFolder('Installer test');
const note = store.create({ title: 'Existing notebook', notes: oldText });
store.update(note.id, { folderId: folder.id, summary: 'Existing enhanced notes', starred: true });
const recordingId = randomUUID();
const audioDir = recordingDirectory(dataDir, note.id, recordingId);
mkdirSync(audioDir, { recursive: true });
for (const source of ['microphone', 'system'])
  writeFileSync(join(audioDir, source + '.wav'), wav(1));
const audioHashes = Object.fromEntries(
  ['microphone', 'system'].map((source) => [source, digest(join(audioDir, source + '.wav'))]),
);
store.beginRecording(note.id, { id: recordingId });
store.append(note.id, {
  recordingId,
  source: 'microphone',
  timestamp: 0,
  text: 'Existing transcript evidence.',
});
store.finishRecording(note.id, recordingId, {
  status: 'completed',
  duration: 1,
  tracks: inspectRecordingTracks(audioDir),
});
for (const [key, value] of Object.entries({
  meetingDetection: false,
  meetingEnd: 'off',
  autoEnhance: false,
}))
  store.setting(key, value);
store.close();

let desktop;
let createdId;
let passed = false;
async function inspect(target, createNote) {
  desktop = await electron.launch({
    executablePath: join(target, 'Contents/MacOS/Stillnote'),
    env: {
      ...process.env,
      STILLNOTE_DATA_DIR: dataDir,
      STILLNOTE_DISABLE_CLAUDE: '1',
      STILLNOTE_MOCK_KEYCHAIN: '1',
      STILLNOTE_UI_LANGUAGE: 'en',
    },
    timeout: 30_000,
  });
  const page = await desktop.firstWindow();
  await page.getByRole('button', { name: 'New note', exact: true }).waitFor();
  const state = await page.evaluate(() => window.stillnote.call('state'));
  assert.equal(
    state.dataDir,
    dataDir,
    'Refuse to write unless the app confirms the isolated notebook',
  );
  const preserved = state.meetings.find((m) => m.id === note.id);
  assert.equal(preserved?.notes, oldText);
  assert.equal(preserved.summary, 'Existing enhanced notes');
  assert.equal(preserved.starred, true);
  assert.equal(preserved.folderId, folder.id);
  assert.equal(preserved.transcript[0].text, 'Existing transcript evidence.');
  assert.equal(preserved.recordings[0].status, 'completed');
  assert.equal(state.settings.meetingEnd, 'off');
  for (const source of ['microphone', 'system']) {
    assert.equal(digest(join(audioDir, source + '.wav')), audioHashes[source]);
    const duration = await page.evaluate(
      async ({ id, recordingId, source }) => {
        const url = await window.stillnote.call('recording-url', id, recordingId, source);
        // The renderer intentionally blocks fetch; exercise its allowed media path instead.
        const audio = new Audio();
        audio.muted = true;
        audio.preload = 'metadata';
        try {
          return await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Saved audio did not load')), 10_000);
            audio.onloadedmetadata = () => {
              clearTimeout(timeout);
              resolve(audio.duration);
            };
            audio.onerror = () => {
              clearTimeout(timeout);
              reject(new Error('Saved audio is not playable'));
            };
            audio.src = url;
          });
        } finally {
          audio.onloadedmetadata = audio.onerror = null;
          audio.removeAttribute('src');
          audio.load();
        }
      },
      { id: note.id, recordingId, source },
    );
    assert.ok(Math.abs(duration - 1) < 0.01, 'Saved audio duration survives installation');
  }
  if (createNote) {
    await page.getByRole('button', { name: 'New note', exact: true }).click();
    await page.getByRole('textbox', { name: 'Meeting title' }).fill('Created before upgrade');
    await page
      .getByRole('textbox', { name: 'My notes', exact: true })
      .fill('Saved through the real packaged UI.');
    await page.getByRole('button', { name: 'Back to Home' }).click();
    await page.locator('.note-row').filter({ hasText: 'Created before upgrade' }).waitFor();
    const after = await page.evaluate(() => window.stillnote.call('state'));
    createdId = after.meetings.find((m) => m.title === 'Created before upgrade')?.id;
    assert.ok(createdId);
    assert.throws(() => installApp({ built, testRoot }), /Close the temporary test app/);
    assert.equal(await page.getByRole('button', { name: 'New note', exact: true }).count(), 1);
  } else {
    assert.equal(
      state.meetings.find((m) => m.id === createdId)?.notes,
      'Saved through the real packaged UI.',
    );
  }
  await desktop.close();
  desktop = undefined;
}
try {
  const target = installApp({ built: firstBuild, testRoot });
  assert.ok(target.startsWith(testRoot + '/'));
  await inspect(target, true);
  // A marker proves the old bundle was replaced, rather than merging files into the old copy.
  writeFileSync(join(target, 'old-install-marker'), 'temporary fixture');
  installApp({ built, testRoot });
  assert.equal(existsSync(join(target, 'old-install-marker')), false);
  execFileSync('codesign', ['--verify', '--deep', '--strict', target]);
  assert.equal(
    digest(join(target, 'Contents/Resources/app.asar')),
    digest(join(built, 'Contents/Resources/app.asar')),
  );
  await inspect(target, false);
  if (existingAppHash)
    assert.equal(digest(join(existingApp, 'Contents/Resources/app.asar')), existingAppHash);
  console.log(
    JSON.stringify({
      installAndUpgrade: 'passed',
      notebookPreserved: true,
      transcriptPreserved: true,
      recordingsPreserved: true,
      playbackMetadataVerified: true,
      installedAppUnchanged: true,
      runningTestAppProtected: true,
      productionNotebookOpened: false,
      liveCaptureTested: false,
      liveAITested: false,
    }),
  );
  passed = true;
} finally {
  if (desktop) await desktop.close();
  if (passed) rmSync(testRoot, { recursive: true, force: true });
  else console.error(`Test failed; disposable files remain at ${testRoot}`);
}
