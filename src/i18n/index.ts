// Minimal i18n: one active language per JS context (content script / service worker).
// Each module defines its own messages with defineMessages(); TypeScript enforces that every
// language has every key of the English source.

export type Lang = 'en' | 'de' | 'pl';

export const LANGS: { id: Lang; label: string; name: string }[] = [
  { id: 'en', label: 'EN', name: 'English' },
  { id: 'de', label: 'DE', name: 'Deutsch' },
  { id: 'pl', label: 'PL', name: 'Polski' },
];

/** BCP 47 locale for dates and number formatting. */
export const LOCALE: Record<Lang, string> = { en: 'en-GB', de: 'de-DE', pl: 'pl-PL' };

let current: Lang = 'en';

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

export function isLang(value: unknown): value is Lang {
  return value === 'en' || value === 'de' || value === 'pl';
}

export type Params = Record<string, string | number>;

/**
 * Defines a module's messages. Placeholders use {name}: t('key', { name: 'x' }).
 * The English object is the source of truth for the key set.
 */
export function defineMessages<const E extends Record<string, string>>(messages: {
  en: E;
  de: Record<keyof E, string>;
  pl: Record<keyof E, string>;
}): (key: keyof E & string, params?: Params) => string {
  return (key, params) => {
    const text = messages[current][key] ?? messages.en[key] ?? key;
    return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : text;
  };
}

/** Date/time in the active language. */
export function formatDateTime(ts: number | undefined, style: 'short' | 'medium' = 'short'): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(LOCALE[current], { dateStyle: style, timeStyle: 'short' });
}
