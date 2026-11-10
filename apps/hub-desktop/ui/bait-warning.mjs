/*
 * 釣り文句の検出（純関数）。シードフレーズ・秘密鍵の要求、「ウォレットを接続して受け取り」、
 * 偽サポートの DM に当たる文を見つけて種類を返す。本文は隠さず、止めず、どこへも送らない。
 *
 * Hub 本体（apps/hub/lib/bait-warning.mjs）と Hub Desktop（apps/hub-desktop/ui/bait-warning.mjs）に
 * 同じ内容を置く。片方だけ直さない。apps/hub/lib/bait-warning.test.ts が 2 つの一致と、
 * 試験用の例文（bait-warning-corpus.json）での適合率を検査する。
 *
 * 通常の議論に当たらないよう、(1) 文ごとに見る、(2) 秘密の語に「送れ・入力しろ」の形が
 * 近接しているときだけ当てる、(3) 否定・注意喚起・質問・保管の話は外す。
 * 日本語は複合語（運営→自主運営、サポート→技術サポート）に当たらないよう否定後読みを使う。
 */

const SENTENCE = /[^。！？!?\n\r]+[。！？!?]?|\n/gu;

const NEG_JA = /ない(?:で|よう|こと)|ません|てはいけ|べからず|禁止|厳禁|詐欺|フィッシング|ご?注意|警告|聞かれ|求められ|求める(?:こと|はず)|尋ね|ご用心|被害|偽物|なりすまし|騙/u;
const DISCUSS_JA = /大丈夫|安全|危険|なぜ|どうして|なんで|必要(?:です|でしょう)か|しても(?:いい|よい|良い)|は何|とは|について|方法|やり方|仕組み|違い|保管|保存|管理|バックアップ|漏|盗|失く|無くし|なくし|紛失|忘れ|守っ|守る|隠/u;
const QUESTION_JA = /[?？]\s*$|(?:か|でしょうか|かな|ですかね)[。]?\s*$/u;
const REQUEST_END_JA = /て(?:ください|下さい|くれ|もらえ|ね|よ)|お願い|ませんか|てほしい/u;

const NEG_EN = /\b(?:never|don'?t|do not|doesn'?t|does not|won'?t|will not|should not|shouldn'?t|must not|not ask|no one|nobody|beware|scam|scams|scammers?|phishing|warning|avoid|stay safe|fake)\b/i;
const QUESTION_START_EN = /^\s*(?:how|what|why|where|which|is|are|does|do|should|can i|could i|will|would)\b/i;
const DISCUSS_EN = /\bb(?:restoring|backup|back up|store|storing|write (?:it |them )?down|offline|hardware wallet|new device|tutorial|guide|explain|explained|protocol)\b/i;

const SECRET_JA_SEED = /(?:seed ?phrases?|recovery ?phrases?|mnemonics?|シードフレーズ|シードワード|シード文|リカバリー?(?:フレーズ|ワード)|復元(?:フレーズ|ワード)|ニーモニック|マスターシード|(?:12|24)(?:個の)?単語|秘密のフレーズ)/iu;
const SECRET_JA_KEY = /(?:private ?keys?|秘密鍵|秘密キー|プライベートキー)/iu;
const GIVE_JA = "(?:教え|送(?:っ|信|り)|入力|共有|提出|提供|貼(?:っ|り)|見せ|知らせ|アップロード|返信|コピー)";

const SECRET_EN_SEED = "(?:seed(?:\\s|-)?phrases?|recovery\\s+(?:phrase|words?)|secret\\s+(?:recovery\\s+)?(?:phrase|words?)|mnemonics?(?:\\s+phrase)?|(?:12|24|twelve|twenty[- ]four)[\\s-]*words?)";
const SECRET_EN_KEY = "(?:private\\s+keys?)";
const GIVE_EN = "(?:send|share|give|enter|type|provide|submit|paste|input|dm|post|upload|reply with|tell me|show me)";

function giveEn(secret) {
  return [
    new RegExp(`\\b${GIVE_EN}\\b(?:\\s+\\S+){0,4}?\\s+${secret}\\b`, "i"),
    new RegExp(`\\b(?:need|want|require|requires|ask(?:ing)? for)\\s+(?:your|ur)\\s+${secret}\\b`, "i"),
    new RegExp(`\\b${secret}\\b[^.!?\\n]{0,25}?\\b(?:to verify|to validate|to confirm|is required|is needed|to proceed)\\b`, "i"),
  ];
}
const EN_SEED = giveEn(SECRET_EN_SEED);
const EN_KEY = giveEn(SECRET_EN_KEY);

const SYMPTOM_JA = /とき|場合|際に|固ま|エラー|できない|できず|うまく/u;
function secretJa(secret, sentence) {
  const re = new RegExp(`${secret.source}([^。！？\\n]{0,10}?)${GIVE_JA}`, "u");
  const m = re.exec(sentence);
  return Boolean(m) && !DISCUSS_JA.test(m[1]) && !SYMPTOM_JA.test(sentence);
}

const URL_RE = /https?:\/\/\S+|[a-z0-9-]+\.(?:com|net|org|io|app|xyz|top|site|club|info|co|me)\b/iu;
const SUPPORT_SELF_JA = /(?:公式|カスタマー|(?<![\p{Script=Han}ァ-ヶー]))(?:サポート|運営|管理者|モデレーター|ヘルプデスク|事務局)(?:チーム|担当|スタッフ|の者|センター)?(?:です|でございます|と申します|より|からの?(?:ご連絡|お知らせ|メッセージ))/u;
const SUPPORT_CO_JA = /ウォレット|本人確認|凍結|認証コード|認証が必要|シード|秘密鍵|アカウント(?:の)?(?:停止|凍結|制限)/u;
const SUPPORT_SELF_EN = /\b(?:this is|i['’]?m|i am|we are|we['’]?re)\s+(?:the\s+|an?\s+)?(?:official\s+)?(?:\w+\s+)?(?:support|admin|administrator|moderator|mod|helpdesk|help desk)(?:\s+(?:team|agent|staff))?\b/i;
const SUPPORT_CO_EN = /\bwallet\b|\bseed\b|\bprivate key\b|\b(?:account|wallet)\s+(?:has been |is |was )?(?:suspended|locked|restricted|compromised)\b|\bverify your\b|\bverification\b|\bvalidate\b/i;

const CONNECT_JA = /ウォレット[^。！？\n]{0,6}?(?:接続|連携|コネクト|認証|検証|同期|リンク)/u;
const LURE_JA = /受け取|請求|クレーム|エアドロ|報酬|特典|当選|ボーナス|無料|解除|復旧|修復|凍結/u;
const CLAIM_JA = /(?:エアドロップ|エアドロ|報酬|ボーナス|特典)(?:を|の)?(?:受け取|請求|クレーム|獲得|ゲット|受取)/u;
const CLAIM_IMPERATIVE_JA = /て(?:ください|下さい|ね)|はこちら|今すぐ|お急ぎ|クリック|アクセス|申請/u;
const CLAIM_LURE_JA = /こちら|今すぐ|リンク|DM|限定|無料|以内|期限|急い/u;

const CONNECT_EN = /\b(?:connect|link|sync|synchronize|validate|verify|rectify|resolve|authenticate)\s+(?:your\s+|ur\s+)?(?:crypto\s+)?wallet\b/i;
const LURE_EN = /\b(?:claim|airdrop|reward|rewards|bonus|free|unlock|restore|fix|rectify|resolve|issue|error|suspend(?:ed)?|won|winner|eligible)\b/i;
const WALLETCONNECT_EN = /\bwallet\s*connect(?:ion)?\b/i;
const WALLETCONNECT_LURE_EN = /\b(?:claim|verify|validate|airdrop|rectify|unlock)\b/i;
const WALLETCONNECT_CUE_EN = /\b(?:click|tap|press|select|use|via|here|below|link|visit|go to)\b|https?:\/\//i;
const CLAIM_EN = /\bclaim\s+(?:your|ur|the|free)\s+(?:free\s+)?(?:airdrop|rewards?|tokens?|bonus|nft|prize)\b/i;
const CLAIM_BEFORE_EN = /\b(?:can|could|how to|how do|to|will|may|should|did|have|when|you can)\s+$/i;
const CLAIM_LURE_EN = /\b(?:now|here|below|click|link|dm|limited|before|within|hurry|expires?|today|urgent)\b|https?:\/\//i;

function clean(text) {
  return text.normalize("NFKC").replace(/[​-‏⁠﻿]/gu, "");
}

/**
 * @param {string} text
 * @returns {{ flagged: boolean, kinds: Array<"seed"|"key"|"connect"|"claim"|"support"> }}
 */
export function detectBait(text) {
  const kinds = new Set();
  if (typeof text !== "string" || text.length < 6 || text.length > 20000) return { flagged: false, kinds: [] };
  const whole = clean(text);
  const hasUrl = URL_RE.test(whole);
  for (const raw of whole.match(SENTENCE) ?? []) {
    const s = raw.trim();
    if (s.length < 4) continue;
    const ja = /[぀-ヿ一-鿿]/u.test(s);
    const negJa = NEG_JA.test(s);
    const negEn = NEG_EN.test(s);
    const questionJa = QUESTION_JA.test(s) && !REQUEST_END_JA.test(s);
    const questionEn = QUESTION_START_EN.test(s);

    if (!negJa && !negEn) {
      if (secretJa(SECRET_JA_SEED, s)) kinds.add("seed");
      if (secretJa(SECRET_JA_KEY, s)) kinds.add("key");
      if (!QUESTION_START_EN.test(s) && !DISCUSS_EN.test(s)) {
        if (EN_SEED.some((re) => re.test(s))) kinds.add("seed");
        if (EN_KEY.some((re) => re.test(s))) kinds.add("key");
      }
      if (CONNECT_JA.test(s) && LURE_JA.test(s) && !questionJa && !DISCUSS_JA.test(s) && /[てで](?!す)|ください|お願い/u.test(s)) kinds.add("connect");
      if (CONNECT_EN.test(s) && LURE_EN.test(s) && !questionEn) kinds.add("connect");
      if (WALLETCONNECT_EN.test(s) && WALLETCONNECT_LURE_EN.test(s) && WALLETCONNECT_CUE_EN.test(s) && !questionEn) kinds.add("connect");
      if (CLAIM_JA.test(s) && CLAIM_IMPERATIVE_JA.test(s) && (hasUrl || CLAIM_LURE_JA.test(s)) && !questionJa) kinds.add("claim");
      const claim = CLAIM_EN.exec(s);
      if (claim && !CLAIM_BEFORE_EN.test(s.slice(Math.max(0, claim.index - 14), claim.index)) && !questionEn && (hasUrl || CLAIM_LURE_EN.test(whole))) kinds.add("claim");
      if (ja && SUPPORT_SELF_JA.test(s) && SUPPORT_CO_JA.test(whole)) kinds.add("support");
      if (!ja && SUPPORT_SELF_EN.test(s) && SUPPORT_CO_EN.test(whole)) kinds.add("support");
    }
  }
  const list = [...kinds];
  return { flagged: list.length > 0, kinds: list };
}

/** 警告行の文言。安全のための文なので 1 文だけ置く。 */
export const BAIT_LABELS = {
  icon: "⚠",
  short: "秘密鍵・シードフレーズ・ウォレット接続の要求に注意",
  notice: "Hubと運営は、シードフレーズや秘密鍵を尋ねることはありません。",
};
