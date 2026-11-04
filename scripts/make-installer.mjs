// Package the already-tested, signed app. No credentials, notebook or source tree are included.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packagedApp } from './install-local.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('This installer is currently validated only on Apple Silicon macOS.');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const bundle = packagedApp();
const output = resolve('release.noindex');
const name = `Stillnote-${version}-mac-arm64`;
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
run('codesign', ['--verify', '--deep', '--strict', bundle]);
const info = join(bundle, 'Contents/Info.plist');
const packagedVersion = execFileSync(
  '/usr/libexec/PlistBuddy',
  ['-c', 'Print :CFBundleShortVersionString', info],
  { encoding: 'utf8' },
).trim();
if (packagedVersion !== version)
  throw new Error('Packaged version is stale. Rebuild before distributing.');
const helper = join(bundle, 'Contents/Resources/StillnoteCapture');
run('lipo', ['-verify_arch', 'arm64', helper]);
const staging = mkdtempSync(join(tmpdir(), 'stillnote-dmg-'));
try {
  run('ditto', [bundle, join(staging, 'Stillnote.app')]);
  symlinkSync('/Applications', join(staging, 'Applications'));
  writeFileSync(
    join(staging, 'READ ME.txt'),
    `Stillnote ${version} — Apple Silicon\n\nQuit Stillnote before updating. Drag Stillnote.app to Applications, then open it there.\nNo Node.js, Xcode or source checkout is required. macOS 13+; macOS 26+ recommended.\nThis community build is ad-hoc signed and NOT Apple-notarized. If macOS blocks opening,\nfollow System Settings > Privacy & Security > Open Anyway, only if you trust this release.\nDo not disable Gatekeeper or remove quarantine recursively.\nYour notes stay in ~/Library/Application Support/Stillnote/, outside the app.\nIn Settings connect ChatGPT or Claude; recording works without AI sign-in.\nClaude requires the separately installed Claude Code CLI.\n\nInstall help: https://github.com/Michael-Ma/stillnote/blob/main/docs/INSTALL.md\nLicense: personal and internal business use; see LICENSE.\n`,
  );
  run('ditto', ['LICENSE', join(staging, 'LICENSE')]);
  // A failed rebuild must not leave a checksum manifest from an older build.
  rmSync(join(output, 'SHA256SUMS'), { force: true });
  // Remove only the exact artifact names being regenerated; keep other releases intact.
  for (const extension of ['dmg', 'zip'])
    rmSync(join(output, `${name}.${extension}`), { force: true });
  run('hdiutil', [
    'create',
    '-volname',
    `Stillnote ${version}`,
    '-srcfolder',
    staging,
    '-format',
    'UDZO',
    join(output, `${name}.dmg`),
  ]);
  run('hdiutil', ['verify', join(output, `${name}.dmg`)]);
  run('ditto', [
    '-c',
    '-k',
    '--sequesterRsrc',
    '--keepParent',
    bundle,
    join(output, `${name}.zip`),
  ]);
  const checksums = ['dmg', 'zip']
    .map((extension) => {
      const file = `${name}.${extension}`;
      return `${createHash('sha256')
        .update(readFileSync(join(output, file)))
        .digest('hex')}  ${file}\n`;
    })
    .join('');
  writeFileSync(join(output, 'SHA256SUMS'), checksums);
  console.log(`Installer, agent-friendly ZIP and SHA256SUMS are in ${output}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
