import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const script = resolve(import.meta.dirname, '../scripts/setup-mac.sh');
function run(t, args, failure = '') {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-setup-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls');
  for (const [name, body] of Object.entries({
    uname: 'echo Darwin',
    node: 'echo 24',
    xcrun: 'echo 27.0',
    npm: 'printf "%s\\n" "$*" >> "$STILLNOTE_SETUP_LOG"\nif [ "$*" = "$STILLNOTE_SETUP_FAIL" ]; then exit 17; fi',
  })) {
    const path = join(dir, name);
    writeFileSync(path, '#!/bin/sh\n' + body + '\n');
    chmodSync(path, 0o755);
  }
  const result = spawnSync('/bin/bash', [script, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      BASH_ENV: '',
      PATH: dir + ':/usr/bin:/bin',
      STILLNOTE_SETUP_LOG: log,
      STILLNOTE_SETUP_FAIL: failure,
    },
  });
  return { ...result, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
}
test('--test routes installation exclusively to the isolated installer test', (t) => {
  const result = run(t, ['--test']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    'ci --no-audit --no-fund',
    'run package',
    'run test:package',
    'run test:install',
  ]);
});
test('a misspelled test flag fails before dependencies, packaging or installation', (t) => {
  const result = run(t, ['--tset']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
  assert.deepEqual(result.calls, []);
});
test('a failed package smoke test prevents any installation', (t) => {
  const result = run(t, [], 'run test:package');
  assert.equal(result.status, 17);
  assert.deepEqual(result.calls, ['ci --no-audit --no-fund', 'run package', 'run test:package']);
});
