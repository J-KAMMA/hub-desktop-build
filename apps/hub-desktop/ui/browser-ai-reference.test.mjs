import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createBrowserAiReference } from './browser-ai-reference.mjs';

const { JSDOM } = createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const material = { title: '資料', url: 'https://example.com/article', text: '本文\n次の行' };

function fixture() {
  const dom = new JSDOM('<div id="reference"></div>');
  const document = dom.window.document;
  const host = document.querySelector('#reference');
  const opened = [];
  const reference = createBrowserAiReference({ document, host, open: url => opened.push(url) });
  return { document, host, opened, reference };
}

test('shows a collapsed snapshot and opens only on the explicit source button click', () => {
  const { host, opened, reference } = fixture();
  assert.equal(host.hidden, true);
  assert.equal(reference.hasReference(), false);
  assert.equal(reference.show(material), true);
  assert.equal(host.hidden, false);
  assert.equal(reference.hasReference(), true);
  assert.equal(host.querySelector('h3').textContent, material.title);
  assert.equal(host.querySelector('.meta').textContent, material.url);
  assert.equal(host.querySelector('details').open, false);
  assert.equal(host.querySelector('summary').textContent, 'AIへ渡した資料');
  assert.equal(host.querySelector('.rail-reader-body').textContent, material.text);
  assert.deepEqual(opened, []);
  const button = host.querySelector('button');
  assert.equal(button.textContent, '元のページを開く');
  button.click();
  assert.deepEqual(opened, [material.url]);
});

test('replacement discards old content and stale buttons cannot open or clear the new source', () => {
  const { host, opened, reference } = fixture();
  reference.show(material);
  const oldCard = host.firstChild;
  const [oldOpen, oldClose] = host.querySelectorAll('button');
  const oldOpenHandler = oldOpen.onclick;
  const oldCloseHandler = oldClose.onclick;
  const replacement = { ...material, title: '新しい資料', url: 'http://example.org/new', text: '新しい本文' };
  assert.equal(reference.show(replacement), true);
  assert.equal(host.children.length, 1);
  assert.equal(oldCard.textContent, '');
  oldOpen.click();
  oldClose.click();
  oldOpenHandler();
  oldCloseHandler();
  assert.deepEqual(opened, []);
  assert.equal(reference.hasReference(), true);
  host.querySelector('button').click();
  assert.deepEqual(opened, [replacement.url]);
});

test('invalid input preserves the previous card and closed exact keys do not invoke getters', () => {
  const { host, opened, reference } = fixture();
  reference.show(material);
  const previous = host.firstChild;
  let reads = 0;
  const accessor = { ...material };
  Object.defineProperty(accessor, 'text', { get: () => { reads++; return 'unwanted'; } });
  for (const invalid of [null, [], 'text', { ...material, extra: true },
    { title: material.title, url: material.url }, { ...material, text: 1 }, accessor,
    { ...material, [Symbol('extra')]: true }]) {
    assert.equal(reference.show(invalid), false);
    assert.equal(host.firstChild, previous);
    assert.equal(reference.hasReference(), true);
    assert.equal(host.hidden, false);
  }
  assert.equal(reads, 0);
  host.querySelector('button').click();
  assert.deepEqual(opened, [material.url]);
});

test('clear and close scrub the card and disable captured handlers; clearing is idempotent', () => {
  const { host, opened, reference } = fixture();
  for (const closeViaButton of [false, true]) {
    reference.show(material);
    const card = host.firstChild;
    const [openButton, closeButton] = host.querySelectorAll('button');
    const handler = openButton.onclick;
    if (closeViaButton) closeButton.click();
    else reference.clear();
    assert.equal(host.hidden, true);
    assert.equal(host.childNodes.length, 0);
    assert.equal(card.textContent, '');
    assert.equal(reference.hasReference(), false);
    openButton.click();
    handler();
    reference.clear();
  }
  assert.deepEqual(opened, []);
});

test('markup stays literal and produces no executable elements or navigational links', () => {
  const { host, opened, reference } = fixture();
  const markup = '<img src=x onerror="alert(1)"><script>throw 1</script>';
  assert.equal(reference.show({ ...material, title: markup, text: markup }), true);
  assert.equal(host.querySelector('h3').textContent, markup);
  assert.equal(host.querySelector('pre').textContent, markup);
  assert.equal(host.querySelector('img, script, a, iframe'), null);
  assert.deepEqual(opened, []);
});

test('UTF16 size boundaries accept 32000 and reject 32001 without replacing the card', () => {
  const { host, reference } = fixture();
  for (const [key, limit, value] of [
    ['title', 480, 'a'.repeat(480)],
    ['text', 32000, '😀'.repeat(16000)],
    ['url', 8192, 'https://example.com/' + 'a'.repeat(8192 - 'https://example.com/'.length)],
  ]) {
    assert.equal(value.length, limit);
    assert.equal(reference.show({ ...material, [key]: value }), true);
    const previous = host.firstChild;
    assert.equal(reference.show({ ...material, [key]: value + 'a' }), false);
    assert.equal(host.firstChild, previous);
  }
});

test('URLs reject credentials, controls, unsupported schemes and noncanonical forms', () => {
  const { host, reference } = fixture();
  reference.show(material);
  const previous = host.firstChild;
  for (const url of [
    'https://user:password@example.com/', 'https://user@example.com/',
    'https://%75ser@example.com/', 'https://@example.com/',
    'javascript:alert(1)', 'file:///test', '/relative',
    'https://example.com/\npath', 'https://example.com/\tpath',
    'https://example.com/\0path', 'https://example.com/\u007Fpath', 'https://example.com/\u0085path',
    ' HTTPS://EXAMPLE.COM ', 'https://example.com', 'https://example.com:443/',
  ]) {
    assert.equal(reference.show({ ...material, url }), false, JSON.stringify(url));
    assert.equal(host.firstChild, previous);
  }
});

test('malformed UTF16 and NUL body fail before DOM replacement while valid pairs and newlines survive', () => {
  const { host, reference } = fixture();
  reference.show(material);
  const previous = host.firstChild;
  for (const key of ['title', 'url', 'text']) {
    for (const broken of ['\uD800', '\uDC00', '\uD800x', 'x\uDC00', '\uD800\uD800\uDC00']) {
      assert.equal(reference.show({ ...material, [key]: broken }), false);
      assert.equal(host.firstChild, previous);
    }
  }
  assert.equal(reference.show({ ...material, text: 'before\0after' }), false);
  assert.equal(host.firstChild, previous);
  assert.equal(reference.show({ ...material, title: '😀', text: '😀\n\r\tend' }), true);
  assert.equal(host.querySelector('pre').textContent, '😀\n\r\tend');
});

test('closed source match reads no text and rejects replaced, hidden, detached and cleared cards', () => {
  const {host,reference}=fixture();
  assert.equal(reference.matches(material.url),false);
  reference.show(material);assert.equal(reference.matches(material.url),true);
  assert.equal(reference.matches('https://other.example/'),false);
  assert.equal(reference.matches(undefined),false);
  host.hidden=true;assert.equal(reference.matches(material.url),false);host.hidden=false;
  const card=host.firstChild;card.remove();assert.equal(reference.matches(material.url),false);
  host.append(card);assert.equal(reference.matches(material.url),true);
  reference.show({...material,url:'https://other.example/'});assert.equal(reference.matches(material.url),false);
  assert.equal(reference.matches('https://other.example/'),true);
  reference.clear();assert.equal(reference.matches('https://other.example/'),false);
});