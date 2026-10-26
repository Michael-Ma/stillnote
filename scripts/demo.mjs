// Build current sources, capture synthetic fixtures, and clean intermediate media on success.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

for (const [command, args] of [
  ['npm', ['run', 'build']],
  [process.execPath, ['scripts/demo-video.mjs']],
  ['bash', ['scripts/finalize-demo.sh']],
]) {
  const result = spawnSync(command, args, {
    cwd: resolve(import.meta.dirname, '..'),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const file of ['docs/images/demo-raw.mp4', 'docs/images/demo-timing.json']) {
  rmSync(resolve(import.meta.dirname, '..', file), { force: true });
}
