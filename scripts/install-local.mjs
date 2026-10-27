// Installs the packaged build into /Applications. The new copy is staged beside the old one and
// swapped in with renames, so launching Stillnote during an update never reads a half-copied
// bundle (which fails with ERR_FAILED loading app.asar/dist/index.html).
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync, realpathSync, mkdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve, join, dirname, basename } from 'node:path';

export const packagedApp = () =>
  resolve(`release.noindex/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Stillnote.app`);

// Test installs are restricted to a freshly-created directory under the OS temporary folder.
// No command-line target override can redirect a test into Applications or a real notebook.
export function installDirectory(testRoot) {
  if (testRoot === undefined) return '/Applications';
  const root = realpathSync(testRoot);
  if (
    dirname(root) !== realpathSync(tmpdir()) ||
    !/^stillnote-install-test-[a-zA-Z0-9]+$/.test(basename(root))
  )
    throw new Error('Test installation requires a stillnote-install-test-* temporary directory.');
  const directory = join(root, 'Applications');
  if (lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error('Test installation cannot follow an Applications symlink.');
  mkdirSync(directory, { recursive: true });
  if (realpathSync(directory) !== directory)
    throw new Error('Test installation cannot follow an Applications symlink.');
  return directory;
}

export function replaceBundle(staging, target, previous) {
  const hadPrevious = existsSync(target);
  if (hadPrevious) renameSync(target, previous);
  try {
    renameSync(staging, target);
  } catch (error) {
    if (hadPrevious) renameSync(previous, target);
    throw error;
  }
}

export function appIsRunning(
  target,
  query = (pattern) => execFileSync('pgrep', ['-f', pattern], { stdio: 'pipe' }),
) {
  const executable = `${target}/Contents/MacOS/Stillnote`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    query(`^${executable}([[:space:]]|$)`);
    return true;
  } catch (error) {
    if (error.status === 1) return false; // pgrep's explicit "no matches" status
    throw error; // Process-list permission failures must not authorize replacement.
  }
}

export function installApp({ built = packagedApp(), testRoot } = {}) {
  if (process.platform !== 'darwin') throw new Error('Installing requires macOS.');
  const directory = installDirectory(testRoot);
  const target = join(directory, 'Stillnote.app'),
    staging = join(directory, '.Stillnote.app.installing'),
    previous = join(directory, '.Stillnote.app.previous');
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe' });
  const running = () => appIsRunning(target);
  const retire = (path) =>
    testRoot === undefined
      ? run('/usr/bin/trash', [path])
      : rmSync(path, { recursive: true, force: true });

  if (!existsSync(built)) throw new Error('No packaged app. Run npm run package first.');
  run('codesign', ['--verify', '--deep', '--strict', built]);
  rmSync(staging, { recursive: true, force: true });
  run('ditto', [built, staging]);
  run('codesign', ['--verify', '--deep', '--strict', staging]);

  const wasRunning = running();
  if (wasRunning) {
    if (testRoot !== undefined) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error('Close the temporary test app before replacing it.');
    }
    // Quit only the installed copy normally, so it saves drafts first. Never force-kill it.
    run('osascript', [
      '-e',
      'if application id "local.stillnote.app" is running then tell application id "local.stillnote.app" to quit',
    ]);
    const deadline = Date.now() + 45_000;
    while (running() && Date.now() < deadline) run('sleep', ['0.3']);
    if (running()) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(
        'Stillnote is still running (recording or transcribing?). Quit it and retry.',
      );
    }
  }

  // Recover an older interrupted replacement rather than deleting its only surviving app.
  if (existsSync(previous) && !existsSync(target)) renameSync(previous, target);
  if (existsSync(previous)) retire(previous);
  replaceBundle(staging, target, previous);
  if (existsSync(previous)) retire(previous);
  if (wasRunning) run('open', [target]);
  console.log(`Installed ${target}${wasRunning ? ' and reopened it' : ''}`);
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  installApp();
