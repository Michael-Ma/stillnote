// Lists the interface strings used in app/ and, run directly, the ones the Chinese catalog lacks:
//   node scripts/i18n-keys.mjs
// They are every literal t('…'), t.count(n, '…', '…') and msg('…'), plus, in main-process modules,
// literal `new Error('…')` and `message: '…'` texts: those reach the window in English and the
// renderer translates them when it shows them.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const literal = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*)\1`;
const single = new RegExp(String.raw`\bt\(\s*` + literal, 'g');
const plural = new RegExp(
  String.raw`\bt\.count\(\s*[^,]+,\s*` +
    literal +
    String.raw`\s*,\s*` +
    literal.replace('\\1', '\\3').replace('\\1', '\\3'),
  'g',
);
const marker = new RegExp(String.raw`\bmsg\(\s*` + literal, 'g');
const thrown = new RegExp(String.raw`new Error\(\s*` + literal + String.raw`\s*\)`, 'g');
const field = new RegExp(String.raw`\bmessage:\s*` + literal + String.raw`\s*[,}\n]`, 'g');
const unquote = (quote, body) => new Function(`return ${quote}${body}${quote}`)();

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'i18n' ? [] : files(path);
    return /\.(jsx|mjs)$/.test(name) ? [path] : [];
  });
}

export function usedKeys(dir = join(root, 'app')) {
  const keys = new Map();
  for (const path of files(dir)) {
    const source = readFileSync(path, 'utf8');
    const patterns = path.endsWith('.mjs') ? [single, marker, thrown, field] : [single, marker];
    for (const pattern of patterns)
      for (const m of source.matchAll(pattern))
        if (!(m[1] === '`' && m[2].includes('${'))) keys.set(unquote(m[1], m[2]), path);
    for (const m of source.matchAll(plural)) {
      keys.set(unquote(m[1], m[2]), path);
      keys.set(unquote(m[3], m[4]), path);
    }
  }
  return keys;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: zh } = await import('../app/i18n/zh-Hans.mjs');
  const missing = [...usedKeys()].filter(([key]) => !(key in zh));
  for (const [key, path] of missing)
    console.log(JSON.stringify(key), '//', path.slice(root.length + 1));
  console.error(`${missing.length} of ${usedKeys().size} strings lack a Chinese translation.`);
}
