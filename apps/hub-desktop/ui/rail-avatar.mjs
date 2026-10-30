// 左レールの「プロフィール」項目に出す本人の丸い画像。
// 画像は Hub 自身の avatar 経路（"/" 始まりの相対パス）だけを許す。外部 URL は頭字に落とす。
export function railAvatarModel(profile) {
  const name = String(profile?.displayName || profile?.handle || '').trim();
  const url = profile?.avatarUrl;
  const own = typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.includes('\\');
  const initial = name ? [...name][0].toUpperCase() : '?';
  return { src: own ? url : null, alt: name, initial };
}

// slot: #rail-profile-avatar。resolve(img, url) は app.js の hubAsset（origin を前置する）。
export function paintRailAvatar(slot, profile, resolve) {
  if (!slot) return;
  const model = railAvatarModel(profile);
  const doc = slot.ownerDocument;
  slot.replaceChildren();
  if (model.src) {
    const img = doc.createElement('img');
    img.width = 24; img.height = 24;
    img.setAttribute('loading', 'lazy'); img.setAttribute('decoding', 'async');
    img.alt = model.alt;
    img.addEventListener('error', () => { slot.classList.remove('has-image'); slot.replaceChildren(doc.createTextNode(model.initial)); }, { once: true });
    resolve(img, model.src);
    slot.classList.add('has-image');
    slot.append(img);
  } else {
    slot.classList.remove('has-image');
    slot.textContent = model.initial;
  }
}
