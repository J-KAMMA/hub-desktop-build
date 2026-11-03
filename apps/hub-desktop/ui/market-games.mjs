// マーケットのゲームの種別の本文（2026-11-02、ゲームのストアをマーケットへ統合）。
// 一覧はこれまでのストアと同じ読み（hub_resource games_store の結果を setStore で受ける。ここでは読み込まない）。
// 作品を押すとアプリ内の詳細（絵・要約・機種・発売日）を開き、購入・入手はWebのマーケットの商品頁（Commerce の道）へ渡す。
import { filterStoreGames, renderStoreGames, renderStoreLoading, renderStoreError } from './games-view.mjs';
import { renderGameDetail } from './games-tiles.mjs';

/** deps：asset(img, url) / openWeb(game) / reloadStore()。 */
export function createMarketGames({ document, host, deps }) {
  const state = { store: { status: 'idle', games: [], message: '' }, query: '', slug: null };

  function render() {
    const body = document.createElement('div');
    body.className = 'games-main';
    if (state.slug !== null) {
      const game = state.store.games.find(item => item.slug === state.slug);
      const back = () => { state.slug = null; render(); };
      const detail = document.createElement('div');
      if (game) renderGameDetail(document, detail, game, { kind: 'store', asset: deps.asset, back, openWeb: deps.openWeb });
      else { back(); return; }
      body.append(detail);
    } else {
      const list = document.createElement('div');
      list.className = 'games-store';
      if (state.store.status === 'loading' || state.store.status === 'idle') renderStoreLoading(document, list);
      else if (state.store.status === 'error') renderStoreError(document, list, state.store.message, deps.reloadStore);
      else renderStoreGames(document, list, filterStoreGames(state.store.games, state.query), { asset: deps.asset, open: game => { state.slug = game.slug; render(); }, retry: deps.reloadStore });
      body.append(list);
    }
    host.replaceChildren(body);
  }

  return {
    render,
    slug: () => state.slug,
    setStore(next) { state.store = { status: 'idle', games: [], message: '', ...next }; render(); },
    setQuery(query) { state.query = String(query ?? ''); state.slug = null; render(); },
    /** 種別を開き直したときは一覧へ戻す。 */
    showList() { state.slug = null; render(); },
  };
}
