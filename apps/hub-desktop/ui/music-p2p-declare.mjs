// 自分の曲の「P2Pで配る」（docs/hub-p2p-redesign/DESIGN.md §9, §11）。曲ごとの選択で、初期値はオフ。
// 署名は端末の Rust が持つ根鍵で行い、窓には秘密鍵も署名器も渡らない。窓から送るのは曲の UUID と版だけ。
export const TRACK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const P2P_ON = 'P2Pで配る';
export const P2P_OFF = 'P2Pで配るのをやめる';
export const P2P_CONFIRM = 'この曲とあなたの鍵の結び付きが公開されます。P2Pで配りますか？';

const MESSAGES = {
  music_link_required: 'Web版でMusicを有効にしてください。',
  portable_identity_unavailable: '端末の鍵を使えません。',
  declaration_revision_changed: '曲が更新されました。もう一度操作してください。',
};
export const p2pMessage = (error) => {
  const code = String(error?.message ?? error ?? '').replace(/^media_unavailable:/u, '');
  return MESSAGES[code] ?? '操作できませんでした。';
};

const SYNC_MS = 10 * 60_000;

/**
 * deps: invoke / confirm(text)→bool / notice(text)。
 * autoSync: 一覧を読むついでに、端末の宣言・取り消しを Hub へ出し、フォロー中の作者の物を取り戻す（10 分に 1 回、失敗は黙って次回）。
 * 窓から渡すのは引数なしの 2 つの命令だけで、宛先・本文・鍵は全部 Rust 側にある（docs/hub-p2p-redesign/DESIGN.md §12）。
 */
export function createMusicP2pDeclaration({ invoke, confirm, notice, autoSync = false }) {
  const state = { ids: new Set(), loadedAt: 0, loading: null, syncedAt: 0, syncing: null };
  const sync = () => {
    if (state.syncing) return state.syncing;
    if (state.syncedAt && Date.now() - state.syncedAt < SYNC_MS) return Promise.resolve();
    state.syncedAt = Date.now();
    state.syncing = (async () => {
      for (const name of ['media_p2p_publish', 'media_p2p_fetch_declarations']) {
        try { await invoke(name); } catch { /* 未接続・圏外など。次の周期でやり直す */ }
      }
    })().finally(() => { state.syncing = null; });
    return state.syncing;
  };
  const load = () => {
    if (state.loading) return state.loading;
    if (Date.now() - state.loadedAt < 60_000) return Promise.resolve();
    state.loadedAt = Date.now();
    state.loading = (async () => {
      try {
        const result = await invoke('music_p2p_declared');
        state.ids = new Set((Array.isArray(result?.ids) ? result.ids : []).filter((id) => typeof id === 'string' && TRACK_ID.test(id)));
      } catch { state.ids = new Set(); } finally { state.loading = null; }
      if (autoSync) void sync();
    })();
    return state.loading;
  };
  return {
    sync,
    ready: () => state.loading ?? (Date.now() - state.loadedAt < 60_000 ? null : load()),
    /** eligible: 公開中・検査済みの自分の曲か。 */
    label(id, eligible) {
      void load();
      if (!TRACK_ID.test(id)) return null;
      if (state.ids.has(id)) return P2P_OFF;
      return eligible ? P2P_ON : null;
    },
    async run(id) {
      if (!TRACK_ID.test(id)) return;
      try {
        if (state.ids.has(id)) {
          await invoke('music_p2p_withdraw', { trackId: id });
          notice?.('P2Pで配るのをやめました。');
        } else {
          const prepared = await invoke('music_p2p_prepare', { trackId: id });
          if (!Number.isSafeInteger(prepared?.revision) || prepared.revision < 1) throw new Error('declaration_revision_changed');
          if (!confirm(P2P_CONFIRM)) return;
          await invoke('music_p2p_declare', { trackId: id, revision: prepared.revision });
          notice?.('P2Pで配ります。');
        }
      } catch (error) { notice?.(p2pMessage(error)); }
      state.loadedAt = 0;
      await load();
    },
  };
}
