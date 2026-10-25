// Interface language. Strings are keyed by their English text (gettext style): t('Start recording')
// returns the Chinese catalog entry, or the English text itself when there is none, so nothing
// breaks before it is translated. tests/i18n.test.mjs checks every t('…') in app/ has an entry.
// Shared by the main process and the renderer.
import zhHans from './zh-Hans.mjs';

export const uiLanguages = ['en', 'zh-Hans'];
const catalogs = { 'zh-Hans': zhHans };

// 'system' follows the first macOS language Stillnote has: any Chinese → 简体中文, else English.
export function resolveLanguage(setting = 'system', systemLanguages = []) {
  if (uiLanguages.includes(setting)) return setting;
  for (const tag of systemLanguages) {
    if (/^zh(-|$)/i.test(tag)) return 'zh-Hans';
    if (/^en(-|$)/i.test(tag)) return 'en';
  }
  return 'en';
}

// The locale used for dates, numbers and language names in this interface language.
export const formatLocale = (language) => (language === 'zh-Hans' ? 'zh-CN' : 'en-US');

export function translator(language = 'en', { missing } = {}) {
  const catalog = catalogs[language] ?? {};
  const fill = (text, vars) =>
    vars
      ? text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
      : text;
  const t = (key, vars) => {
    if (language !== 'en' && !(key in catalog)) missing?.(key);
    return fill(catalog[key] ?? key, vars);
  };
  // English picks the singular for 1; Chinese has one form, keyed by the plural.
  t.count = (n, one, other, vars) => t(n === 1 ? one : other, { n, ...vars });
  t.language = language;
  t.locale = formatLocale(language);
  return t;
}
