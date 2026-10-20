import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
if (process.platform !== 'darwin')
  throw new Error('macOS is required to build the application icon.');
mkdirSync('assets/Stillnote.iconset', { recursive: true });
execFileSync(
  'swift',
  [
    '-module-cache-path',
    resolve('native/bin/cache'),
    'scripts/icon.swift',
    resolve('assets/icon.png'),
  ],
  { stdio: 'inherit' },
);
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
