import { Readability } from '@mozilla/readability';

const EXCLUDE = 'form,input,textarea,button,[contenteditable],[hidden],[aria-hidden="true" i],script,style,iframe,object,embed,img,picture,video,audio,source,track,link';
const BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'LI', 'TABLE']);
const BOUNDARIES = new Set([...BLOCKS, 'DIV', 'ARTICLE', 'MAIN', 'SECTION', 'UL', 'OL', 'DL', 'DT', 'DD', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH']);
const BREAK = Symbol('reader-break');
const clean = (value, pre = false) => {
  const text = value.replace(/\p{Surrogate}/gu, '\uFFFD');
  return pre ? text.replace(/\r\n?/gu, '\n').replace(/\p{Cc}/gu, char => char === '\n' || char === '\t' ? char : '')
    : text.replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim();
};
const fail = code => { throw new Error(code); };

function budget(document) {
  // SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION; the original is counted, never edited.
  const walker = document.createTreeWalker(document, 1 | 4 | 8);
  let elements = 0, textUnits = 0, attributes = 0, attributeUnits = 0, node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === 1) {
      elements++; attributes += node.attributes.length;
      if (attributes > 100000) fail('reader_page_too_large');
      for (const attribute of node.attributes) { attributeUnits += attribute.value.length; if (attributeUnits > 2 * 1024 * 1024) fail('reader_page_too_large'); }
    }
    else textUnits += node.data.length;
    if (elements > 20000 || textUnits > 2 * 1024 * 1024) fail('reader_page_too_large');
  }
}
function removeInvisibleBody(document, cloneDocument) {
  if (!document.body || !cloneDocument.body) return;
  const original = [document.body, ...document.body.querySelectorAll('*')];
  const cloned = [cloneDocument.body, ...cloneDocument.body.querySelectorAll('*')];
  if (original.length !== cloned.length) fail('reader_article_unavailable');
  // Native getComputedStyle from the isolated world; preserve head metadata.
  original.forEach((element, index) => {
    const style = globalThis.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') cloned[index].remove();
  });
}
function children(stack, node) {
  for (let child = node.lastChild; child; child = child.previousSibling) stack.push(child);
}
function plainText(root) {
  const stack = [root], parts = [], sections = [];
  const flush = () => { const text = clean(parts.join('')); parts.length = 0; if (text) sections.push(text); };
  while (stack.length) {
    const node = stack.pop();
    if (node === BREAK) { parts.push(' '); continue; }
    if (node.nodeType === 3 || node.nodeType === 4) { parts.push(node.data); continue; }
    if (node.nodeType !== 1) continue;
    if (node.tagName === 'BR') { parts.push(' '); continue; }
    if (node.tagName === 'PRE') {
      flush(); const raw = [], walker = node.ownerDocument.createTreeWalker(node, 1 | 4 | 8); let child;
      while ((child = walker.nextNode())) { if (child.nodeType === 3 || child.nodeType === 4) raw.push(child.data); else if (child.tagName === 'BR') raw.push('\n'); }
      const text = clean(raw.join(''), true); if (text.trim()) sections.push(text);
      continue;
    }
    if (BOUNDARIES.has(node.tagName)) { parts.push(' '); stack.push(BREAK); }
    children(stack, node);
  }
  flush(); return sections.join('\n');
}
function* paragraphs(root) {
  const stack = [root]; let pending = [];
  const flush = () => { const text = clean(pending.join('')); pending = []; return text; };
  while (stack.length) {
    const node = stack.pop();
    if (node === BREAK) { const text = flush(); if (text) yield text; continue; }
    if (node.nodeType === 3 || node.nodeType === 4) { pending.push(node.data); continue; }
    if (node.nodeType !== 1) continue;
    if (node.tagName === 'BR') { pending.push(' '); continue; }
    if (BLOCKS.has(node.tagName)) {
      const prefix = flush(); if (prefix) yield prefix;
      const text = plainText(node); if (text.trim()) yield text;
      continue; // Outermost semantic blocks own their descendants; no double collection.
    }
    if (BOUNDARIES.has(node.tagName)) { const prefix = flush(); if (prefix) yield prefix; stack.push(BREAK); }
    children(stack, node);
  }
  const tail = flush(); if (tail) yield tail;
}

/** Tests may supply synthetic DOM globals; the fixed expression passes no request parameters. */
export function extractReaderPage(document = globalThis.document, location = globalThis.location) {
  try {
    const url = location.href; if (typeof url !== 'string') fail('reader_article_unavailable');
    budget(document);
    const cloneDocument = document.cloneNode(true);
    removeInvisibleBody(document, cloneDocument);
    cloneDocument.querySelectorAll(EXCLUDE).forEach(node => node.remove());
    const article = new Readability(cloneDocument, { disableJSONLD: true, maxElemsToParse: 20000, charThreshold: 500, serializer: el => el }).parse();
    if (!article?.content || article.content.nodeType !== 1) fail('reader_article_unavailable');
    let truncated = false, chars = 0;
    const output = [];
    for (const text of paragraphs(article.content)) {
      if (output.length === 1000 || chars === 100000) { truncated = true; break; }
      const points = Array.from(text), available = 100000 - chars;
      if (points.length > available) { output.push(points.slice(0, available).join('')); chars += available; truncated = true; break; }
      output.push(text); chars += points.length;
    }
    // charThreshold is Readability's heuristic; retain its valid short fallbacks.
    if (!output.length) fail('reader_article_unavailable');
    const titlePoints = Array.from(clean(article.title || document.title || ''));
    if (titlePoints.length > 300) truncated = true;
    return { url, title: titlePoints.slice(0, 300).join(''), paragraphs: output, truncated };
  } catch (error) {
    fail(error?.message === 'reader_page_too_large' ? 'reader_page_too_large' : 'reader_article_unavailable');
  }
}
