import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { renderPiWorkHistory } from './pi-work-history.mjs';
const { JSDOM } = createRequire(process.env.HUB_TEST_PACKAGE ?? new URL('../../../package.json',import.meta.url))('jsdom');
const entry = (id, workspace, extra = {}, kind = 'hub') => ({ kind, run: { id, workspace, prompt: `依頼 ${id}`, model: 'local/model', status: 'done', startedAtMs: 1000, ...extra } });
function render(entries, options = {}) {
  const dom = new JSDOM('<main></main>'), root = dom.window.document.querySelector('main'), selected = [];
  const nodes = renderPiWorkHistory({ document: dom.window.document, entries, onSelect: value => selected.push(value), ...options }); root.append(...nodes);
  return { dom, root, selected, nodes, groups: [...root.querySelectorAll('details')], rows: [...root.querySelectorAll('.piw-history-item')] };
}
const toggle = (f, group, open) => { group.open = open; group.dispatchEvent(new f.dom.window.Event('toggle')); };

test('same basename remains distinct with full literal workspace path/title', () => {
  const f = render([entry('a', '/one/project'), entry('b', '/two/project')]);
  assert.equal(f.groups.length, 2);
  assert.deepEqual([...f.root.querySelectorAll('.piw-history-project-name')].map(n => n.textContent), ['project', 'project']);
  assert.deepEqual([...f.root.querySelectorAll('.piw-history-project-head')].map(n => n.title), ['/one/project', '/two/project']); assert.equal(f.root.querySelector('.piw-history-project-path'), null);
  assert.deepEqual(f.groups.map(g => g.dataset.workspaceKey), ['posix:/one/project', 'posix:/two/project']); f.dom.window.close();
});
test('Windows drive/UNC casefold and slash normalization, POSIX case preserved', () => {
  const f = render([entry('a', 'C:\\Work\\Project'), entry('b', 'c:/work/project/'), entry('c', '\\\\SERVER\\Share\\Folder'), entry('d', '//server/share/folder/'), entry('e', '/work/Project'), entry('f', '/work/project'), entry('g', '/work/a\\b'), entry('h', '/work/a/b')]);
  assert.equal(f.groups.length, 6);
  assert.deepEqual(f.groups.slice(0, 2).map(g => [...g.querySelectorAll('.piw-history-item')].map(b => b.dataset.runId)), [['a', 'b'], ['c', 'd']]);
  assert.notEqual(f.groups[2].dataset.workspaceKey, f.groups[3].dataset.workspaceKey);
  assert.notEqual(f.groups[4].dataset.workspaceKey, f.groups[5].dataset.workspaceKey); f.dom.window.close();
});
test('lexical grouping does not resolve dot components or relative filesystem paths', () => {
  const f = render([entry('a', '/work/../project'), entry('b', '/project'), entry('c', './project'), entry('d', '/work/./project')]); assert.equal(f.groups.length, 4); f.dom.window.close();
});
test('missing/invalid workspace shares distinct unknown group, never stringifies objects', () => {
  const f = render([entry('a', null), entry('b', ''), entry('c', '   '), entry('d', {}), entry('e', 'bad\npath'), entry('f', '\ud800'), entry('g', '/作業フォルダ不明')]);
  assert.equal(f.groups.length, 2); assert.equal(f.groups[0].dataset.workspaceKey, 'unknown:'); assert.equal(f.groups[0].querySelectorAll('.piw-history-item').length, 6); assert.equal(f.groups[0].querySelector('.piw-history-project-head').title, '作業フォルダ不明'); assert.doesNotMatch(f.root.textContent, /object Object/); f.dom.window.close();
});
test('approval then running then terminal priority, descending valid dates and stable ties', () => {
  const f = render([entry('done', '/p', { startedAtMs: 9000 }), entry('run-old', '/p', { status: 'running', startedAtMs: 100 }), entry('approve', '/p', { pendingActions: [{}], startedAtMs: 1 }), entry('run-new', '/p', { status: 'running', startedAtMs: 200 }), entry('tie1', '/p', { startedAtMs: 1000 }), entry('tie2', '/p', { startedAtMs: 1000 }), entry('bad', '/p', { startedAtMs: Infinity })]);
  assert.deepEqual(f.rows.map(r => r.dataset.runId), ['approve', 'run-new', 'run-old', 'done', 'tie1', 'tie2', 'bad']); assert.match(f.rows[0].title, /承認待ち 1件/); f.dom.window.close();
});
test('hub verification label and CLI lifecycle semantics, weird CLI status fallback', () => {
  const f = render([entry('verified', '/p', { verification: { status: 'passed' } }), entry('failed-verification', '/p', { verification: { status: 'failed' } }), entry('cli', '/p', { agent: 'codex', status: 'failed' }, 'cli'), entry('odd', '/p', { agent: 'other', status: { malicious: true } }, 'cli')]);
  assert.match(f.rows[0].title, /指定検証に合格/); assert.match(f.rows[1].title, /返答終了/); assert.doesNotMatch(f.rows[1].title, /検証に合格/); assert.match(f.rows[2].title, /CLI · 失敗 · codex/); assert.match(f.rows[3].title, /CLI · 不明 · other/); assert.doesNotMatch(f.root.textContent, /object Object/); f.dom.window.close();
});
test('hostile markup stays literal in prompt/path/model/status, creates no active markup', () => {
  const hostile = '<img src=x onerror="boom()"><script>boom()</script>';
  const f = render([entry('a', `/work/${hostile}`, { prompt: hostile, model: hostile, status: hostile })]);
  assert.match(f.rows[0].textContent, /<script>boom\(\)<\/script>/); assert.ok(f.rows[0].title.startsWith(hostile)); assert.equal(f.root.querySelectorAll('img,script').length, 0); assert.equal(f.root.querySelector('.piw-history-project-head').title, `/work/${hostile}`); f.dom.window.close();
});
test('invalid/out-of-range/non-number dates are harmless; epoch and negatives valid', () => {
  const f = render([entry('nan', '/p', { startedAtMs: NaN }), entry('range', '/p', { startedAtMs: 8.64e15 + 1 }), entry('string', '/p', { startedAtMs: '1000' }), entry('zero', '/p', { startedAtMs: 0 }), entry('negative', '/p', { startedAtMs: -1 })]);
  for (const id of ['nan', 'range', 'string']) assert.match(f.rows.find(r => r.dataset.runId === id).title, /日時不明/);
  for (const id of ['zero', 'negative']) assert.doesNotMatch(f.rows.find(r => r.dataset.runId === id).title, /日時不明/); f.dom.window.close();
});
test('exact entry identity and distinct hub/CLI same run id, selection only Hub', () => {
  const hub = entry('same', '/p'), cli = entry('same', '/p', { agent: 'codex' }, 'cli'); const f = render([hub, cli], { selectedId: 'same' });
  assert.equal(f.rows[0].dataset.kind, 'hub'); assert.equal(f.rows[1].dataset.kind, 'cli'); assert.equal(f.rows[0].getAttribute('aria-current'), 'true'); assert.equal(f.rows[1].hasAttribute('aria-current'), false);
  f.rows[0].click(); f.rows[1].click(); assert.equal(f.selected[0], hub); assert.equal(f.selected[1], cli); assert.equal(f.selected[0].run, hub.run); f.dom.window.close();
});
test('disabled controls suppress both native click and direct onclick; toggles never select', () => {
  const f = render([entry('a', '/p')], { busy: true }); f.rows[0].click(); f.rows[0].onclick(); toggle(f, f.groups[0], false); assert.deepEqual(f.selected, []);
  f.rows[0].disabled = false; f.rows[0].onclick(); assert.equal(f.selected.length, 1); f.dom.window.close();
});
test('search matches prompt/path/model/raw status/label/agent case-insensitively', () => {
  const all = [entry('a', '/WORK/Path', { prompt: 'Investigate Signal', model: 'local/MODEL', status: 'running' }), entry('b', '/else', { agent: 'Codex', model: 'other/backend', status: 'failed' }, 'cli')];
  for (const query of ['signal', '/work/path', 'MODEL', 'running', '実行中']) { const f = render(all, { query }); assert.deepEqual(f.rows.map(r => r.dataset.runId), ['a']); f.dom.window.close(); }
  const f = render(all, { query: '  codex  ' }); assert.deepEqual(f.rows.map(r => r.dataset.runId), ['b']); f.dom.window.close();
});
test('pending label searchable; no hits vs no records have distinct empty state', () => {
  const f = render([entry('a', '/p', { pendingActions: [{}, {}] })], { query: '承認待ち' }); assert.equal(f.rows.length, 1); assert.match(f.rows[0].title, /2件/); f.dom.window.close();
  const miss = render([entry('a', '/p')], { query: 'absent' }); assert.equal(miss.root.textContent, '該当する作業はありません'); miss.dom.window.close();
  for (const entries of [[], null, [null, { kind: 'other', run: {} }, { kind: 'hub', run: null }]]) { const empty = render(entries); assert.equal(empty.root.textContent, '作業履歴はまだありません'); empty.dom.window.close(); }
});
test('selected and attention groups initially open, completed first open, others folded', () => {
  const f = render([entry('first', '/first'), entry('ordinary', '/ordinary'), entry('selected', '/selected'), entry('running', '/running', { status: 'running' }), entry('pending', '/pending', { pendingActions: [{}] })], { selectedId: 'selected' });
  assert.deepEqual(f.groups.map(g => g.open), [true, false, true, true, true]); f.dom.window.close();
});
test('saved folds override selected/attention defaults, user toggles persist across render', () => {
  const openGroups = new Map([['posix:/selected', false], ['posix:/running', false]]), entries = [entry('selected', '/selected'), entry('running', '/running', { status: 'running' })];
  const f = render(entries, { selectedId: 'selected', openGroups }); assert.deepEqual(f.groups.map(g => g.open), [false, false]); toggle(f, f.groups[1], true); assert.equal(openGroups.get('posix:/running'), true); f.dom.window.close();
  const next = render(entries, { selectedId: 'selected', openGroups }); assert.deepEqual(next.groups.map(g => g.open), [false, true]); next.dom.window.close();
});
test('query forces matching groups open without modifying saved folds, restores on clear', () => {
  const openGroups = new Map([['posix:/p', false]]), entries = [entry('match', '/p')]; const f = render(entries, { query: 'match', openGroups }); assert.equal(f.groups[0].open, true); toggle(f, f.groups[0], false); assert.equal(openGroups.get('posix:/p'), false); f.dom.window.close();
  const next = render(entries, { openGroups }); assert.equal(next.groups[0].open, false); next.dom.window.close();
});
test('initial toggle notification does not save automatic expansion', () => {
  const openGroups = new Map(), f = render([entry('a', '/p')], { openGroups }); f.groups[0].dispatchEvent(new f.dom.window.Event('toggle')); assert.equal(openGroups.size, 0); toggle(f, f.groups[0], false); assert.equal(openGroups.get('posix:/p'), false); f.dom.window.close();
});
test('render never mutates entries/runs/pending arrays and callback has no eager call', () => {
  const a = entry('late', '/p', { startedAtMs: 10 }), b = entry('early', '/p', { startedAtMs: 20, pendingActions: Object.freeze([{}]) }); Object.freeze(a.run); Object.freeze(b.run); Object.freeze(a); Object.freeze(b); const entries = Object.freeze([a, b]); const before = JSON.stringify(entries), f = render(entries); assert.equal(JSON.stringify(entries), before); assert.deepEqual(entries.map(e => e.run.id), ['late', 'early']); assert.deepEqual(f.selected, []); f.dom.window.close();
});
test('missing/blank/nonstring run IDs omitted, unknown statuses never imply verification', () => {
  const valid = entry('valid', '/p', { status: 'future-status', verification: { status: 'passed' } });
  const malformed = [entry(undefined, '/p'), entry(null, '/p'), entry(123, '/p'), entry({}, '/p'), entry('', '/p'), entry('   ', '/p')];
  const f = render([...malformed, valid]); assert.equal(f.rows.length, 1); assert.equal(f.rows[0].dataset.runId, 'valid'); assert.match(f.rows[0].title, /future-status/); assert.doesNotMatch(f.rows[0].title, /指定検証に合格/); f.rows[0].click(); assert.equal(f.selected[0], valid); f.dom.window.close();
  const invalid = render(malformed); assert.equal(invalid.rows.length, 0); assert.equal(invalid.root.textContent, '作業履歴はまだありません'); invalid.dom.window.close();
});
test('Windows drive root stays separate from drive-relative path, POSIX root usable', () => {
  const f = render([entry('root', 'C:\\'), entry('rootcopy', 'c:/'), entry('relative', 'C:'), entry('posix', '/')]); assert.equal(f.groups.length, 3); assert.equal(f.groups[0].dataset.workspaceKey, 'windows:c:/'); assert.equal(f.groups[1].dataset.workspaceKey, 'windows:c:'); assert.equal(f.groups[2].dataset.workspaceKey, 'posix:/'); f.dom.window.close();
});
test('CLI prototype-property status names cannot become labels or function source', () => {
  const f = render(['__proto__', 'constructor', 'toString'].map((status, i) => entry(String(i), '/p', { status }, 'cli'))); assert.equal(f.rows.length, 3); for (const row of f.rows) assert.match(row.title, /\nCLI · 不明\n/); assert.doesNotMatch(f.root.textContent, /object Object|function|native code/); f.dom.window.close();
});
test('pending state precedes long date/model metadata and CLI failure precedes long agent', () => {
  const longModel = 'model/'.repeat(100), longAgent = 'agent-'.repeat(100);
  const f = render([entry('pending', '/p', { status: 'running', pendingActions: [{}, {}], startedAtMs: Date.UTC(2026, 9, 4, 23, 59), model: longModel }), entry('cli-failed', '/p', { status: 'failed', agent: longAgent, model: longModel }, 'cli')]);
  const pending = f.rows[0].title, failed = f.rows[1].title;
  assert.match(pending, /\n実行中 · 承認待ち 2件\n/); assert.ok(pending.indexOf('承認待ち') < pending.indexOf('2026')); assert.ok(pending.indexOf('2026') < pending.indexOf(longModel));
  assert.match(failed, /\nCLI · 失敗 · agent-/); assert.ok(failed.indexOf('失敗') < failed.indexOf(longAgent)); assert.ok(failed.indexOf(longAgent) < failed.indexOf(longModel)); f.dom.window.close();
});

test('rows are one line: dot tone, title, relative time; metadata only in tooltip', () => {
  const now = new Date(2026, 9, 11, 15, 0), at = (d, h, m) => new Date(2026, 9, d, h, m).getTime();
  const f = render([entry('now', '/p', { status: 'running', startedAtMs: now.getTime() - 60000 }), entry('today', '/p', { startedAtMs: at(11, 9, 4) }), entry('yday', '/p', { status: 'failed', startedAtMs: at(10, 23, 59) }), entry('old', '/p', { status: 'cancelled', startedAtMs: at(9, 1, 0) }), entry('appr', '/p', { pendingActions: [{}], startedAtMs: 1 })], { now });
  const get = id => f.rows.find(r => r.dataset.runId === id), time = id => get(id).querySelector('.piw-history-time').textContent, tone = id => get(id).querySelector('.piw-history-dot').dataset.tone;
  assert.deepEqual(['now', 'today', 'yday', 'old'].map(time), ['今', '09:04', '昨日', '10/9']);
  assert.deepEqual(['now', 'today', 'yday', 'old', 'appr'].map(tone), ['running', 'done', 'failed', 'muted', 'approval']);
  for (const row of f.rows) { assert.deepEqual([...row.children].map(c => c.className), ['piw-history-dot', 'piw-history-title', 'piw-history-time']); assert.equal(row.querySelector('small'), null); }
  assert.match(get('today').title, /local\/model/); f.dom.window.close();
});
test('five rows then 残り n 件を表示 / たたむ, persisted in openGroups; search and selection show all', () => {
  const entries = Array.from({ length: 8 }, (_, i) => entry(String(i), '/p', { startedAtMs: 1000 - i })), openGroups = new Map();
  const f = render(entries, { openGroups }), more = f.root.querySelector('.piw-history-more');
  assert.equal(more.textContent, '残り 3 件を表示'); assert.equal(f.rows.filter(r => !r.hidden).length, 5);
  more.click(); assert.equal(more.textContent, 'たたむ'); assert.equal(f.rows.filter(r => !r.hidden).length, 8); f.dom.window.close();
  const again = render(entries, { openGroups }); assert.equal(again.rows.filter(r => !r.hidden).length, 8); again.dom.window.close();
  const found = render(entries, { query: '依頼' }); assert.equal(found.root.querySelector('.piw-history-more'), null); assert.equal(found.rows.filter(r => !r.hidden).length, 8); found.dom.window.close();
  const sel = render(entries, { selectedId: '7' }); assert.equal(sel.root.querySelector('.piw-history-more'), null); assert.equal(sel.rows.filter(r => !r.hidden).length, 8); sel.dom.window.close();
});
test('a verbatim \\\\?\\ path and the plain path of the same folder are one group', () => {
  const f = render([entry('a', 'C:\\Temp\\piw-fix-01'), entry('b', '\\\\?\\C:\\Temp\\piw-fix-01'), entry('c', '\\\\?\\UNC\\server\\share\\x'), entry('d', '\\\\server\\share\\x')]);
  assert.equal(f.groups.length, 2);
  assert.deepEqual(f.groups.map(g => [...g.querySelectorAll('.piw-history-item')].map(b => b.dataset.runId).sort()), [['a', 'b'], ['c', 'd']]);
  assert.equal(f.root.querySelector('.piw-history-project-parent'), null); f.dom.window.close();
});
test('duplicate folder names get their parent folder beside the name; unique names do not', () => {
  const f = render([entry('a', 'C:\\one\\workspace'), entry('b', '/two/workspace'), entry('c', '/x/solo')]);
  assert.deepEqual([...f.root.querySelectorAll('.piw-history-project-parent')].map(n => n.textContent), ['one', 'two']);
  assert.deepEqual([...f.root.querySelectorAll('.piw-history-project-name')].map(n => n.textContent), ['workspace', 'workspace', 'solo']); f.dom.window.close();
});

test('groupBy date lists 今日 / 過去7日 / それ以前 in that order, whatever the folder, and keeps the folder in the tooltip (2026-11-03)', () => {
  const now = new Date(2026, 10, 3, 12, 0, 0), at = (daysAgo, hour = 9) => new Date(2026, 10, 3 - daysAgo, hour).getTime();
  const f = render([entry('old', '/a', { startedAtMs: at(30) }), entry('week', '/b', { startedAtMs: at(3) }), entry('today', '/c/proj', { startedAtMs: at(0) }), entry('nodate', '/a', { startedAtMs: undefined })], { groupBy: 'date', now });
  assert.deepEqual(f.groups.map(g => g.dataset.workspaceKey), ['date:today', 'date:week', 'date:older']);
  assert.deepEqual(f.groups.map(g => g.querySelector('.piw-history-project-name').textContent), ['今日', '過去7日', 'それ以前']);
  assert.equal(f.groups[0].open, true); assert.equal(f.groups[1].open, true);
  assert.equal(f.groups[2].querySelectorAll('.piw-history-item').length, 2);
  assert.match(f.groups[0].querySelector('.piw-history-item').title, /proj/);
  f.dom.window.close();
});
