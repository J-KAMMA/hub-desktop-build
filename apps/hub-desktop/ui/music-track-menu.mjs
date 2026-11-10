// 曲の「⋯」メニュー（作品ページを廃止した 2026-11-02）。曲の操作はすべてここに集める。
// メニュー本体は共通の右クリックメニュー（context-menu.mjs）。⋯ を押すと、その場所へ contextmenu を送って同じメニューを出す。
// ここは DOM と項目の組み立てだけを持ち、保存・投稿・報告の実処理は app.js から deps で受け取る。
import { youtubeSource } from './music-youtube.mjs';

export const HUB_TRACK = /^music:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const httpUrl = (value) => {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try { const url = new URL(value); return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null; } catch { return null; }
};

/** 「Spotifyで開く」「YouTubeで開く」。提供元が登録されているものだけ（最大2件）。 */
export function externalOpenLinks(work) {
  const services = Array.isArray(work?.services) ? work.services : [];
  const found = new Map();
  for (const service of services.slice(0, 12)) {
    if (!service || typeof service !== 'object') continue;
    const provider = service.provider === 'spotify' ? 'spotify' : service.provider === 'youtube' ? 'youtube' : null;
    const url = httpUrl(service.url);
    if (provider && url && !found.has(provider)) found.set(provider, url);
  }
  const playable = youtubeSource(work);
  if (!found.has('youtube') && playable) {
    const url = httpUrl(playable.service.url) ?? `https://www.youtube.com/watch?v=${playable.id}`;
    found.set('youtube', url);
  }
  const labels = { spotify: 'Spotifyで開く', youtube: 'YouTubeで開く' };
  return ['spotify', 'youtube'].filter((provider) => found.has(provider)).map((provider) => ({ label: labels[provider], url: found.get(provider) }));
}

/**
 * メニューの項目。deps: favorite(work) / addToPlaylist(work) / share(work) / report(work) / canReport(work) / openExternal(url) / enqueue(work) / profileAttribution({ label(work), run(work) }。任意)
 * 項目の順は固定：お気に入り・プレイリストに追加・投稿で紹介・作品を報告・（外部で開く）。公開曲だけ先頭に「次に再生」。
 */
export function musicMenuItems(work, deps) {
  if (!work || typeof work !== 'object') return [];
  const items = [];
  if (HUB_TRACK.test(String(work.id ?? '')) && typeof deps.enqueue === 'function') items.push({ label: '次に再生', run: () => deps.enqueue(work) }, '-');
  items.push(
    { label: 'お気に入り', run: () => deps.favorite(work) },
    { label: 'プレイリストに追加', run: () => deps.addToPlaylist(work) },
    { label: '投稿で紹介', run: () => deps.share(work) },
    { label: '作品を報告', disabled: deps.canReport ? !deps.canReport(work) : false, run: () => deps.report(work) },
  );
  // 自分の曲だけ。deps.profileAttribution が文言（無ければ null）と実行を返す（docs/hub-music-attribution/DESIGN.md）。
  const attribution = HUB_TRACK.test(String(work.id ?? '')) ? deps.profileAttribution?.label?.(work) : null;
  if (attribution) items.push('-', { label: attribution, run: () => deps.profileAttribution.run(work) });
  // 自分の曲の「P2Pで配る」。曲ごとの選択で初期値はオフ（docs/hub-p2p-redesign/DESIGN.md §11）。
  const p2p = HUB_TRACK.test(String(work.id ?? '')) ? deps.p2p?.label?.(work) : null;
  if (p2p) items.push(...(attribution ? [] : ['-']), { label: p2p, run: () => deps.p2p.run(work) });
  const links = externalOpenLinks(work);
  if (links.length) items.push('-', ...links.map((link) => ({ label: link.label, run: () => deps.openExternal(link.url) })));
  return items;
}

/** 行や札の右端に置く「⋯」。work は固定の作品か、押した時に作品を返す関数（再生中バー用）。 */
export function musicMenuButton(document, work, { className = '', label = '' } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `music-more btn-icon btn-ghost ${className}`.trim();
  button.textContent = '⋯';
  button.dataset.musicMenu = '';
  button.hubMusicWork = work;
  const resolved = typeof work === 'function' ? null : work;
  button.setAttribute('aria-label', label || `${resolved?.title ?? '曲'}のその他の操作`);
  button.setAttribute('aria-haspopup', 'menu');
  button.title = 'その他の操作';
  button.onclick = (event) => {
    event.stopPropagation();
    const rect = button.getBoundingClientRect();
    const view = document.defaultView;
    button.dispatchEvent(new view.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(rect.left) || 1, clientY: Math.round(rect.bottom) || 1 }));
  };
  return button;
}

/** 共通メニューに「⋯」の項目を登録する。右クリックでも ⋯ でも同じ項目。 */
export function registerMusicMenu(contextMenu, deps, { document = globalThis.document, readyTimeoutMs = 1500 } = {}) {
  const unregister = contextMenu?.register?.((target) => {
    const button = target?.closest?.('[data-music-menu]');
    if (!button) return null;
    const work = typeof button.hubMusicWork === 'function' ? button.hubMusicWork() : button.hubMusicWork;
    const items = musicMenuItems(work, deps);
    return items.length ? items : null;
  });
  // 自分の曲の「プロフィールに表示」は、状態を読み終えてから項目を決める。⋯に触れずに右クリック・キー操作で開いても欠けない。
  // deps.profileAttribution.ready(work) が（読み込み中・期限切れの時だけ）Promise を返す。最長 readyTimeoutMs だけ待って、
  // 同じ座標へ contextmenu を送り直す。読めなくても（時間切れ・失敗）メニューは出す。
  const resent = new WeakSet();
  const onContextMenu = (event) => {
    if (resent.has(event) || event.defaultPrevented) return;
    const target = event.target;
    const button = target?.closest?.('[data-music-menu]');
    if (!button || typeof deps.profileAttribution?.ready !== 'function') return;
    const work = typeof button.hubMusicWork === 'function' ? button.hubMusicWork() : button.hubMusicWork;
    if (!work || !HUB_TRACK.test(String(work.id ?? ''))) return;
    let pending;
    try { pending = deps.profileAttribution.ready(work); } catch { return; }
    if (!pending || typeof pending.then !== 'function') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const view = target.ownerDocument.defaultView;
    const { clientX, clientY } = event;
    const timeout = new Promise((resolve) => view.setTimeout(resolve, readyTimeoutMs));
    void Promise.race([Promise.resolve(pending).catch(() => {}), timeout]).then(() => {
      if (!target.isConnected) return;
      const again = new view.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY });
      resent.add(again);
      target.dispatchEvent(again);
    });
  };
  document?.addEventListener?.('contextmenu', onContextMenu, true);
  return () => { document?.removeEventListener?.('contextmenu', onContextMenu, true); unregister?.(); };
}
