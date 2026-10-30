// 記事の読了時間（Hub Desktop）。apps/hub/lib/article-reading.ts と同じ数え方の移植。
// 日本語は1分あたり約550字、英語は1分あたり約220語。記号と空白は数えない。
// 解析器ではない（本文の文法は article-body.mjs だけが持つ）。純粋関数のみ。

const CHARS_PER_MINUTE = 550;
const WORDS_PER_MINUTE = 220;
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/gu;
const LATIN_WORD = /[A-Za-z0-9À-ɏ]+(?:['’-][A-Za-z0-9À-ɏ]+)*/gu;

function stripMarkup(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/\S+/gu, '')
    .replace(/^\s*(?:#{1,6}|>|-)\s+/gmu, '');
}

export function articleReadingMinutes(text) {
  const cleaned = stripMarkup(typeof text === 'string' ? text : '');
  const characters = (cleaned.match(CJK) ?? []).length;
  const words = (cleaned.replace(CJK, ' ').match(LATIN_WORD) ?? []).length;
  if (characters === 0 && words === 0) return 0;
  return Math.max(1, Math.ceil(characters / CHARS_PER_MINUTE + words / WORDS_PER_MINUTE));
}

export function articleReadingLabel(minutes) {
  return Number.isFinite(minutes) && minutes > 0 ? `約${minutes}分で読めます` : null;
}
