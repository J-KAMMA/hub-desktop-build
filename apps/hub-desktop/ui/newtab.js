import { navigationTarget, SEARCH_ENGINES } from './browser-navigation.mjs';
import { greeting } from './newtab-model.mjs';

const $ = (selector) => document.querySelector(selector);
const invoke = (...args) => window.__TAURI__.core.invoke(...args);
const input = $('#newtab-url');
const status = $('#newtab-status');

function say(message) { status.textContent = message; status.hidden = false; }

$('#newtab-form').onsubmit = async (event) => {
  event.preventDefault();
  const value = input.value.trim();
  if (!value) return;
  let engine = 'google';
  try { engine = localStorage.getItem('hub.browser.searchEngine') || engine; } catch { /* preference is optional */ }
  let target;
  try { target = navigationTarget(value, engine); }
  catch { say('Webアドレスを確認してください。'); return; }
  status.hidden = true;
  try {
    await invoke('browser_navigate', { url: target });
  } catch {
    say('ページを開けませんでした。アドレスを確認してください。');
    input.focus();
  }
};

input.focus();

// 検索エンジンは今の設定のまま（外へ聞かない。確定したときだけ送る）。
let searchEngine = 'google';
try { searchEngine = localStorage.getItem('hub.browser.searchEngine') || searchEngine; } catch { /* optional */ }
const provider = SEARCH_ENGINES[searchEngine] ?? SEARCH_ENGINES.google;
$('#newtab-form label span').textContent = provider.label;
input.placeholder = `${provider.label}で検索、またはアドレスを入力`;
$('#newtab-search-note').textContent = `検索を確定すると${provider.label}へ送信します。入力中の文字は送信しません。`;

$('#newtab-restore').onclick = () => invoke('browser_restore_tab').catch(() => say('開き直せるタブはありません。'));

// ---- 右上の歯車（この端末だけに覚える） ----
const settingsButton = $('#newtab-settings');
const settingsPanel = $('#newtab-settings-panel');
const showStats = $('#newtab-show-stats');
const readFlag = (key) => { try { return localStorage.getItem(key) !== '0'; } catch { return true; } };
const writeFlag = (key, value) => { try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* optional */ } };
function applyLayout() {
  $('#newtab-stats').dataset.enabled = String(showStats.checked);
}
showStats.checked = readFlag('hub.newtab.showStats');
showStats.onchange = () => { writeFlag('hub.newtab.showStats', showStats.checked); applyLayout(); };
settingsButton.onclick = () => { settingsPanel.hidden = !settingsPanel.hidden; settingsButton.setAttribute('aria-expanded', String(!settingsPanel.hidden)); };
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !settingsPanel.hidden) { settingsPanel.hidden = true; settingsButton.setAttribute('aria-expanded', 'false'); settingsButton.focus(); } });
applyLayout();

// ---- 足元の1行: この起動中にブロックした件数（読み取りのみ） ----
async function renderStats() {
  const footer = $('#newtab-stats');
  try {
    const stats = await invoke('browser_newtab_stats');
    const count = Number.isSafeInteger(stats?.blockedCount) && stats.blockedCount >= 0 ? stats.blockedCount : null;
    if (count === null || stats.enabled !== true) { footer.hidden = true; return; }
    $('#newtab-stat-blocked').textContent = count.toLocaleString('ja-JP');
    footer.hidden = footer.dataset.enabled === 'false';
  } catch { footer.hidden = true; }
}
showStats.addEventListener('change', () => void renderStats());

// ---- あいさつと日時（この端末の時刻だけ。外へは何も聞かない） ----
function paintClock() {
  const now = new Date();
  $('#newtab-hello').textContent = greeting(now);
  const date = $('#newtab-date');
  date.textContent = now.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'long' });
  date.dateTime = now.toISOString().slice(0, 10);
  $('#newtab-time').textContent = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}
paintClock();
setTimeout(() => { paintClock(); setInterval(paintClock, 60_000); }, (60 - new Date().getSeconds()) * 1000);

void renderStats();
