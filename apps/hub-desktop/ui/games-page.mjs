// ゲーム画面の本文の持ち主。木（games-tree.mjs）の route に合わせて、本文だけを描き替える。
// ゲームの画面はライブラリと起動だけを持つ（2026-11-02）。route：{page:'library'} / {page:'game', id}。
// ストアはマーケットのゲームの種別へ移った（market-games.mjs）。木の「ストア」はそこを開く入口で、この画面の route には来ない。
// 読み込みはしない（既存の invoke("games") の結果を setLocal で受けるだけ）。
import { renderLibraryGrid, renderLibraryEmpty, renderLibrarySkeleton, renderGamesEmpty, renderGameDetail } from './games-tiles.mjs';

function el(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * deps：asset(img, url) / launch(entry, button) / remove(entry, button) / add() / onRoute(route)
 * 返す go(route) は本文だけを替え、onRoute で木の select を呼ばせる。
 */
export function createGamesPage({ document, host, deps }) {
  const state = { route: { page: 'library' }, local: null, query: '' };
  let body = null;

  function sectionHead(title, withAdd) {
    const head = el(document, 'div', 'games-section-head');
    head.append(el(document, 'h3', 'games-section-title', title));
    if (withAdd && deps.add) {
      const add = el(document, 'button', 'btn btn-secondary', 'ゲームを追加');
      add.type = 'button';
      add.id = 'games-view-add';
      add.onclick = () => deps.add(add);
      head.append(add);
    }
    return head;
  }

  function render() {
    const { route } = state;
    body = el(document, 'div', 'games-main');
    if (route.page === 'game') {
      const game = state.local?.find(g => String(g.id) === String(route.id));
      const back = () => go({ page: 'library' });
      if (!game) {
        const missing = el(document, 'div');
        renderGamesEmpty(document, missing, { title: 'ゲームが見つかりません', body: '一覧から外されたか、まだ読み込めていません。', action: { label: 'ライブラリへ戻る', run: back } });
        body.append(missing);
      } else {
        const detail = el(document, 'div');
        renderGameDetail(document, detail, game, { kind: 'local', asset: deps.asset, back, launch: deps.launch, remove: deps.remove });
        body.append(detail);
      }
    } else {
      body.append(sectionHead('ライブラリ', Boolean(state.local?.length)));
      const list = el(document, 'div', 'games-local');
      const needle = state.query.trim().toLowerCase();
      const shown = (state.local ?? []).filter(g => !needle || g.title.toLowerCase().includes(needle));
      if (state.local === null) renderLibrarySkeleton(document, list);
      else if (!state.local.length) renderLibraryEmpty(document, list, { add: deps.add ? () => deps.add() : null });
      else if (!shown.length) renderGamesEmpty(document, list, { title: 'ゲームが見つかりません', body: '検索の言葉を変えてください。' });
      else renderLibraryGrid(document, list, shown, { open: game => go({ page: 'game', id: String(game.id) }) });
      body.append(list);
    }
    host.replaceChildren(body);
  }

  function go(route) {
    state.route = route.page === 'game' ? route : { page: 'library' };
    render();
    deps.onRoute?.(state.route);
  }

  return {
    go,
    route: () => state.route,
    setLocal(entries) { state.local = entries; render(); },
    setQuery(query) { state.query = String(query ?? ''); render(); },
    render,
  };
}
