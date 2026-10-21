import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
if (process.platform !== 'darwin') throw new Error('Local signing requires macOS.');
const bundle = resolve(
  `release.noindex/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Stillnote.app`,
);
// Ad-hoc signing makes this locally built bundle internally consistent. It is not notarization.
execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
