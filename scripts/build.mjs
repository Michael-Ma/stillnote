import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
mkdirSync('native/bin', { recursive: true });
if (process.platform === 'darwin') {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const target = `${arch}-apple-macosx13.0`;
  const manifest = JSON.parse(readFileSync('scripts/aec-sources.json', 'utf8'));
  const sources = [
    ...[...manifest.webrtc.sources, ...manifest.webrtc[arch]].map(
      (file) => `native/vendor/webrtc-audio-processing/${file}`,
    ),
    ...manifest.abseil.sources.map((file) => `native/vendor/abseil-cpp/${file}`),
    'native/aec/stillnote_aec.cc',
  ];
  const flags = [
    '-O2',
    '-DNDEBUG',
    '-target',
    target,
    '-DWEBRTC_POSIX',
    '-DWEBRTC_MAC',
    '-DWEBRTC_LIBRARY_IMPL',
    '-DWEBRTC_ENABLE_SYMBOL_EXPORT',
    '-DWEBRTC_APM_DEBUG_DUMP=0',
    ...(arch === 'arm64'
      ? ['-DWEBRTC_HAS_NEON', '-DWEBRTC_ARCH_ARM64']
      : ['-march=x86-64', '-msse2']),
    '-Inative/vendor/webrtc-audio-processing/webrtc',
    '-Inative/vendor/abseil-cpp',
    '-Inative/aec',
  ];
  const compiler = execFileSync('clang++', ['--version'], { encoding: 'utf8' });
  const sdk = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
  flags.push('-isysroot', sdk);
  const hash = createHash('sha256')
    .update(JSON.stringify([flags, compiler]))
    .digest('hex');
  const directory = `native/bin/aec/${arch}`;
  mkdirSync(directory, { recursive: true });
  // Headers also invalidate the cache, including headers shared by multiple translation units.
  const headers = [
    ...manifest.webrtc.files.map((file) => `native/vendor/webrtc-audio-processing/${file}`),
    ...manifest.abseil.files.map((file) => `native/vendor/abseil-cpp/${file}`),
    'native/aec/stillnote_aec.h',
    'scripts/aec-sources.json',
  ].filter((file) => /\.(h|inc|json)$/.test(file));
  const headerTime = Math.max(...headers.map((file) => statSync(file).mtimeMs));
  const run = promisify(execFile);
  let compiled = 0;
  const objects = sources.map((source) => `${directory}/${source.replaceAll('/', '_')}.o`);
  const pending = sources.map((source, index) => ({ source, object: objects[index] }));
  await Promise.all(
    Array.from({ length: availableParallelism() }, async () => {
      while (pending.length) {
        const { source, object } = pending.shift();
        const stamp = `${object}.flags`;
        const language = source.endsWith('.c') ? ['-x', 'c', '-std=c11'] : ['-std=c++17'];
        const signature = `${hash}:${language.join(' ')}`;
        if (
          existsSync(object) &&
          existsSync(stamp) &&
          readFileSync(stamp, 'utf8') === signature &&
          statSync(object).mtimeMs >= Math.max(statSync(source).mtimeMs, headerTime)
        )
          continue;
        try {
          await run('clang++', [...language, ...flags, '-c', source, '-o', object]);
        } catch (error) {
          throw new Error(`AEC compile failed: ${source}\n${error.stderr || error.message}`);
        }
        writeFileSync(stamp, signature);
        compiled++;
      }
    }),
  );
  const archive = 'native/bin/libstillnote_aec.a';
  const archiveStamp = `${archive}.flags`;
  const archiveSignature = createHash('sha256')
    .update(JSON.stringify([hash, sources]))
    .digest('hex');
  if (
    compiled ||
    !existsSync(archive) ||
    !existsSync(archiveStamp) ||
    readFileSync(archiveStamp, 'utf8') !== archiveSignature ||
    objects.some((file) => statSync(file).mtimeMs > statSync(archive).mtimeMs)
  ) {
    execFileSync('libtool', ['-static', '-o', archive, ...objects], { stdio: 'inherit' });
    writeFileSync(archiveStamp, archiveSignature);
  }
  console.log(
    `AEC: compiled ${compiled}/${sources.length} objects (${availableParallelism()} workers)`,
  );
  execFileSync(
    'swiftc',
    [
      '-swift-version',
      '5',
      '-O',
      '-target',
      target,
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
      '-import-objc-header',
      'native/aec/stillnote_aec.h',
      archive,
      '-lc++',
      'native/Capture.swift',
      '-o',
      'native/bin/StillnoteCapture',
    ],
    { stdio: 'inherit' },
  );
}
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
