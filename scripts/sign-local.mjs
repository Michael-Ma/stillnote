import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { hasIdentity, identity } from './setup-signing.mjs';
if (process.platform !== 'darwin') throw new Error('Local signing requires macOS.');
const bundle = resolve(
  `release.noindex/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Stillnote.app`,
);
// One certificate for every build keeps the designated requirement stable, so the keychain and
// privacy permissions keep trusting rebuilt copies. Ad-hoc signatures change with every build.
const sign = hasIdentity() ? identity : '-';
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
console.log(`Signed ${bundle} with ${sign === '-' ? 'an ad-hoc signature' : `“${identity}”`}.`);
