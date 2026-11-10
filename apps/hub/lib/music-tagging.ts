import { musicGenreCategoryLabel, musicGenreLabel } from "@/lib/music-catalog";

export type MusicTagKind = "genre" | "era" | "language" | "region" | "mood" | "scene" | "tempo" | "feature" | "instrument" | "theme";
export type MusicTagSignal = {
  tag: string;
  kind: MusicTagKind;
  confidence: number;
  source: "metadata" | "rule" | "behavior";
};

type TaggableMusic = { title: string; artist: string; description?: string; genre: string; year: number; tags?: string[] };

function signal(tag: string, kind: MusicTagKind, confidence: number, source: MusicTagSignal["source"] = "rule"): MusicTagSignal {
  return { tag, kind, confidence: Math.max(0, Math.min(1, confidence)), source };
}

export function inferMusicTagSignals(work: TaggableMusic): MusicTagSignal[] {
  const genre = musicGenreLabel(work.genre);
  const category = musicGenreCategoryLabel(genre);
  const text = `${work.title} ${work.artist} ${work.description ?? ""} ${genre}`.normalize("NFKC").toLocaleLowerCase("ja-JP");
  const tags: MusicTagSignal[] = [
    signal(category, "genre", 1, "metadata"),
    ...(genre !== category ? [signal(genre, "genre", .98, "metadata")] : []),
    signal(`${Math.floor(work.year / 10) * 10}年代`, "era", 1, "metadata"),
  ];
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(`${work.title}${work.artist}`)) tags.push(signal("日本語", "language", .82), signal("日本", "region", .62));
  else if (/[a-z]/iu.test(text)) tags.push(signal("英語", "language", .68));
  const rules: Array<[RegExp, string, MusicTagKind, number]> = [
    [/(?:chill|lo-?fi|落ち着|relax|ambient)/iu, "落ち着く", "mood", .82],
    [/(?:happy|smile|party|festival|夏|summer)/iu, "明るい", "mood", .72],
    [/(?:sad|cry|涙|別れ|lonely)/iu, "切ない", "mood", .7],
    [/(?:night|midnight|夜|moon)/iu, "夜", "scene", .78],
    [/(?:drive|driving|road|ドライブ)/iu, "ドライブ", "scene", .84],
    [/(?:workout|gym|running|運動)/iu, "運動", "scene", .82],
    [/(?:sleep|眠|子守歌|lullaby)/iu, "睡眠", "scene", .86],
    [/(?:instrumental|インスト)/iu, "インスト", "feature", .9],
    [/(?:live|concert|ライブ)/iu, "ライブ", "feature", .76],
    [/(?:piano|ピアノ)/iu, "ピアノ", "instrument", .86],
    [/(?:guitar|ギター)/iu, "ギター", "instrument", .86],
    /*
     * The genre says which instrument leads, where the title almost never
     * does. Only one work in the catalogue mentioned a guitar by name, so
     * 「激しいギターの曲」 had nothing to filter on and fell through to a
     * nearby vector. Rock, metal, country and folk are guitar-led as genres:
     * 266 of 1,312 works, a fifth, which still separates them from the rest.
     *
     * Lower confidence than a title that says so outright, because this is
     * read from the kind of music and not from the record itself.
     */
    [/(?:ロック|メタル|カントリー|フォーク|rock|metal|country|folk)/iu, "ギター", "instrument", .64],
    [/(?:synth|シンセ|electro)/iu, "シンセ", "instrument", .72],
    /*
     * The same reading for electronic production: 227 works, a sixth. Piano
     * is deliberately absent — jazz and blues are the genres that would carry
     * it, and blues is as often a guitar (B.B. King is in this catalogue).
     * Tagging those works ピアノ would be stating something untrue.
     */
    [/(?:edm|ハウス|house|トラップ|trap|ダンス|dance|エレクトロニック)/iu, "シンセ", "instrument", .6],
    [/(?:love|恋|愛|heart)/iu, "恋愛", "theme", .74],
    [/(?:protest|political|社会|war|戦争)/iu, "社会", "theme", .72],
    [/(?:桜|さくら|春|spring)/iu, "春", "scene", .7],
    [/(?:夏|summer|海|beach)/iu, "夏", "scene", .7],
    [/(?:冬|雪|snow|winter|christmas|クリスマス)/iu, "冬", "scene", .72],
    [/(?:雨|rain)/iu, "雨", "scene", .68],
    [/(?:朝|morning|sunrise)/iu, "朝", "scene", .66],
    [/(?:応援|頑張|fight|cheer)/iu, "応援", "theme", .7],
    [/(?:青春|school|学校|卒業)/iu, "青春", "theme", .7],
    [/(?:旅|travel|journey|road)/iu, "旅", "theme", .66],
    [/(?:友|friend|仲間)/iu, "友情", "theme", .66],
    [/(?:家族|family|母|父)/iu, "家族", "theme", .66],
    [/(?:remix|リミックス)/iu, "リミックス", "feature", .88],
    [/(?:acoustic|アコースティック|unplugged)/iu, "アコースティック", "feature", .84],
    [/(?:cover|カバー)/iu, "カバー", "feature", .7],
    [/(?:feat.|ft.|featuring)/iu, "客演", "feature", .8],
    [/(?:violin|バイオリン|ヴァイオリン|strings)/iu, "弦楽器", "instrument", .8],
    [/(?:sax|サックス|trumpet|trombone|brass)/iu, "管楽器", "instrument", .8],
    [/(?:drum|ドラム|beat)/iu, "ドラム", "instrument", .62],
    [/(?:bass|ベース)/iu, "ベース", "instrument", .62],
  ];
  for (const [pattern, tag, kind, confidence] of rules) if (pattern.test(text)) tags.push(signal(tag, kind, confidence));
  const genreText = `${category} ${genre}`;
  /*
   * Derived rather than observed, so the confidence stays middling: enough
   * to be offered as a way in, not enough to be stated as fact about a song.
   */
  const genreMoods: Array<[RegExp, string, MusicTagKind, number]> = [
    [/(?:メタル|ハードロック|パンク|グランジ)/iu, "激しい", "mood", .68],
    [/(?:メタル|ハードロック|パンク)/iu, "運動", "scene", .58],
    [/(?:edm|ダンス|ハウス|テクノ|トランス|レゲトン)/iu, "踊れる", "mood", .7],
    [/(?:edm|ダンス|ハウス|テクノ|トランス)/iu, "パーティー", "scene", .6],
    [/(?:ジャズ|ブルース)/iu, "落ち着く", "mood", .68],
    [/(?:ジャズ|ブルース|ソウル)/iu, "夜", "scene", .58],
    [/(?:レゲエ|スカ)/iu, "陽気", "mood", .68],
    [/(?:レゲエ)/iu, "夏", "scene", .58],
    [/(?:r&b|ソウル)/iu, "大人っぽい", "mood", .64],
    [/(?:ヒップホップ|ラップ|トラップ)/iu, "力強い", "mood", .62],
    [/(?:カントリー|フォーク)/iu, "素朴", "mood", .66],
    [/(?:アンビエント|チル|ロー?ファイ|クラシック|バラード)/iu, "落ち着く", "mood", .72],
    [/(?:アンビエント|チル|ロー?ファイ|クラシック)/iu, "作業用", "scene", .66],
  ];
  for (const [pattern, tag, kind, confidence] of genreMoods) if (pattern.test(genreText)) tags.push(signal(tag, kind, confidence));
  if (/(?:edm|ダンス|ハウス|テクノ|ドラムンベース|パンク|メタル)/iu.test(genreText)) tags.push(signal("高速", "tempo", .72));
  else if (/(?:バラード|アンビエント|チル|クラシック)/iu.test(genreText)) tags.push(signal("低速", "tempo", .7));
  else tags.push(signal("中速", "tempo", .5));
  for (const manual of work.tags ?? []) tags.push(signal(manual, "theme", .55, "metadata"));
  return [...new Map(tags.map((item) => [`${item.kind}:${item.tag}`, item])).values()]
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 24);
}

export function effectiveMusicTags(work: TaggableMusic & { tagSignals?: MusicTagSignal[] }): string[] {
  const signals = work.tagSignals?.length ? work.tagSignals : inferMusicTagSignals(work);
  return signals.filter((item) => item.confidence >= .5).map((item) => item.tag);
}
