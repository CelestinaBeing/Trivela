import { createContext, useContext, useState, useCallback } from 'react';

export const SUPPORTED_LOCALES = {
  en: 'English',
  pcm: 'Nigerian Pidgin',
  yo: 'Yorùbá',
};

const I18nContext = createContext(null);

export function I18nProvider({ children, initialLocale = 'en' }) {
  const [locale, setLocale] = useState(initialLocale);
  const [catalog, setCatalog] = useState({});

  const loadLocale = useCallback(async (next) => {
    if (!SUPPORTED_LOCALES[next]) return;
    try {
      const mod = await import(`../locales/${next}.js`);
      setCatalog(mod.default ?? mod);
      setLocale(next);
    } catch {
      /* silently keep current locale if the file is missing */
    }
  }, []);

  const t = useCallback(
    (key, fallback = key) => catalog[key] ?? fallback,
    [catalog],
  );

  return I18nContext.Provider({ value: { locale, loadLocale, t }, children });
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}
