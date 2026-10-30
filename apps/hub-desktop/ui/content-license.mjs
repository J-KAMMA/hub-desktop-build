// 作品のライセンス表示（Hub Desktop）。apps/hub/lib/content-license.ts の表示側だけの移植。
// 選択と保存はHubが持つ。ここは表示名と公式の頁のURLを返すだけの純粋関数。
const LABELS = {
  arr: 'All rights reserved',
  'cc-by-4.0': 'CC BY 4.0',
  'cc-by-sa-4.0': 'CC BY-SA 4.0',
  'cc-by-nc-4.0': 'CC BY-NC 4.0',
  'cc-by-nc-sa-4.0': 'CC BY-NC-SA 4.0',
  'cc-by-nd-4.0': 'CC BY-ND 4.0',
  'cc-by-nc-nd-4.0': 'CC BY-NC-ND 4.0',
  'cc0-1.0': 'CC0 1.0',
};
const DEEDS = {
  'cc-by-4.0': 'licenses/by/4.0/',
  'cc-by-sa-4.0': 'licenses/by-sa/4.0/',
  'cc-by-nc-4.0': 'licenses/by-nc/4.0/',
  'cc-by-nc-sa-4.0': 'licenses/by-nc-sa/4.0/',
  'cc-by-nd-4.0': 'licenses/by-nd/4.0/',
  'cc-by-nc-nd-4.0': 'licenses/by-nc-nd/4.0/',
  'cc0-1.0': 'publicdomain/zero/1.0/',
};

export function isContentLicense(value) {
  return typeof value === 'string' && Object.hasOwn(LABELS, value);
}

/** CC の表示名。全権利留保・未指定・未知の値は null（何も足さない）。 */
export function openLicenseLabel(value) {
  return isContentLicense(value) && value !== 'arr' ? LABELS[value] : null;
}

/** 公式の頁（日本語）。CC 以外は null。 */
export function licenseDeedUrl(value) {
  return isContentLicense(value) && Object.hasOwn(DEEDS, value) ? `https://creativecommons.org/${DEEDS[value]}deed.ja` : null;
}
