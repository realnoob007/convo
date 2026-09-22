import { catalog } from "./catalog";

export const locales = [
  ["en", "English"],
  ["es", "Español"],
  ["zh-CN", "简体中文"],
  ["zh-TW", "繁體中文"],
  ["ja", "日本語"],
] as const;
export type Locale = (typeof locales)[number][0];
export const isLocale = (value: unknown): value is Locale =>
  locales.some(([id]) => id === value);

export function detectLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const tag = language.toLowerCase();
    if (tag === "zh" || tag.startsWith("zh-")) {
      return /hant|tw|hk|mo/.test(tag) ? "zh-TW" : "zh-CN";
    }
    for (const id of ["en", "es", "ja"] as const) {
      if (tag === id || tag.startsWith(`${id}-`)) return id;
    }
  }
  return "en";
}

export function createTranslator(locale: Locale) {
  const index = locales.findIndex(([id]) => id === locale) - 1;
  const numbers = new Intl.NumberFormat(locale);
  return (message: string, values: Record<string, string | number> = {}) => {
    const entry = Object.hasOwn(catalog, message)
      ? catalog[message as keyof typeof catalog]
      : undefined;
    let translated: string = index < 0 || !entry ? message : entry[index];
    if (values.count === 1 && (locale === "en" || locale === "es")) {
      const singular: Record<string, [string, string]> = {
        "{count} voices · available in every project": [
          "{count} voice · available in every project",
          "{count} voz · disponible en todos los proyectos",
        ],
        "{count} characters": ["{count} character", "{count} carácter"],
        "{count} chars": ["{count} char", "{count} car."],
        "{count} turns": ["{count} turn", "{count} intervención"],
        "{count} PEOPLE": ["{count} PERSON", "{count} PERSONA"],
        "{count} samples · {size} MB / 50 MB": [
          "{count} sample · {size} MB / 50 MB",
          "{count} muestra · {size} MB / 50 MB",
        ],
        "{count} samples selected": [
          "{count} sample selected",
          "{count} muestra seleccionada",
        ],
      };
      translated = singular[message]?.[locale === "en" ? 0 : 1] ?? translated;
    }
    return translated.replace(/\{(\w+)\}/g, (placeholder, key: string) => {
      const value = values[key];
      return value === undefined
        ? placeholder
        : typeof value === "number"
          ? numbers.format(value)
          : value;
    });
  };
}

export function translateError(
  error: string,
  t: ReturnType<typeof createTranslator>,
): string {
  if (Object.hasOwn(catalog, error)) return t(error);
  const patterns: [RegExp, string, string][] = [
    [
      /^Add your (.+) API key in Settings$/,
      "Add your {provider} API key in Settings",
      "provider",
    ],
    [/^Choose a voice for (.+)$/, "Choose a voice for {name}", "name"],
    [
      /^(.+) needs voice verification in ElevenLabs$/,
      "{name} needs voice verification in ElevenLabs",
      "name",
    ],
    [/^Turn (\d+) is empty$/, "Turn {number} is empty", "number"],
    [
      /^Turn (\d+) exceeds 2,000 characters including direction; split this turn$/,
      "Turn {number} exceeds 2,000 characters including direction; split this turn",
      "number",
    ],
  ];
  for (const [pattern, key, parameter] of patterns) {
    const match = error.match(pattern);
    if (match)
      return t(key, {
        [parameter]: parameter === "number" ? Number(match[1]) : match[1],
      });
  }
  const providerError = error.match(
    /^(OpenAI|ElevenLabs): (.+) \(HTTP (.+)\)$/,
  );
  if (providerError)
    return `${providerError[1]}: ${t(providerError[2])} (HTTP ${providerError[3]})`;
  return t("Something went wrong. Details: {details}", { details: error });
}
