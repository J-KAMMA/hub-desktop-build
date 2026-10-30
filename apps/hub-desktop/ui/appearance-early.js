// 最初の描画の前に外観を適用する小さな同期スクリプト（CSPの 'self' で読み込む）。
// 規則は appearance.mjs の applyAppearance と同じ。変えるときは両方と appearance.test.mjs を揃える。
(function () {
  var theme = 'dark', palette = 'standard', textSize = 'normal', density = 'normal', reduce = false, clear = false;
  try {
    var raw = JSON.parse(window.localStorage.getItem('hub.desktop.appearance') || 'null');
    if (raw && typeof raw === 'object') {
      if (raw.theme === 'light' || raw.theme === 'system') theme = raw.theme;
      if (raw.palette === 'gold-ivory') palette = 'gold-ivory';
      if (raw.textSize === 'large' || raw.textSize === 'xlarge') textSize = raw.textSize;
      if (raw.density === 'roomy') density = 'roomy';
      reduce = raw.reduceMotion === true;
      clear = raw.reduceTransparency === true;
    }
  } catch (e) { /* 保存が読めなければ既定 */ }
  var dark = true;
  try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { /* 既定はダーク */ }
  var root = document.documentElement;
  root.setAttribute('data-theme', theme === 'light' ? 'light' : theme === 'system' ? (dark ? 'dark' : 'light') : 'dark');
  root.setAttribute('data-theme-mode', theme);
  if (palette === 'gold-ivory') root.setAttribute('data-palette', 'gold-ivory');
  root.setAttribute('data-text-size', textSize);
  root.setAttribute('data-density', density);
  if (reduce) root.setAttribute('data-motion', 'reduce');
  if (clear) root.setAttribute('data-transparency', 'reduce');
})();
