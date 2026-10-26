import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
mkdirSync('native/bin', { recursive: true });
if (process.platform === 'darwin')
  execFileSync(
    'swiftc',
    [
      '-swift-version',
      '5',
      '-O',
      '-target',
      `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
      '-module-cache-path',
      resolve('native/bin/cache'),
      '-Xlinker',
      '-sectcreate',
      '-Xlinker',
      '__TEXT',
      '-Xlinker',
      '__info_plist',
      '-Xlinker',
      resolve('native/Info.plist'),
      'native/Capture.swift',
      '-o',
      'native/bin/StillnoteCapture',
    ],
    { stdio: 'inherit' },
  );
await esbuild({
  entryPoints: ['app/main.mjs'],
  outdir: 'dist-electron',
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['electron'],
  target: 'node22',
});
for (const name of ['preload', 'panel-preload'])
  await esbuild({
    entryPoints: [`app/${name}.cjs`],
    outfile: `dist-electron/${name}.cjs`,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
// The main window, and the floating panel that replaces system notifications.
await vite({
  configFile: false,
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: { main: resolve('index.html'), panel: resolve('panel.html') } },
  },
});
