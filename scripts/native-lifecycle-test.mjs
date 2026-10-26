import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const lines = execFileSync(resolve('native/bin/StillnoteCapture'), ['--recognition-self-test'], {
  encoding: 'utf8',
  timeout: 15_000,
})
  .trim()
  .split('\n')
  .map(JSON.parse);
const result = lines.find((e) => e.type === 'recognition-self-test');
assert.equal(result?.status, 'passed', JSON.stringify(result));
assert.equal(result.speechRecognitionInvoked, false);
assert.equal(result.liveAudioInvoked, false);
console.log(JSON.stringify(result));
