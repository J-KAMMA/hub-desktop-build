// 最初の描画の前に外観を適用する小さな同期スクリプト（CSPの 'self' で読み込む）。
// 規則は appearance.mjs の applyAppearance / loadAppearance と同じ。変えるときは両方と appearance.test.mjs を揃える。
(function () {
  var TEMPLATE_KEY = 'hub.desktop.template', APPEARANCE_KEY = 'hub.desktop.appearance';
  var IDS = { paper: 'light', charcoal: 'dark' };
  // やめたテンプレートは同じ明暗の今のテンプレートへ（appearance.mjs の RETIRED_TEMPLATES と同じ）。
  var RETIRED = { light: 'paper', ivory: 'paper', dark: 'charcoal', noir: 'charcoal', midnight: 'charcoal' };
  var template = 'device', crisp = false, textSize = 'normal', density = 'normal', reduce = false, clear = false;
  var storage = null, old = null, saved = null;
  try { storage = window.localStorage; } catch (e) { /* 保存が読めなければ既定 */ }
  function read(key) { try { return JSON.parse(storage.getItem(key) || 'null'); } catch (e) { return null; } }
  old = read(APPEARANCE_KEY);
  saved = read(TEMPLATE_KEY);
  if (saved && typeof saved === 'object') {
    if (saved.template === 'device' || IDS.hasOwnProperty(saved.template)) template = saved.template;
    else if (RETIRED.hasOwnProperty(saved.template)) template = RETIRED[saved.template];
    crisp = saved.crisp === true;
  } else if (old && typeof old === 'object') {
    // 旧い theme / palette から 1 度だけ移す: 明るい色は paper、暗い色は charcoal。
    var theme = old.theme === 'light' || old.theme === 'system' || old.theme === 'dark' ? old.theme : null;
    var gold = old.palette === 'gold-ivory';
    if (theme !== null || gold || old.palette === 'standard') {
      template = theme === 'system' ? 'device' : theme === 'light' ? 'paper' : 'charcoal';
      try { storage.setItem(TEMPLATE_KEY, JSON.stringify({ template: template, crisp: false })); } catch (e) { /* 書けなくてもこの起動では効く */ }
    }
  }
  if (old && typeof old === 'object') {
    if (old.textSize === 'large' || old.textSize === 'xlarge') textSize = old.textSize;
    if (old.density === 'roomy') density = 'roomy';
    reduce = old.reduceMotion === true;
    clear = old.reduceTransparency === true;
  }
  var dark = true;
  try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { /* 既定はダーク */ }
  var id = template === 'device' ? (dark ? 'charcoal' : 'paper') : template;
  var root = document.documentElement;
  root.setAttribute('data-template', id);
  root.setAttribute('data-theme', IDS[id]);
  root.setAttribute('data-theme-mode', template === 'device' ? 'system' : IDS[id]);
  if (crisp) root.setAttribute('data-crisp', '');
  root.setAttribute('data-text-size', textSize);
  root.setAttribute('data-density', density);
  if (reduce) root.setAttribute('data-motion', 'reduce');
  if (clear) root.setAttribute('data-transparency', 'reduce');
})();
