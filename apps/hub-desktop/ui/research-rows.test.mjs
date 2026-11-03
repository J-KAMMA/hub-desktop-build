import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { projectRow, projectRows, projectBadges, projectMeta, researchEmptyState, researchSkeleton, statusLabel, visibilityLabel } from './research-rows.mjs';
import { decorateProjectPage, assignTabs, RESEARCH_TABS } from './research-project-page.mjs';

const doc = t => { const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost' }); t.after(() => dom.window.close()); return dom.window.document; };
const project = { id: 'rp_a', title: '海洋プラスチックの分解菌データセット', description: '沿岸の菌株の配列と分解率。', visibility: 'public', status: 'active', objectCount: 3, defaultLicense: 'CC-BY-4.0' };

test('a row keeps the legacy .research-project-card button and shows name, badges, body, meta', t => {
  const document = doc(t);
  const opened = [];
  const row = projectRow(document, project, item => opened.push(item.id));
  assert.equal(row.tagName, 'BUTTON');
  assert.ok(row.classList.contains('research-project-card') && row.classList.contains('research-row'));
  assert.equal(row.querySelector('h3.research-row-name').textContent, project.title);
  assert.deepEqual([...row.querySelectorAll('.research-badge')].map(node => node.textContent), ['進行中'], 'public is the default, so only the status is a badge');
  assert.equal(row.querySelector('.research-row-body').textContent, project.description);
  assert.equal(row.querySelector('.research-row-meta').textContent, '3 成果 · CC-BY-4.0');
  row.click();
  assert.deepEqual(opened, ['rp_a']);
});

test('non-public projects get a visibility badge before the status badge', t => {
  const document = doc(t);
  assert.deepEqual(projectBadges(document, { visibility: 'confidential', status: 'completed' }).map(node => node.textContent), ['機密', '完了']);
  assert.deepEqual(projectBadges(document, { visibility: 'restricted', status: 'paused' }).map(node => node.textContent), ['限定', '中断中']);
  assert.deepEqual(projectBadges(document, {}).map(node => node.textContent), []);
  assert.equal(visibilityLabel('nope'), '');
  assert.equal(statusLabel('active'), '進行中');
});

test('the meta line never says undefined and a row without a description says so quietly', t => {
  const document = doc(t);
  assert.equal(projectMeta({}), '');
  assert.equal(projectMeta({ objectCount: 'x' }), '');
  assert.equal(projectMeta({ objectCount: 0 }), '0 成果');
  const row = projectRow(document, { id: 'x', title: 't' }, () => {});
  assert.equal(row.querySelector('.research-row-body').textContent, '説明はまだありません。');
  assert.equal(row.querySelector('.research-row-meta'), null);
  assert.ok(!/undefined|null/.test(row.textContent));
});

test('rows are plain buttons in a flat list: no card class, no nested boxes', t => {
  const document = doc(t);
  const rows = projectRows(document, [project, { ...project, id: 'rp_b' }], () => {});
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.querySelectorAll('button, article, section').length, 0);
});

test('the empty state keeps .state-panel/.state-title, has no icon disc, and at most one secondary button', t => {
  const document = doc(t);
  const quiet = researchEmptyState(document, { title: '表示できるプロジェクトはまだありません。', body: 'プロジェクトを作成すると、ここに並びます。' });
  assert.ok(quiet.classList.contains('state-panel') && quiet.classList.contains('research-empty'));
  assert.equal(quiet.getAttribute('role'), 'status');
  assert.equal(quiet.querySelector('.state-title').textContent, '表示できるプロジェクトはまだありません。');
  assert.equal(quiet.querySelector('.state-body').textContent, 'プロジェクトを作成すると、ここに並びます。');
  assert.equal(quiet.querySelectorAll('svg, img, .state-icon, .empty-icon').length, 0);
  assert.equal(quiet.querySelectorAll('button').length, 0);
  let clicked = 0;
  const withAction = researchEmptyState(document, { title: 't', action: { label: 'もう一度', onClick: () => { clicked++; } } });
  assert.equal(withAction.querySelectorAll('button').length, 1);
  withAction.querySelector('button').click();
  assert.equal(clicked, 1);
  assert.equal(withAction.querySelector('.state-body'), null);
  assert.equal(researchEmptyState(document, { title: 't', action: { label: 'x' } }).querySelectorAll('button').length, 0, 'an action without a handler is not drawn');
});

test('the skeleton has the row shape (three bones), no loading text and one status for readers', t => {
  const document = doc(t);
  const skeleton = researchSkeleton(document, 3);
  assert.equal(skeleton.getAttribute('role'), 'status');
  assert.equal(skeleton.getAttribute('aria-busy'), 'true');
  const rows = skeleton.querySelectorAll('.research-skel-row');
  assert.equal(rows.length, 3);
  assert.ok([...rows].every(row => row.querySelectorAll('.skeleton-block').length === 3 && row.getAttribute('aria-hidden') === 'true'));
  assert.equal(researchSkeleton(document, 99).querySelectorAll('.research-skel-row').length, 8);
  assert.equal(researchSkeleton(document, 0).querySelectorAll('.research-skel-row').length, 1);
});

function detailRoot(t, { withPdf = true, withOther = false } = {}) {
  const document = doc(t);
  const root = document.createElement('section');
  root.className = 'research-project-detail';
  const add = (tag, text, attrs = {}) => { const node = document.createElement(tag); node.textContent = text; Object.assign(node.dataset, attrs.data ?? {}); if (attrs.className) node.className = attrs.className; root.append(node); return node; };
  add('p', '説明');
  add('p', '公開 · 進行中 · CC-BY-4.0', { className: 'meta' });
  add('div', 'git', { className: 'research-group-filter' });
  add('h3', '文書・コード', { data: { researchSection: '文書・コード' } });
  add('button', '手順書 · v4');
  add('h3', '資料・作品・議論', { data: { researchSection: '資料・作品・議論' } });
  add('div', 'links', { className: 'research-related-links' });
  add('h3', '研究成果', { data: { researchSection: '研究成果' } });
  add('div', 'objects', { className: 'research-object-list' });
  add('h3', '主張と根拠', { data: { researchSection: '主張と根拠' } });
  add('p', 'a → b', { className: 'research-relation' });
  if (withPdf) add('section', '論文PDF', { className: 'research-editor research-files', data: { researchSection: '論文PDF' } });
  if (withOther) add('section', '別の節', { data: { researchSection: '別の節' } });
  return root;
}
const visible = root => [...root.querySelectorAll(':scope > [data-research-tab]')].filter(node => !node.hidden).map(node => node.textContent.slice(0, 6));

test('tabs: 概要 shows the summary, git actions and the document entry points; other sections wait on their tab', t => {
  const root = detailRoot(t);
  const page = decorateProjectPage(root, { project: { visibility: 'public', status: 'active', defaultLicense: 'CC-BY-4.0' } }, {});
  const tabs = [...root.querySelectorAll('.page-tabs > [role="tab"]')];
  assert.deepEqual(tabs.map(node => node.textContent), ['概要', '資料と議論', '成果と根拠']);
  assert.deepEqual(tabs.map(node => node.getAttribute('aria-selected')), ['true', 'false', 'false']);
  assert.equal(root.querySelector('.page-tabs').getAttribute('role'), 'tablist');
  assert.deepEqual(visible(root), ['git', '文書・コード', '手順書 · ']);
  assert.ok(!root.querySelector('.research-summary').hidden, 'the description is always visible');
  assert.equal(root.querySelector('button.research-doc-row').textContent, '手順書 · v4');
  tabs[1].click();
  assert.deepEqual(visible(root), ['資料・作品・議論'.slice(0, 6), 'links', '論文PDF']);
  page.select('results');
  assert.deepEqual(visible(root), ['研究成果', 'object', '主張と根拠', 'a → b']);
  assert.deepEqual(tabs.map(node => node.getAttribute('aria-selected')), ['false', 'false', 'true']);
});

test('the status badges replace the old meta line, which stays in the DOM but hidden; every section stays in the DOM', t => {
  const root = detailRoot(t);
  const sections = [...root.querySelectorAll('[data-research-section]')].map(node => node.dataset.researchSection);
  decorateProjectPage(root, { project: { visibility: 'confidential', status: 'draft', defaultLicense: 'MIT' } }, {});
  assert.deepEqual([...root.querySelectorAll('.research-page-head .research-badge')].map(node => node.textContent), ['機密', '準備中']);
  assert.equal(root.querySelector('.research-page-head > .meta').textContent, 'MIT');
  assert.equal(root.querySelector(':scope > p.meta').hidden, true);
  assert.deepEqual([...root.querySelectorAll('[data-research-section]')].map(node => node.dataset.researchSection), sections);
  const order = [...root.children].map(node => node.className);
  assert.ok(order.indexOf('research-page-head') < order.indexOf('page-tabs research-tabs'));
});

test('the selection lives in state, so a re-render keeps the tab; unknown sections get an その他 tab; arrows move the tab', t => {
  const state = {};
  const first = detailRoot(t, { withOther: true });
  decorateProjectPage(first, { project: { status: 'active' } }, state);
  assert.deepEqual([...first.querySelectorAll('.page-tabs > [role="tab"]')].map(node => node.textContent), ['概要', '資料と議論', '成果と根拠', 'その他']);
  const tabs = [...first.querySelectorAll('.page-tabs > [role="tab"]')];
  tabs[0].dispatchEvent(new first.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  assert.equal(state.tab, 'documents');
  tabs[3].click();
  assert.equal(state.tab, 'other');
  const second = detailRoot(t, { withOther: true });
  decorateProjectPage(second, { project: { status: 'active' } }, state);
  assert.equal(second.querySelector('.page-tabs > [aria-selected="true"]').textContent, 'その他');
  const stale = detailRoot(t);
  decorateProjectPage(stale, { project: { status: 'active' } }, { tab: 'other' });
  assert.equal(stale.querySelector('.page-tabs > [aria-selected="true"]').textContent, '概要', 'a tab that does not exist falls back to 概要');
});

test('assignTabs reports which tabs exist and RESEARCH_TABS lists them in order', t => {
  const used = assignTabs(detailRoot(t, { withPdf: false }));
  assert.deepEqual([...used].sort(), ['documents', 'overview', 'results']);
  assert.deepEqual(RESEARCH_TABS.map(item => item.id), ['overview', 'documents', 'results', 'other']);
});

test('research-view.css uses only tokens: no raw colours, no raw font-size or radius px, no weights outside 400/700/800', () => {
  const css = readFileSync(new URL('./research-view.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(css, /\b(?:rgb|rgba|hsl|hsla)\(/);
  assert.doesNotMatch(css, /:\s*(?:white|black)\b/);
  assert.doesNotMatch(css, /(?:font-size|border-radius)\s*:\s*\d+(?:\.\d+)?px/);
  assert.doesNotMatch(css, /font-weight:\s*(?:500|600|650)\b/);
  assert.doesNotMatch(css, /background:\s*var\(--(?:emphasis|action)\)/, 'gold is a line, never a fill');
});
