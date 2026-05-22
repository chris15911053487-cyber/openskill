import { en, type TranslationKey } from './en';
import { zh } from './zh';

export type Lang = 'en' | 'zh';

const dictionaries: Record<Lang, Record<TranslationKey, string>> = {
  en,
  zh,
};

const STORAGE_KEY = 'openskill_lang';

export function getStoredLang(): Lang {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  if (v === 'en' || v === 'zh') return v;
  // Default: try browser language; fall back to en
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}

export function setStoredLang(lang: Lang): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, lang);
}

/**
 * Translate a key with optional {placeholder} substitution.
 */
export function translate(lang: Lang, key: TranslationKey, vars?: Record<string, string | number>): string {
  const raw = dictionaries[lang][key] ?? dictionaries.en[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}

export type { TranslationKey };
