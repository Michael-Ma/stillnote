import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasIdentity, identity as localIdentity } from './setup-signing.mjs';

// Prefer a valid Apple Development certificate (Xcode › Settings › Accounts): its Team ID gives the
// keychain a stable partition, so "Always Allow" survives rebuilds. The self-signed local identity
// keeps TCC permissions stable but not the keychain partition; ad hoc keeps neither.
export function pickIdentity(validIdentities, hasLocal) {
  const apple = validIdentities
    .split('\n')
    .map((line) => line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(Apple Development: .+)"$/))
    .find(Boolean);
  if (apple) return { sign: apple[1], label: 'Apple Development' };
  if (hasLocal) return { sign: localIdentity, label: `“${localIdentity}”` };
  return { sign: '-', label: 'an ad-hoc signature' };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.platform !== 'darwin') throw new Error('Local signing requires macOS.');
  const bundle = resolve(
    `release.noindex/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Stillnote.app`,
  );
  const valid = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  const { sign, label } = pickIdentity(valid, hasIdentity());
  if (sign === '-')
    console.warn(
      'Signing ad hoc. Run `npm run signing:setup` once so rebuilt apps stop asking for keychain access.',
    );
  // Sign the bundled native helper first so it carries the same identity as the app.
  execFileSync(
    'codesign',
    ['--force', '--sign', sign, resolve(bundle, 'Contents/Resources/StillnoteCapture')],
    { stdio: 'inherit' },
  );
  execFileSync('codesign', ['--force', '--deep', '--sign', sign, bundle], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  console.log(`Signed ${bundle} with ${label}.`);
}
