// 「プロフィールに表示」「プロフィールから外す」（2026-11-03、docs/hub-music-attribution/DESIGN.md）。
// 流れ：Hub から問いかけを受け取る → Music / Commerce へ窓から直接送って証明を受け取る → 証明だけを Hub へ渡す。
// Hub は Music / Commerce への呼び出しを中継しない。ここは順序と文言だけを持ち、通信は deps（invoke と fetchProof）に任せる。
// 証明を取る道（fetchProof）が無い種類は、メニューに出さない（supports が false）。

const PURPOSES = ['music', 'market'];

const MESSAGES = {
  attribution_unavailable: 'この Hub ではプロフィールへの表示がまだ使えません。',
  invalid_attribution_proof: '証明を確認できませんでした。もう一度操作してください。',
  invalid_attribution_challenge: '確認の有効期限が切れました。もう一度操作してください。',
  attribution_proof_replayed: '確認が重複しました。もう一度操作してください。',
  already_attributed: 'この項目はほかのプロフィールに表示されています。',
  login_required: 'Hub への接続が必要です。',
  music_link_required: 'Music のアカウント連携が必要です。Web 版で Music を有効にしてください。',
  track_not_eligible: 'この曲は公開中ではないため、表示できません。',
  desktop_not_connected: 'このデスクトップがアカウントに接続されていません。',
};

export function attributionMessage(error) {
  const text = String(error?.message ?? error ?? '');
  const key = Object.keys(MESSAGES).find((name) => text.includes(name));
  return key ? MESSAGES[key] : 'プロフィールの表示を更新できませんでした。もう一度操作してください。';
}

/** deps: invoke / fetchProof: { music?: (id, challenge) => proof, market?: (id, challenge) => proof } */
export function createProfileAttribution({ invoke, fetchProof = {} }) {
  const check = (purpose) => { if (!PURPOSES.includes(purpose)) throw Error('invalid_purpose'); };
  return {
    supports: (purpose) => PURPOSES.includes(purpose) && typeof fetchProof[purpose] === 'function',
    async ids(purpose) {
      check(purpose);
      const data = await invoke('hub_client', { name: `attribution_${purpose}` });
      return Array.isArray(data?.ids) ? data.ids.filter((id) => typeof id === 'string') : [];
    },
    async show(purpose, id) {
      check(purpose);
      if (typeof fetchProof[purpose] !== 'function') throw Error('attribution_unsupported');
      const issued = await invoke('hub_client_action', { action: 'attribution_challenge', target: purpose });
      const challenge = issued?.challenge;
      if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(challenge)) throw Error('invalid_attribution_challenge');
      const proof = await fetchProof[purpose](id, challenge);
      if (typeof proof !== 'string' || !proof) throw Error('invalid_attribution_proof');
      await invoke('hub_client_action', { action: 'attribution_claim', target: purpose, options: { proof } });
    },
    async remove(purpose, id) {
      check(purpose);
      await invoke('hub_client_action', { action: 'attribution_remove', target: purpose, options: purpose === 'music' ? { trackId: id } : { productId: id } });
    },
  };
}

/** Commerce の出品者セッション（Rust が持つ）で証明を取る。Hub を通らない。 */
export const commerceProofFetcher = (invoke) => async (productId, challenge) => {
  const result = await invoke('commerce_seller_attribution_proof', { productId, challenge });
  return result?.proof;
};

/** Music の管理用アサーション（Rust が持つ）で証明を取る。Hub を通らない。窓へはトラックIDと問いかけだけが出入りする。 */
export const musicProofFetcher = (invoke) => async (trackId, challenge) => {
  const result = await invoke('music_attribution_proof', { trackId, challenge });
  return result?.proof;
};
