import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'scripts/aec-sources.json'), 'utf8'));
const packages = [
  {
    key: 'webrtc',
    name: 'webrtc-audio-processing',
    directory: 'webrtc-audio-processing-2.1',
    url: 'https://freedesktop.org/software/pulseaudio/webrtc-audio-processing/webrtc-audio-processing-2.1.tar.xz',
    sha256: 'ae9302824b2038d394f10213cab05312c564a038434269f11dbf68f511f9f9fe',
  },
  {
    key: 'abseil',
    name: 'abseil-cpp',
    directory: 'abseil-cpp-20240722.0',
    url: 'https://github.com/abseil/abseil-cpp/releases/download/20240722.0/abseil-cpp-20240722.0.tar.gz',
    sha256: 'f50e5ac311a81382da7fa75b97310e4b9006474f9560ac46f54a9967f07d4ae3',
  },
];
const temporary = mkdtempSync(join(tmpdir(), 'stillnote-vendor-aec-'));
try {
  // Download and verify everything before replacing either source subset.
  for (const pkg of packages) {
    const response = await fetch(pkg.url);
    if (!response.ok) throw new Error(`Download failed: ${pkg.url}: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== pkg.sha256)
      throw new Error(`SHA-256 mismatch: ${pkg.name}`);
    const archive = join(temporary, `${pkg.name}.tar`);
    writeFileSync(archive, bytes);
    execFileSync('tar', ['-xf', archive, '-C', temporary]);
    for (const file of manifest[pkg.key].files) readFileSync(join(temporary, pkg.directory, file));
  }
  for (const pkg of packages) {
    const destination = join(root, 'native/vendor', pkg.name);
    rmSync(destination, { recursive: true, force: true });
    for (const file of manifest[pkg.key].files) {
      const target = join(destination, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(temporary, pkg.directory, file), target);
    }
    if (pkg.key === 'webrtc')
      execFileSync('patch', ['-p1', '-i', join(root, 'scripts/aec-sse2.patch')], {
        cwd: destination,
      });
    console.log(`${pkg.name}: ${manifest[pkg.key].files.length} files, SHA-256 verified`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
