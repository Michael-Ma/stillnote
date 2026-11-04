// Exercise the delivered archives, not just the bundle used to create them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const output = resolve('release.noindex');
const name = `Stillnote-${version}-mac-arm64`;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'stillnote-archive-test-')));
const extracted = join(root, 'extracted.noindex');
const mounted = join(root, 'mounted.noindex');
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', ...options });
const smoke = (bundle) => {
  run('codesign', ['--verify', '--deep', '--strict', bundle]);
  run(process.execPath, ['scripts/package-smoke.mjs'], {
    env: { ...process.env, STILLNOTE_PACKAGED_APP: bundle },
  });
};
let attached = false;
try {
  const manifest = readFileSync(join(output, 'SHA256SUMS'), 'utf8');
  for (const extension of ['zip', 'dmg']) {
    const file = `${name}.${extension}`;
    const hash = createHash('sha256')
      .update(readFileSync(join(output, file)))
      .digest('hex');
    assert.ok(manifest.split('\n').includes(`${hash}  ${file}`), `Checksum mismatch: ${file}`);
  }
  mkdirSync(extracted);
  mkdirSync(mounted);
  run('ditto', ['-x', '-k', join(output, `${name}.zip`), extracted]);
  smoke(join(extracted, 'Stillnote.app'));
  run('hdiutil', [
    'attach',
    '-readonly',
    '-nobrowse',
    '-mountpoint',
    mounted,
    join(output, `${name}.dmg`),
  ]);
  attached = true;
  assert.equal(realpathSync(join(mounted, 'Applications')), '/Applications');
  assert.ok(readFileSync(join(mounted, 'READ ME.txt'), 'utf8').includes(version));
  assert.equal(readFileSync(join(mounted, 'LICENSE'), 'utf8'), readFileSync('LICENSE', 'utf8'));
  smoke(join(mounted, 'Stillnote.app'));
  console.log(
    'ZIP and mounted DMG: checksums, signatures, native helper, UI and persistence passed.',
  );
} finally {
  // Never recursively remove a mount point while a disk image is attached.
  if (attached) run('hdiutil', ['detach', mounted]);
  rmSync(root, { recursive: true, force: true });
}
