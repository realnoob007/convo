import { createTranslator, detectLocale, isLocale, type Locale } from "./i18n";

export type Theme = "light" | "dark";
export interface Preferences {
  theme: Theme;
  locale: Locale;
}
export const preferencesKey = "convo-preferences-v1";

export function parsePreferences(
  raw: string | null,
  languages: readonly string[],
): Preferences {
  const fallback: Preferences = {
    theme: "light",
    locale: detectLocale(languages),
  };
  if (!raw) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return fallback;
    const saved = value as Partial<Preferences>;
    return {
      theme:
        saved.theme === "dark" || saved.theme === "light"
          ? saved.theme
          : fallback.theme,
      locale: isLocale(saved.locale) ? saved.locale : fallback.locale,
    };
  } catch {
    return fallback;
  }
}

export function readPreferences(): Preferences {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(preferencesKey);
  } catch {
    /* Private storage may be unavailable. */
  }
  return parsePreferences(raw, navigator.languages);
}

export function writePreferences(preferences: Preferences) {
  localStorage.setItem(preferencesKey, JSON.stringify(preferences));
}

export function applyPreferences(preferences: Preferences) {
  document.documentElement.classList.toggle(
    "dark",
    preferences.theme === "dark",
  );
  document.documentElement.lang = preferences.locale;
  document.title = `Convo — ${createTranslator(preferences.locale)("Conversation studio")}`;
}
