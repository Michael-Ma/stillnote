// One-time setup: a self-signed code-signing identity in the login keychain. Signing every local
// build with the same certificate keeps the app's designated requirement stable, so macOS keychain
// items and privacy permissions keep trusting rebuilt copies. It is not a Developer ID.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

export const identity = 'Stillnote Local Signing';
const keychain = join(homedir(), 'Library/Keychains/login.keychain-db');

export function hasIdentity() {
  try {
    execFileSync('security', ['find-certificate', '-c', identity, keychain], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function create() {
  const dir = mkdtempSync(join(tmpdir(), 'stillnote-signing-'));
  const password = randomBytes(18).toString('base64url');
  try {
    writeFileSync(
      join(dir, 'cert.cnf'),
      [
        '[req]',
        'distinguished_name = dn',
        'x509_extensions = ext',
        'prompt = no',
        '[dn]',
        `CN = ${identity}`,
        '[ext]',
        'basicConstraints = critical, CA:false',
        'keyUsage = critical, digitalSignature',
        'extendedKeyUsage = critical, codeSigning',
      ].join('\n'),
      { mode: 0o600 },
    );
    // macOS's own LibreSSL writes PKCS#12 files that `security import` accepts.
    const openssl = (...args) =>
      execFileSync('/usr/bin/openssl', args, { cwd: dir, stdio: 'pipe' });
    openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '3650',
      '-config',
      'cert.cnf',
      '-keyout',
      'key.pem',
      '-out',
      'cert.pem',
    );
    openssl(
      'pkcs12',
      '-export',
      '-inkey',
      'key.pem',
      '-in',
      'cert.pem',
      '-name',
      identity,
      '-out',
      'identity.p12',
      '-passout',
      `pass:${password}`,
    );
    execFileSync(
      'security',
      [
        'import',
        join(dir, 'identity.p12'),
        '-k',
        keychain,
        '-P',
        password,
        '-T',
        '/usr/bin/codesign',
      ],
      { stdio: 'pipe' },
    );
  } finally {
    // The private key now lives only in the keychain.
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.platform !== 'darwin') throw new Error('Local signing requires macOS.');
  if (hasIdentity()) console.log(`“${identity}” already exists in your login keychain.`);
  else {
    create();
    console.log(
      `Created “${identity}” in your login keychain. Local builds now keep one identity.`,
    );
  }
}
