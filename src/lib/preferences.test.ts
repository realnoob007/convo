import { describe, expect, it } from "vitest";
import { parsePreferences } from "./preferences";
import {
  createTranslator,
  detectLocale,
  locales,
  translateError,
} from "./i18n";
import { catalog } from "./i18n/catalog";

describe("workspace preferences", () => {
  it("restores explicit preferences instead of replacing them with OS defaults", () => {
    expect(
      parsePreferences('{"theme":"dark","locale":"es"}', ["zh-CN"]),
    ).toEqual({ theme: "dark", locale: "es" });
  });
  it("recovers corrupt or unsupported preferences independently", () => {
    for (const raw of [null, "broken", "null", "[]"]) {
      expect(parsePreferences(raw, ["ja-JP"])).toEqual({
        theme: "light",
        locale: "ja",
      });
    }
    expect(
      parsePreferences('{"theme":"dark","locale":"xx"}', ["zh-Hant-HK"]),
    ).toEqual({ theme: "dark", locale: "zh-TW" });
    expect(parsePreferences('{"theme":"olive","locale":"en"}', ["ja"])).toEqual(
      { theme: "light", locale: "en" },
    );
  });
  it("resolves regional language preferences and Chinese script variants", () => {
    expect(detectLocale(["fr-FR", "es-MX"])).toBe("es");
    expect(detectLocale(["zh-Hant"])).toBe("zh-TW");
    expect(detectLocale(["zh-HK"])).toBe("zh-TW");
    expect(detectLocale(["zh-SG"])).toBe("zh-CN");
    expect(detectLocale(["de"])).toBe("en");
  });
});

describe("interface translations", () => {
  it("includes every message and preserves interpolation parameters in all four translations", () => {
    const parameters = (s: string) =>
      [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
    for (const [source, translations] of Object.entries(catalog)) {
      expect(translations.length).toBe(locales.length - 1);
      for (const translation of translations) {
        expect(translation.trim(), source).not.toBe("");
        expect(parameters(translation), source).toEqual(parameters(source));
      }
    }
  });
  it("formats counts, singular forms and dynamic labels without changing inserted content", () => {
    const es = createTranslator("es");
    expect(es("{count} turns", { count: 1 })).toBe("1 intervención");
    expect(es("{count} turns", { count: 2 })).toBe("2 intervenciones");
    expect(
      createTranslator("en")("{count} samples selected", { count: 1 }),
    ).toBe("1 sample selected");
    expect(
      createTranslator("zh-CN")("{count} characters", { count: 10000 }),
    ).toBe("10,000 个字符");
    expect(
      createTranslator("ja")("{name} voice", { name: "Maya {count}" }),
    ).toBe("Maya {count} の声");
    expect(createTranslator("zh-TW")("Restore")).toBe("還原");
  });
  it("localizes provider and validation errors while keeping diagnostic details", () => {
    const t = createTranslator("zh-CN");
    expect(translateError("Choose a voice for Maya", t)).toBe(
      "请为 Maya 选择声音",
    );
    expect(
      translateError("OpenAI: API key is invalid (HTTP 401 Unauthorized)", t),
    ).toBe("OpenAI: API 密钥无效 (HTTP 401 Unauthorized)");
    expect(translateError("Unexpected I/O error", t)).toContain(
      "Unexpected I/O error",
    );
  });
});
