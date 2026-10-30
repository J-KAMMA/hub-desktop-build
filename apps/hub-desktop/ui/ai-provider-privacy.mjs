// 事業者ごとのデータ取り扱いの表示用データ。キーも会話も含まない。
// 出典のURLと確認日を必ず持つ。確認できていない項目は「未確認」と書き、推測で埋めない。
// apps/ai に同じ出典付きの表が入ったら、そちらに揃える（確認日を更新して照合する）。
export const UNCONFIRMED = '未確認';
export const CHECKED_ON = '2026-10-30';

// 各値は事業者の公式文書の記述だけから書く。fieldSources は項目ごとの出典URL。
const A_RET = 'https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data';
const A_TRAIN = 'https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training';
const O_DATA = 'https://developers.openai.com/api/docs/guides/your-data';
const G_TERMS = 'https://ai.google.dev/gemini-api/terms';

export const PRIVACY_TABLE = Object.freeze({
  anthropic: Object.freeze({
    label: 'Anthropic',
    training: '商用プロダクトの入出力は既定で学習に使わない（フィードバック報告や利用者が許可した場合は学習に使うことがある）',
    retention: '入出力は受領・生成から30日以内にバックエンドから自動削除（ゼロデータ保持契約など別の合意がある場合を除く）',
    optOut: UNCONFIRMED, region: UNCONFIRMED,
    fieldSources: Object.freeze({ training: A_TRAIN, retention: A_RET }),
    sources: Object.freeze([A_TRAIN, A_RET]), checkedOn: CHECKED_ON,
  }),
  openai: Object.freeze({
    label: 'OpenAI',
    training: 'API に送ったデータは、利用者が明示的に同意しない限り学習・改善に使わない',
    retention: '不正利用監視ログは既定で最長30日保持',
    optOut: 'ゼロデータ保持／変更済み不正利用監視は承認制で、監視ログから顧客の内容を除外できる',
    region: '保存先を選べる：米国、欧州（EEA+スイス）、豪州、カナダ、日本、インド、シンガポール、韓国、英国、UAE（一部は保存のみで処理は別。承認が要るものがある）',
    fieldSources: Object.freeze({ training: O_DATA, retention: O_DATA, optOut: O_DATA, region: O_DATA }),
    sources: Object.freeze([O_DATA]), checkedOn: CHECKED_ON,
  }),
  google: Object.freeze({
    label: 'Google（Gemini API）',
    training: '有料サービス：プロンプトと応答を製品改善に使わない。無料サービス：入出力を製品の提供・改善・開発に使い、人が読み注釈することがある',
    retention: '有料サービス：プロンプトと応答を限られた期間ログに残す（日数は規約に記載なし）。Google検索によるグラウンディングは30日',
    optOut: UNCONFIRMED,
    region: '有料サービス：データはGoogleまたはその代理が施設を持つどの国にも一時保存・キャッシュされうる。無料サービスは規約に記載なし',
    fieldSources: Object.freeze({ training: G_TERMS, retention: G_TERMS, region: G_TERMS }),
    sources: Object.freeze([G_TERMS]), checkedOn: CHECKED_ON,
  }),
});

const LOCAL = Object.freeze({ label: 'この端末内', training: '送信しない', retention: 'この端末内のみ', optOut: UNCONFIRMED, region: 'この端末', fieldSources: Object.freeze({}), sources: Object.freeze([]), checkedOn: CHECKED_ON });
const UNKNOWN = Object.freeze({ label: '接続先', training: UNCONFIRMED, retention: UNCONFIRMED, optOut: UNCONFIRMED, region: UNCONFIRMED, fieldSources: Object.freeze({}), sources: Object.freeze([]), checkedOn: CHECKED_ON });

/** kind: anthropic|openai|google|openai_compatible|local|pc|cli。表にないものは全項目「未確認」。 */
export function privacyFor(kind, { baseUrl = null } = {}) {
  if (kind === 'local') return LOCAL;
  if (kind === 'openai_compatible' && baseUrl) {
    try {
      const host = new URL(baseUrl).hostname;
      if (['localhost', '127.0.0.1', '[::1]'].includes(host) || host.endsWith('.localhost')) return LOCAL;
    } catch { /* fall through */ }
  }
  return PRIVACY_TABLE[kind] ?? UNKNOWN;
}

/** ピッカー用の1行。 */
export function privacyLabel(kind, options) {
  const p = privacyFor(kind, options);
  return `学習利用: ${p.training} / 保持: ${p.retention} / 地域: ${p.region}（確認日 ${p.checkedOn}）`;
}
