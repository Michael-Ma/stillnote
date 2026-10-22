import test from 'node:test';
import assert from 'node:assert/strict';
import { pickIdentity } from '../scripts/sign-local.mjs';

const listing = (...lines) =>
  [...lines.map((l, i) => `  ${i + 1}) ${l}`), `     ${lines.length} valid identities found`].join(
    '\n',
  );

test('a valid Apple Development identity wins, chosen by its SHA-1', () => {
  const out = listing(
    'ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Apple Development: someone@example.com (ABCDE12345)"',
    '1111111111111111111111111111111111111111 "Developer ID Application: Example (ABCDE12345)"',
  );
  assert.deepEqual(pickIdentity(out, true), {
    sign: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
    label: 'Apple Development',
  });
});

test('without a valid Apple Development identity, the local one is used, then ad hoc', () => {
  const none = '     0 valid identities found';
  assert.equal(pickIdentity(none, true).sign, 'Stillnote Local Signing');
  assert.equal(pickIdentity(none, false).sign, '-');
  const other = listing('2222222222222222222222222222222222222222 "Apple Distribution: X (Y)"');
  assert.equal(pickIdentity(other, true).sign, 'Stillnote Local Signing');
});
