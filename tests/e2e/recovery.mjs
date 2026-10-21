import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../app/store.mjs';
import { recordingDirectory } from '../../app/recordings.mjs';
import { wav } from './adapter.mjs';

export async function recovery(h) {
  // Seed only this suite's disposable directory to represent a killed process.
  const store = new Store(h.dataDir);
  let meeting;
  let recording;
  try {
    meeting = store.create({
      title: 'E2E interrupted startup',
      notes: 'Preserve these rough notes.',
    });
    recording = store.beginRecording(meeting.id).recordings[0];
    store.finishRecording(meeting.id, recording.id, { status: 'recording' });
    store.append(meeting.id, {
      recordingId: recording.id,
      source: 'microphone',
      speaker: 'You',
      text: 'Transcript saved before an unexpected exit.',
      timestamp: 0,
    });
  } finally {
    store.close();
  }
  const dir = recordingDirectory(h.dataDir, meeting.id, recording.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'microphone.wav');
  const bytes = wav(2);
  bytes.writeUInt32LE(36, 4);
  bytes.writeUInt32LE(0, 40);
  writeFileSync(path, bytes);

  const page = await h.launch();
  const restored = (await h.state()).meetings.find((item) => item.id === meeting.id);
  assert.equal(restored.recordings[0].status, 'interrupted');
  assert.equal(restored.recordings[0].tracks.length, 1);
  assert.equal(restored.recordings[0].tracks[0].duration, 2);
  assert.equal(restored.duration, 2);
  assert.equal(restored.notes, meeting.notes);
  assert.equal(restored.transcript[0].text, 'Transcript saved before an unexpected exit.');
  const repaired = readFileSync(path);
  assert.equal(repaired.readUInt32LE(4), repaired.length - 8);
  assert.equal(repaired.readUInt32LE(40), repaired.length - 44);
  await h.open(meeting.title);
  await h.sheet('Recordings');
  await page.getByText('This capture ended unexpectedly.', { exact: false }).waitFor();
  const audio = page.locator('audio[aria-label="Microphone recording"]');
  await audio.waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('audio')?.readyState >= 1);
  await audio.evaluate(async (element) => {
    element.muted = true;
    await element.play();
  });
  await page.waitForFunction(() => document.querySelector('audio')?.currentTime > 0.05);
  await audio.evaluate((element) => element.pause());
  await h.screenshot('recovered-interrupted-recording');
  await h.restart();
  assert.equal((await h.state()).meetings[0].recordings[0].status, 'interrupted');
  h.assertNoRendererErrors();
}
