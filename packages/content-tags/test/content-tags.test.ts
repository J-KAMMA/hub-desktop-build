import { describe, expect, it } from "vitest";
import {
  TAG_MAX_LENGTH,
  TAG_MAX_PER_ITEM,
  normalizeTag,
  normalizeTagList,
  splitTagInput,
  tagKey,
  tagKeyFromSlug,
  tagSlug,
} from "../src/index";

describe("normalizeTag", () => {
  it("unifies full-width and half-width", () => {
    expect(normalizeTag("ＡＩ")).toEqual({ key: "ai", display: "AI" });
    expect(normalizeTag("ﾗｲﾃｨﾝｸﾞ")?.display).toBe("ライティング");
    expect(tagKey("１２３")).toBe("123");
  });
  it("folds case beyond ASCII", () => {
    expect(tagKey("Ä")).toBe("ä");
    expect(tagKey("ÉCOLE")).toBe("école");
    expect(tagKey("Привет")).toBe("привет");
    expect(tagKey("Σίσυφος")).toBe(tagKey("ΣΊΣΥΦΟΣ"));
    expect(tagKey("Straße")).toBe(tagKey("STRASSE"));
    expect(normalizeTag("Ä")?.display).toBe("Ä");
  });
  it("key is idempotent", () => {
    for (const s of ["Straße", "ΣΊΣΥΦΟΣ", "İstanbul", "ＡＩ", "J-POP"]) {
      const k = tagKey(s)!;
      expect(tagKey(k)).toBe(k);
    }
  });
  it("strips leading # and full-width #", () => {
    expect(normalizeTag("#AI")?.key).toBe("ai");
    expect(normalizeTag("＃ＡＩ")?.key).toBe("ai");
    expect(normalizeTag("##ai")?.key).toBe("ai");
    expect(normalizeTag("#")).toBeNull();
    expect(normalizeTag("a#b")).toBeNull();
  });
  it("trims and removes invisible characters", () => {
    expect(normalizeTag("  ai  ")?.display).toBe("ai");
    expect(normalizeTag("a​i")?.display).toBe("ai");
    expect(normalizeTag("a­i⁠")?.display).toBe("ai");
    expect(normalizeTag("​‍")).toBeNull();
    expect(normalizeTag("﻿ai")?.display).toBe("ai");
  });
  it("rejects control chars, internal whitespace and separators", () => {
    expect(normalizeTag("a\u0000b")).toBeNull();
    expect(normalizeTag("a\u0007b")).toBeNull();
    expect(normalizeTag("a\tb")).toBeNull();
    expect(normalizeTag("a b")).toBeNull();
    expect(normalizeTag("a,b")).toBeNull();
    expect(normalizeTag("a、b")).toBeNull();
    expect(normalizeTag("a，b")).toBeNull();
    expect(normalizeTag(42)).toBeNull();
    expect(normalizeTag("")).toBeNull();
  });
  it("keeps the middle dot inside a tag", () => {
    expect(normalizeTag("ライティング・翻訳")?.display).toBe("ライティング・翻訳");
  });
  it("enforces 32 code points after normalisation", () => {
    expect(normalizeTag("a".repeat(32))).not.toBeNull();
    expect(normalizeTag("a".repeat(33))).toBeNull();
    expect(normalizeTag("#" + "あ".repeat(32))).not.toBeNull();
    expect(normalizeTag("あ".repeat(33))).toBeNull();
    expect(normalizeTag("Ａ".repeat(32))).not.toBeNull();
    expect(TAG_MAX_LENGTH).toBe(32);
  });
  it("is surrogate and emoji safe", () => {
    expect(normalizeTag("😀".repeat(32))).not.toBeNull();
    expect(normalizeTag("😀".repeat(33))).toBeNull();
    expect(normalizeTag("𠮷野家")?.display).toBe("𠮷野家");
    expect(normalizeTag("a\ud800")).toBeNull();
    expect(normalizeTag("\udc00a")).toBeNull();
    expect(normalizeTag("👨‍👩‍👧")?.display).toBe("👨‍👩‍👧");
    expect(normalizeTag("👨‍‍👩")?.display).toBe("👨‍👩");
    expect(normalizeTag("👍‍")?.display).toBe("👍");
    expect(normalizeTag("❤️")?.display).toBe("❤️");
  });
});

describe("splitTagInput", () => {
  it("splits on whitespace, comma, 、 and ，", () => {
    expect(splitTagInput("a b,c、d，e\nf　g")).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(splitTagInput("a,, ,b")).toEqual(["a", "b"]);
    expect(splitTagInput("")).toEqual([]);
  });
  it("handles half-width ideographic comma and keeps the middle dot", () => {
    expect(splitTagInput("a､b")).toEqual(["a", "b"]);
    expect(splitTagInput("ロック・ポップ jazz")).toEqual(["ロック・ポップ", "jazz"]);
  });
});

describe("normalizeTagList", () => {
  it("dedupes by key and keeps the first display form", () => {
    expect(normalizeTagList(["AI", "ａｉ", "#ai", "Ai"])).toEqual([{ key: "ai", display: "AI" }]);
  });
  it("accepts free text and arrays containing separators", () => {
    expect(normalizeTagList("#Rock、J-POP ロック・ポップ").map((t) => t.key)).toEqual([
      "rock",
      "j-pop",
      "ロック・ポップ",
    ]);
    expect(normalizeTagList(["a b", "c"]).map((t) => t.key)).toEqual(["a", "b", "c"]);
  });
  it("drops invalid entries and non-strings", () => {
    expect(normalizeTagList(["ok", "x".repeat(40), 3, null, "#"] as unknown[]).map((t) => t.key)).toEqual(["ok"]);
  });
  it("caps at 8 (dedupe happens before the cap)", () => {
    const many = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(normalizeTagList(many)).toHaveLength(TAG_MAX_PER_ITEM);
    expect(normalizeTagList(["a", "A", ...many.slice(0, 8)]).map((t) => t.key)).toEqual([
      "a", "t0", "t1", "t2", "t3", "t4", "t5", "t6",
    ]);
    expect(normalizeTagList(many, 3)).toHaveLength(3);
  });
});

describe("slug", () => {
  it("round-trips keys, including non-ASCII", () => {
    for (const s of ["AI", "ロック・ポップ", "Ä", "😀", "j-pop", "c++", "a/b"]) {
      const slug = tagSlug(s)!;
      expect(slug).toMatch(/^[A-Za-z0-9\-_.!~*'()%]+$/);
      expect(tagKeyFromSlug(slug)).toBe(tagKey(s));
    }
  });
  it("any spelling yields the same slug", () => {
    expect(tagSlug("ＡＩ")).toBe(tagSlug("#ai"));
  });
  it("never produces dot segments or path separators", () => {
    expect(tagSlug(".")).toBe("%2E");
    expect(tagSlug("..")).toBe("%2E%2E");
    expect(tagSlug("a/b")).toBe("a%2Fb");
  });
  it("rejects bad slugs", () => {
    expect(tagSlug("a b")).toBeNull();
    expect(tagKeyFromSlug("%E0%A4%A")).toBeNull();
    expect(tagKeyFromSlug("%ZZ")).toBeNull();
    expect(tagKeyFromSlug("")).toBeNull();
  });
});
