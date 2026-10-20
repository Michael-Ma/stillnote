import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
if (process.platform !== 'darwin')
  throw new Error('macOS is required to build the application icon.');
mkdirSync('assets/Stillnote.iconset', { recursive: true });
const master = resolve('assets/icon-master.png');
if (!existsSync(master)) throw new Error('Missing canonical icon: assets/icon-master.png');
// The selected generated master is kept unchanged. Only resample it for platform assets.
for (const [size, output] of [
  [1024, 'assets/icon.png'],
  [64, 'assets/icon-small.png'],
])
  execFileSync('sips', ['-z', String(size), String(size), master, '--out', output], {
    stdio: 'ignore',
  });
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2])
    execFileSync(
      'sips',
      [
        '-z',
        String(size * scale),
        String(size * scale),
        'assets/icon.png',
        '--out',
        `assets/Stillnote.iconset/icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`,
      ],
      { stdio: 'ignore' },
    );
execFileSync('iconutil', ['-c', 'icns', 'assets/Stillnote.iconset', '-o', 'assets/icon.icns'], {
  stdio: 'inherit',
});
