import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const lines = execFileSync(resolve('native/bin/StillnoteCapture'), ['--scheduler-self-test'], {
  encoding: 'utf8',
  timeout: 30_000,
})
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const result = lines.find((event) => event.type === 'scheduler-self-test');
assert.equal(result?.status, 'passed');
assert.equal(result.maximumConcurrentRecognition, 1);
assert.equal(result.speechRecognitionInvoked, false);
assert.equal(result.liveAudioInvoked, false);
console.log(JSON.stringify(result));
