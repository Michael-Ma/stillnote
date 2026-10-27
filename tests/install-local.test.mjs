import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDirectory, replaceBundle, appIsRunning } from '../scripts/install-local.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stillnote-install-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test('test installs accept only an isolated temporary Applications directory', (t) => {
  const root = fixture(t);
  assert.equal(installDirectory(root), join(root, 'Applications'));
  assert.throws(() => installDirectory(tmpdir()), /temporary directory/);
  rmSync(join(root, 'Applications'), { recursive: true });
  symlinkSync('/Applications', join(root, 'Applications'));
  assert.throws(() => installDirectory(root), /symlink/);
});
test('a failed final rename restores the previous app bundle', (t) => {
  const root = fixture(t);
  const target = join(root, 'Stillnote.app'),
    previous = join(root, 'previous.app');
  mkdirSync(target);
  writeFileSync(join(target, 'version'), 'old app');
  assert.throws(() => replaceBundle(join(root, 'missing-stage'), target, previous), /ENOENT/);
  assert.equal(readFileSync(join(target, 'version'), 'utf8'), 'old app');
  assert.equal(existsSync(previous), false);
});
test('an upgrade replaces the bundle without modifying a neighboring notebook', (t) => {
  const root = fixture(t);
  const target = join(root, 'Stillnote.app'),
    staging = join(root, 'new.app'),
    previous = join(root, 'previous.app');
  for (const path of [target, staging]) mkdirSync(path);
  writeFileSync(join(target, 'version'), 'old app');
  writeFileSync(join(staging, 'version'), 'new app');
  writeFileSync(join(root, 'notebook'), 'keep this data');
  replaceBundle(staging, target, previous);
  assert.equal(readFileSync(join(target, 'version'), 'utf8'), 'new app');
  assert.equal(readFileSync(join(previous, 'version'), 'utf8'), 'old app');
  assert.equal(readFileSync(join(root, 'notebook'), 'utf8'), 'keep this data');
});

test('process lookup distinguishes no matches from a failure to inspect processes', () => {
  assert.equal(
    appIsRunning('/temporary/Stillnote.app', (pattern) => {
      assert.ok(pattern.endsWith('([[:space:]]|$)'), 'also detects launch arguments');
    }),
    true,
  );
  assert.equal(
    appIsRunning('/temporary/Stillnote.app', () => {
      throw Object.assign(new Error('no matches'), { status: 1 });
    }),
    false,
  );
  assert.throws(
    () =>
      appIsRunning('/temporary/Stillnote.app', () => {
        throw Object.assign(new Error('cannot inspect processes'), { status: 3 });
      }),
    /cannot inspect processes/,
  );
});
