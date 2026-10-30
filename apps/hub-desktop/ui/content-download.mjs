// 作品のダウンロード許可（2026-10-17、Hub Desktop）。apps/hub/lib/content-download-policy.ts の表示側だけの移植。
// 可否はHubが押すたびにサーバー側で確かめる。ここは案内の文と、Hubの作品頁のURLを返すだけの純粋関数。
// ダウンロードそのものはHubの頁で行う（使い捨ての札と透かしはHubとMusicが持つ）。

export const DOWNLOAD_NONE_NOTICE = 'ダウンロードは許可されていません。再生・表示はできます。画面の録画や録音は防げません。';
export const DOWNLOAD_WATERMARK_NOTICE = 'ダウンロードしたファイルには、ダウンロードごとの番号が入ります。名前やウォレットは入りません。';

const TRACK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Music の公開曲が「誰でも」なら true。未知の値・欠けた値は false（閉じる側）。 */
export function musicDownloadAllowed(work) {
  return work?.downloadPolicy === 'anyone';
}

/** ダウンロードの釦が開くHubの作品頁。origin が http(s) でない・IDが曲でなければ null。 */
export function musicDownloadPageUrl(origin, trackId) {
  if (typeof origin !== 'string' || !/^https?:\/\/[^/]+$/u.test(origin.replace(/\/$/u, ''))) return null;
  if (typeof trackId !== 'string' || !TRACK_ID.test(trackId)) return null;
  return `${origin.replace(/\/$/u, '')}/v2/music/works/${encodeURIComponent(`music:${trackId}`)}`;
}
