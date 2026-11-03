import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const helper = resolve('native/bin/StillnoteCapture');
const native = process.platform === 'darwin' && existsSync(helper);
function wav(samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, i) => bytes.writeInt16LE(sample, 44 + i * 2));
  return bytes;
}

test(
  'AEC CLI preserves raw WAVs, length, offsets and zero-run resets across read boundaries',
  { skip: !native },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'stillnote-aec-test-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const microphone = join(directory, 'microphone.wav');
    const reference = join(directory, 'system.wav');
    const output = join(directory, 'processed.wav');
    // The first zero run straddles two 1600-sample reads; the second is below threshold.
    // More than ten seconds also exercises the offline loop's cooperative yield.
    const samples = Array.from({ length: 192037 }, (_, i) =>
      (i >= 1573 && i < 3174) || (i >= 9000 && i < 10599)
        ? 0
        : Math.round(3000 * Math.sin((2 * Math.PI * 733 * i) / 16000)),
    );
    const original = wav(samples);
    writeFileSync(microphone, original);
    const silent = wav(Array(samples.length).fill(0));
    writeFileSync(reference, silent);
    const invoke = (...options) =>
      JSON.parse(
        execFileSync(
          helper,
          [
            '--aec-file',
            microphone,
            '--reference',
            reference,
            '--mic-offset',
            '0.123',
            '--reference-offset',
            '0.223',
            '--out',
            output,
            ...options,
          ],
          { encoding: 'utf8', timeout: 10000 },
        ),
      );
    const result = invoke();
    assert.equal(result.processedSamples, samples.length);
    assert.equal(result.errors, 0);
    assert.equal(result.resets, 1);
    assert.ok(result.seconds.length >= 2);
    assert.ok(result.seconds.every((row) => row.length === 4 && row.every(Number.isFinite)));
    assert.deepEqual(readFileSync(microphone), original);
    assert.deepEqual(readFileSync(reference), silent);
    assert.equal(readFileSync(output).readUInt32LE(40), samples.length * 2);
    assert.deepEqual(readFileSync(output).subarray(44), original.subarray(44));
    const linear = invoke('--linear', '--no-reset');
    assert.equal(linear.resets, 0);
    assert.equal(linear.processedSamples, samples.length);
    assert.throws(
      () =>
        execFileSync(
          helper,
          ['--aec-file', microphone, '--reference', reference, '--out', microphone],
          { stdio: 'pipe', timeout: 10000 },
        ),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(JSON.parse(error.stdout).message, /differ/);
        return true;
      },
    );
    for (const [name, make] of [
      ['hard-link.wav', linkSync],
      ['symbolic-link.wav', symlinkSync],
    ]) {
      const alias = join(directory, name);
      make(microphone, alias);
      assert.throws(
        () =>
          execFileSync(
            helper,
            ['--aec-file', microphone, '--reference', reference, '--out', alias],
            { stdio: 'pipe', timeout: 10000 },
          ),
        (error) => {
          assert.equal(error.status, 1);
          assert.match(JSON.parse(error.stdout).message, /differ/);
          return true;
        },
      );
    }
    assert.deepEqual(readFileSync(microphone), original);
  },
);
