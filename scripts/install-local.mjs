// Installs the packaged build into /Applications. The new copy is staged beside the old one and
// swapped in with renames, so launching Stillnote during an update never reads a half-copied
// bundle (which fails with ERR_FAILED loading app.asar/dist/index.html).
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.platform !== 'darwin') throw new Error('Installing requires macOS.');
const built = resolve(
  `release.noindex/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Stillnote.app`,
);
const target = '/Applications/Stillnote.app',
  staging = '/Applications/.Stillnote.app.installing',
  previous = '/Applications/.Stillnote.app.previous';
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe' });
const running = () => {
  try {
    run('pgrep', ['-f', `${target}/Contents/MacOS/Stillnote$`]);
    return true;
  } catch {
    return false;
  }
};

if (!existsSync(built)) throw new Error('No packaged app. Run npm run package first.');
run('codesign', ['--verify', '--deep', '--strict', built]);
rmSync(staging, { recursive: true, force: true });
run('ditto', [built, staging]);
run('codesign', ['--verify', '--deep', '--strict', staging]);

// Quit a running copy the normal way, so it saves drafts first. `is running` avoids launching it.
const wasRunning = running();
if (wasRunning) {
  run('osascript', [
    '-e',
    'if application id "local.stillnote.app" is running then tell application id "local.stillnote.app" to quit',
  ]);
  const deadline = Date.now() + 15_000;
  while (running() && Date.now() < deadline) run('sleep', ['0.3']);
  if (running()) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error('Stillnote is still running (recording or transcribing?). Quit it and retry.');
  }
}

rmSync(previous, { recursive: true, force: true });
if (existsSync(target)) renameSync(target, previous);
renameSync(staging, target);
// The replaced copy goes to the Trash rather than being deleted outright.
if (existsSync(previous)) run('/usr/bin/trash', [previous]);
// A copy that was open before the update comes back as the new version.
if (wasRunning) run('open', [target]);
console.log(`Installed ${target}${wasRunning ? ' and reopened it' : ''}`);
