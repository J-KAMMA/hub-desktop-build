import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildReaderExpression } from './build-reader-extract.mjs';
const { JSDOM, ResourceLoader } = createRequire(new URL('../../../../package.json', import.meta.url))('jsdom');
const expression = await buildReaderExpression();
const page = (body, head = '<title>Fixture article</title>', url = 'https://example.test/article?source=fixture') => {
  const loads = []; class NoNetwork extends ResourceLoader { fetch(url) { loads.push(url); return null; } }
  const dom = new JSDOM(`<!doctype html><html><head>${head}</head><body><main><article>${body}</article></main></body></html>`, { url, runScripts: 'outside-only', resources: new NoNetwork() });
  return { dom, loads, read: () => dom.window.eval(expression) };
};
const paragraph = text => `<p>${text}</p>`;
const chars = result => result.paragraphs.reduce((total, text) => total + Array.from(text).length, 0);
const noLoneSurrogate = value => !/\p{Surrogate}/u.test(value);

test('extracts only a closed plain-string result without altering the document, inputs, page globals or fetching resources', () => {
  const { dom, loads, read } = page(paragraph('A readable sentence with useful article details. '.repeat(25)));
  try {
    const original = dom.serialize(), globals = Reflect.ownKeys(dom.window), beforeLoads = loads.length;
    const result = read(); assert.deepEqual(Object.keys(result).sort(), ['paragraphs', 'title', 'truncated', 'url']);
    assert.equal(result.url, dom.window.location.href); assert.equal(typeof result.title, 'string'); assert.ok(result.paragraphs.every(value => typeof value === 'string'));
    assert.equal(dom.serialize(), original); assert.deepEqual(Reflect.ownKeys(dom.window), globals); assert.equal(loads.length, beforeLoads); assert.equal(result.truncated, false);
  } finally { dom.window.close(); }
});
test('excludes synthetic form values and hidden/editor/embedded/script/style text, preserving original fields', () => {
  const body = paragraph('Public article sentence with useful reading content. '.repeat(25)) +
    '<form>FORM_LABEL<input value="INPUT_SENTINEL"><textarea>TEXTAREA_SENTINEL</textarea><button>BUTTON_SENTINEL</button></form>' +
    '<div contenteditable>EDITOR_SENTINEL</div><div hidden>HIDDEN_SENTINEL</div><div aria-hidden="TRUE">ARIA_SENTINEL</div>' +
    '<script>window.SCRIPT_SENTINEL = true</script><style>STYLE_SENTINEL {color:red}</style><iframe>IFRAME_SENTINEL</iframe><object>OBJECT_SENTINEL</object><embed title="EMBED_SENTINEL">' +
    '<figure><picture><source data-srcset="https://example.test/lazy.jpg"><img data-src="https://example.test/lazy.jpg" alt="IMAGE_SENTINEL"></picture><figcaption>RESOURCE_CAPTION_MARKER is useful descriptive article text.</figcaption></figure>' +
    '<video title="VIDEO_SENTINEL"><source><track></video><audio title="AUDIO_SENTINEL"></audio><link title="LINK_SENTINEL">';
  const { dom, loads, read } = page(body);
  try {
    dom.window.document.querySelector('input').value = 'TYPED_INPUT_SENTINEL';
    const original = dom.serialize(), beforeLoads = loads.length;
    const text = JSON.stringify(read()); for (const marker of ['FORM_LABEL', 'INPUT_SENTINEL', 'TEXTAREA_SENTINEL', 'BUTTON_SENTINEL', 'EDITOR_SENTINEL', 'HIDDEN_SENTINEL', 'ARIA_SENTINEL', 'SCRIPT_SENTINEL', 'STYLE_SENTINEL', 'IFRAME_SENTINEL', 'OBJECT_SENTINEL', 'EMBED_SENTINEL', 'IMAGE_SENTINEL', 'VIDEO_SENTINEL', 'AUDIO_SENTINEL', 'LINK_SENTINEL']) assert.equal(text.includes(marker), false, marker);
    assert.ok(text.includes('RESOURCE_CAPTION_MARKER'));
    assert.equal(dom.serialize(), original); assert.equal(dom.window.document.querySelector('input').value, 'TYPED_INPUT_SENTINEL'); assert.equal(loads.length, beforeLoads);
  } finally { dom.window.close(); }
});
test('original CSS display/visibility exclusions remove cloned descendants and preserve head metadata without changing source DOM', () => {
  const head = '<title>CSS fixture title</title><meta property="og:title" content="Kept metadata title"><style>.gone{display:none}.invisible{visibility:hidden}.collapsed{visibility:collapse}</style>';
  const { dom, loads, read } = page(paragraph('Visible article reading sentence. '.repeat(35)) +
    '<div class="gone"><p>CSS_DISPLAY_SENTINEL</p><section><p>PARENT_HIDDEN_SENTINEL</p></section></div>' +
    '<p class="invisible">CSS_VISIBILITY_SENTINEL</p><div class="collapsed"><p>CSS_COLLAPSE_SENTINEL</p></div>', head);
  try {
    const original = dom.serialize(), beforeLoads = loads.length, result = read(), text = result.paragraphs.join('\n');
    for (const marker of ['CSS_DISPLAY_SENTINEL', 'PARENT_HIDDEN_SENTINEL', 'CSS_VISIBILITY_SENTINEL', 'CSS_COLLAPSE_SENTINEL']) assert.equal(text.includes(marker), false, marker);
    assert.equal(result.title, 'Kept metadata title'); assert.equal(dom.serialize(), original); assert.equal(loads.length, beforeLoads);
  } finally { dom.window.close(); }
});
test('PRE preserves LF/Tab and leading indentation, including nested quote code, while other Cc and lone surrogates are sanitized', () => {
  const { dom, read } = page(paragraph('Visible article reading sentence. '.repeat(35)) + '<pre id="code"></pre><blockquote><p>Quote prefix.</p><pre id="nested-code"></pre><p>Quote suffix.</p></blockquote>');
  try {
    const raw = '\n  const emoji = "🧪";\r\n\treturn emoji;\n  BAD\u0000\u0001\ud800\n';
    dom.window.document.querySelector('#code').textContent = raw;
    dom.window.document.querySelector('#nested-code').textContent = '  NESTED_CODE_MARKER\n\tsecond line\n';
    const original = dom.serialize(), result = read();
    assert.ok(result.paragraphs.includes('\n  const emoji = "🧪";\n\treturn emoji;\n  BAD\uFFFD\n'));
    assert.ok(result.paragraphs.some(text => text.includes('  NESTED_CODE_MARKER\n\tsecond line\n')));
    assert.equal(result.paragraphs.join('\n').split('NESTED_CODE_MARKER').length - 1, 1);
    assert.ok(result.paragraphs.every(noLoneSurrogate)); assert.equal(dom.serialize(), original);
  } finally { dom.window.close(); }
});
test('giant attribute values are bounded before cloning and never returned or logged', () => {
  const { dom, read } = page(paragraph('Visible article reading sentence. '.repeat(35)));
  try {
    dom.window.document.querySelector('article').setAttribute('data-large-fixture', 'x'.repeat(2 * 1024 * 1024 + 1));
    let clones = 0; dom.window.document.cloneNode = () => { clones++; throw Error('must not clone'); };
    assert.throws(read, { message: 'reader_page_too_large' }); assert.equal(clones, 0);
  } finally { dom.window.close(); }
});
test('counts overlarge element/text budgets before cloning; errors contain only fixed codes', () => {
  for (const overElements of [true, false]) {
    const { dom, read } = page(paragraph('Fixture article. '.repeat(50)));
    try {
      if (overElements) { const fragment = dom.window.document.createDocumentFragment(); for (let i = 0; i < 20001; i++) fragment.append(dom.window.document.createElement('span')); dom.window.document.body.append(fragment); }
      else dom.window.document.body.append(dom.window.document.createTextNode('🧪'.repeat(1024 * 1024 + 1)));
      let clones = 0; dom.window.document.cloneNode = () => { clones++; throw Error('must not clone'); };
      assert.throws(read, { message: 'reader_page_too_large' }); assert.equal(clones, 0);
    } finally { dom.window.close(); }
  }
});
test('accepts exactly 20000 elements and exactly 2MiB text units before cloning', () => {
  for (const elementLimit of [true, false]) {
    const { dom, read } = page(paragraph('Readable fixture article. '.repeat(30)));
    try {
      const document = dom.window.document;
      if (elementLimit) {
        const fragment = document.createDocumentFragment();
        for (let i = document.getElementsByTagName('*').length; i < 20000; i++) fragment.append(document.createElement('span'));
        document.body.append(fragment); assert.equal(document.getElementsByTagName('*').length, 20000);
      } else {
        const walker = document.createTreeWalker(document, 4); let units = 0, node;
        while ((node = walker.nextNode())) units += node.data.length;
        document.body.append(document.createTextNode('a'.repeat(2 * 1024 * 1024 - units)));
      }
      const clone = document.cloneNode.bind(document); let clones = 0;
      document.cloneNode = (...args) => { clones++; return clone(...args); };
      assert.ok(read().paragraphs.length > 0); assert.equal(clones, 1);
    } finally { dom.window.close(); }
  }
});
test('uses the 500-character SDK heuristic, preserves valid short fallbacks and rejects empty/excluded content', () => {
  for (const text of ['a'.repeat(499), 'a'.repeat(500), '🧪'.repeat(250)]) {
    const { dom, read } = page(paragraph(text)); try { assert.equal(chars(read()), Array.from(text).length); } finally { dom.window.close(); }
  }
  const { dom, read } = page('<form><textarea>Only excluded content</textarea></form>'); try { assert.throws(read, { message: 'reader_article_unavailable' }); } finally { dom.window.close(); }
});
test('semantic headings/quotes/pre/lists/table text is collected once without HTML or parent-child duplicates', () => {
  const filler = paragraph('Paragraph article content supports meaningful extraction. '.repeat(20));
  const body = filler + '<h2>HEADING_MARKER</h2><blockquote><p>QUOTE_FIRST_MARKER</p><p>QUOTE_SECOND_MARKER</p></blockquote>' +
    '<pre>CODE_MARKER line one\nline two</pre><ul><li>LIST_PARENT_MARKER<ul><li>LIST_CHILD_MARKER</li></ul></li></ul>' +
    '<table><thead><tr><th>TABLE_HEADER_MARKER</th></tr></thead><tbody><tr><td>TABLE_CELL_MARKER</td></tr></tbody></table>';
  const { dom, read } = page(body);
  try {
    const result = read(), text = result.paragraphs.join('\n');
    for (const marker of ['HEADING_MARKER', 'QUOTE_FIRST_MARKER', 'QUOTE_SECOND_MARKER', 'CODE_MARKER', 'LIST_PARENT_MARKER', 'LIST_CHILD_MARKER', 'TABLE_HEADER_MARKER', 'TABLE_CELL_MARKER']) assert.equal(text.split(marker).length - 1, 1, marker);
    assert.equal(text.includes('<p>'), false); assert.equal(text.includes('QUOTE_FIRST_MARKER QUOTE_SECOND_MARKER'), true);
  } finally { dom.window.close(); }
});
test('bounds paragraphs at 1000 with explicit truncation and no repeated text', () => {
  const { dom, read } = page(Array.from({ length: 1001 }, (_, i) => paragraph(`Unique article paragraph number ${String(i).padStart(4, '0')}, with useful content.`)).join(''));
  try { const result = read(); assert.equal(result.paragraphs.length, 1000); assert.equal(result.truncated, true); assert.equal(new Set(result.paragraphs).size, 1000); } finally { dom.window.close(); }
});
test('100000/300 Unicode-character caps never split surrogate pairs, malformed surrogates become replacement text', () => {
  const { dom, read } = page(paragraph('🧪'.repeat(100001)), `<title>${'🧪'.repeat(301)}</title>`);
  try { const result = read(); assert.equal(chars(result), 100000); assert.equal(Array.from(result.title).length, 300); assert.equal(result.truncated, true); assert.ok(result.paragraphs.every(noLoneSurrogate)); assert.ok(noLoneSurrogate(result.title)); assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= 512 * 1024); } finally { dom.window.close(); }
  const malformed = page(paragraph('Normal article sentence. '.repeat(30)));
  try { malformed.dom.window.document.querySelector('p').append('\ud800X\udc00'); const result = malformed.read(); assert.ok(result.paragraphs.every(noLoneSurrogate)); assert.ok(result.paragraphs.join('').includes('\uFFFDX\uFFFD')); } finally { malformed.dom.window.close(); }
});
test('exactly 100000 body and 300 title Unicode characters remain complete rather than marked truncated', () => {
  const { dom, read } = page(paragraph('🧪'.repeat(100000)), `<title>${'🧪'.repeat(300)}</title>`);
  try { const result = read(); assert.equal(chars(result), 100000); assert.equal(Array.from(result.title).length, 300); assert.equal(result.truncated, false); } finally { dom.window.close(); }
});
test('malicious-looking metadata remains a string, JSON-LD is unused, and URL is only location.href despite base/og:url', () => {
  const title = '&lt;img src=x onerror=alert(1)&gt; Plain title';
  const head = `<title>Fallback title</title><meta property="og:title" content="${title}"><meta property="og:url" content="https://other.test/forged"><base href="https://other.test/"><script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"JSONLD_SENTINEL"}</script>`;
  const { dom, read } = page(paragraph('Visible article content. '.repeat(35)), head);
  try { const result = read(); assert.equal(result.title, '<img src=x onerror=alert(1)> Plain title'); assert.equal(result.url, dom.window.location.href); assert.equal(JSON.stringify(result).includes('JSONLD_SENTINEL'), false); assert.equal(dom.window.document.querySelector('img'), null); } finally { dom.window.close(); }
});
