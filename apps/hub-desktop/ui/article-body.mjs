// 記事本文の構造化（Hub Desktop）。依存なしの純粋モジュール。
//
// apps/hub/lib/article-body.ts の同じ文法の移植。HTMLは解釈せず、行頭の記号と
// 限られたインライン記法だけを見る。文法を変えるときは web 版と、
// apps/hub/lib/article-body-fixtures.json を一緒に直す（両方の試験が同じ表を読む）。
// 描画は DOM の textContent / createElement だけ。innerHTML は使わない。
import { youtubeEmbedUrl } from './youtube-embed.mjs';

// 記事に挿す画像：旧来の /api/media/images/ID と、記事画像 /api/articles/images/ID。
const HUB_IMAGE_PATH = /^\/api\/(?:media|articles)\/images\/[A-Za-z0-9_-]{1,64}$/u;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/u;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const MAX_INLINE_DEPTH = 3;

function parseWebUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000- \u007f]/u.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || !url.hostname) return null;
  return url;
}

export function safeArticleLink(value) {
  if (typeof value === 'string' && value.startsWith('/')) {
    if (value.startsWith('//') || value.length > 2048 || /[\u0000- \u007f\\]/u.test(value)) return null;
    return { href: value, external: false };
  }
  const url = parseWebUrl(value);
  return url ? { href: url.href, external: true } : null;
}

export function safeArticleImageSource(value) {
  if (typeof value !== 'string') return null;
  if (HUB_IMAGE_PATH.test(value)) return value;
  const url = parseWebUrl(value);
  return url && url.protocol === 'https:' ? url.href : null;
}

export function articleYouTubeId(value) {
  const url = parseWebUrl(value);
  if (!url || !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  let id = null;
  if (url.hostname.toLowerCase() === 'youtu.be') id = url.pathname.slice(1).split('/')[0] ?? null;
  else if (url.pathname === '/watch') id = url.searchParams.get('v');
  else id = url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/u)?.[1] ?? null;
  return id && YOUTUBE_ID.test(id) ? id : null;
}

function pushText(out, value) {
  if (!value) return;
  const last = out[out.length - 1];
  if (last?.t === 'text') last.v += value;
  else out.push({ t: 'text', v: value });
}

export function parseArticleInline(source, depth = 0, allowLinks = true) {
  const out = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '`') {
      const end = source.indexOf('`', i + 1);
      if (end > i + 1) {
        out.push({ t: 'code', v: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (ch === '[' && allowLinks && depth < MAX_INLINE_DEPTH) {
      const match = /^\[([^\]\n]{1,200})\]\(([^)\s]{1,2048})\)/u.exec(source.slice(i));
      const link = match ? safeArticleLink(match[2]) : null;
      if (match && link) {
        out.push({ t: 'link', ...link, c: parseArticleInline(match[1], depth + 1, false) });
        i += match[0].length;
        continue;
      }
    } else if (ch === '*' && depth < MAX_INLINE_DEPTH) {
      if (source.startsWith('**', i)) {
        const end = source.indexOf('**', i + 2);
        if (end > i + 2 && !/^\s|\s$/u.test(source.slice(i + 2, end))) {
          out.push({ t: 'strong', c: parseArticleInline(source.slice(i + 2, end), depth + 1, allowLinks) });
          i = end + 2;
          continue;
        }
      } else {
        const rest = source.slice(i + 1);
        const end = rest.search(/\*/u);
        if (end > 0 && !/^\s|\s$/u.test(rest.slice(0, end))) {
          out.push({ t: 'em', c: parseArticleInline(rest.slice(0, end), depth + 1, allowLinks) });
          i += end + 2;
          continue;
        }
      }
    } else if (ch === 'h' && allowLinks && !(i > 0 && /[A-Za-z0-9]/u.test(source[i - 1])) && /^https?:\/\//u.test(source.slice(i, i + 8))) {
      const match = /^https?:\/\/[^\s\u0000- \u007f-￿<>"'`]+/u.exec(source.slice(i));
      if (match) {
        const text = match[0].replace(/[.,;:!?)\]]+$/u, '');
        const link = safeArticleLink(text);
        if (link) {
          out.push({ t: 'link', ...link, c: [{ t: 'text', v: text }] });
          i += text.length;
          continue;
        }
      }
    }
    pushText(out, ch);
    i += 1;
  }
  return out;
}

export function articleInlinePlainText(nodes) {
  return nodes.map((node) => (node.t === 'text' || node.t === 'code' ? node.v : articleInlinePlainText(node.c))).join('');
}

function headingSlug(text) {
  const slug = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/gu, '');
  return Array.from(slug).slice(0, 48).join('').replace(/-+$/u, '') || 'section';
}

export function articleBlocks(body) {
  const blocks = [];
  const slugCounts = new Map();
  let paragraph = [];
  let quote = [];
  let list = null;
  let fence = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join('\n');
    blocks.push({ kind: 'paragraph', text, inline: parseArticleInline(text) });
    paragraph = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    const text = quote.join('\n');
    blocks.push({ kind: 'quote', text, inline: parseArticleInline(text) });
    quote = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({ kind: 'list', ordered: list.ordered, items: list.items, itemsInline: list.items.map((item) => parseArticleInline(item)) });
    list = null;
  };
  const flushAll = () => { flushList(); flushQuote(); flushParagraph(); };
  const pushHeading = (level, raw) => {
    const inline = parseArticleInline(raw);
    const text = articleInlinePlainText(inline);
    const slug = headingSlug(text);
    const count = (slugCounts.get(slug) ?? 0) + 1;
    slugCounts.set(slug, count);
    blocks.push({ kind: 'heading', level, text, id: count === 1 ? `h-${slug}` : `h-${slug}-${count}`, inline });
  };

  for (const line of String(body ?? '').replaceAll('\r\n', '\n').split('\n')) {
    if (fence) {
      if (line.trim() === '```') {
        blocks.push({ kind: 'code', lang: fence.lang, text: fence.lines.join('\n') });
        fence = null;
      } else fence.lines.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) { flushAll(); continue; }
    if (trimmed.startsWith('```')) {
      flushAll();
      const lang = trimmed.slice(3).trim();
      fence = { lang: /^[A-Za-z0-9_+#.-]{1,20}$/u.test(lang) ? lang : '', lines: [] };
      continue;
    }
    if (trimmed.startsWith('### ')) { flushAll(); pushHeading(3, trimmed.slice(4).trim()); continue; }
    if (trimmed.startsWith('## ')) { flushAll(); pushHeading(2, trimmed.slice(3).trim()); continue; }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(trimmed)) { flushAll(); blocks.push({ kind: 'hr' }); continue; }
    if (trimmed === '>' || trimmed.startsWith('> ')) {
      flushList(); flushParagraph();
      quote.push(trimmed.slice(1).trim());
      continue;
    }
    const bullet = /^[-*] +(.*)$/u.exec(trimmed);
    const numbered = bullet ? null : /^\d{1,3}[.)] +(.*)$/u.exec(trimmed);
    if (bullet || numbered) {
      flushQuote(); flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((bullet ?? numbered)[1].trim());
      continue;
    }
    const image = /^!\[([^\]\n]{0,200})\]\(([^)\s]{1,2048})\)$/u.exec(trimmed);
    const imageSource = image ? safeArticleImageSource(image[2]) : null;
    if (image && imageSource) {
      flushAll();
      blocks.push({ kind: 'image', src: imageSource, alt: image[1].trim() });
      continue;
    }
    if (/^https?:\/\/\S+$/u.test(trimmed)) {
      const id = articleYouTubeId(trimmed);
      if (id) { flushAll(); blocks.push({ kind: 'embed', provider: 'youtube', id }); continue; }
    }
    flushList(); flushQuote();
    paragraph.push(trimmed);
  }
  if (fence) blocks.push({ kind: 'code', lang: fence.lang, text: fence.lines.join('\n') });
  flushAll();
  return blocks;
}

export function articleHeadingList(body) {
  return articleBlocks(body).flatMap((block) =>
    block.kind === 'heading' ? [{ id: block.id, level: block.level, text: block.text }] : []);
}

function appendInlineNodes(document, parent, nodes, hooks) {
  for (const node of nodes) {
    if (node.t === 'text') { parent.append(document.createTextNode(node.v)); continue; }
    if (node.t === 'code') {
      const code = document.createElement('code');
      code.textContent = node.v;
      parent.append(code);
      continue;
    }
    if (node.t === 'link') {
      // href は属性に置かない。クリックで Hub 内ならネイティブ詳細、外ならブラウザ面へ。
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'detail-link';
      button.title = node.href;
      button.onclick = () => hooks.openLink?.(node.href, node.external);
      appendInlineNodes(document, button, node.c, hooks);
      parent.append(button);
      continue;
    }
    const element = document.createElement(node.t === 'strong' ? 'strong' : 'em');
    appendInlineNodes(document, element, node.c, hooks);
    parent.append(element);
  }
}

/**
 * ブロックを DOM ノードへ。hooks: openLink(href, external)、hubAsset(img, path)、
 * createYouTubePlayer(document, {id, title})。窓の CSP は画像を Hub と i.ytimg.com に
 * 限るので、外部HTTPSの画像は読まずに「画像を開く」リンクへ落とす。
 */
export function renderArticleBodyNodes(document, body, hooks = {}) {
  const nodes = [];
  for (const block of articleBlocks(body)) {
    if (block.kind === 'heading') {
      const heading = document.createElement(`h${block.level + 1}`);
      heading.className = 'detail-h';
      heading.id = block.id;
      appendInlineNodes(document, heading, block.inline, hooks);
      nodes.push(heading);
    } else if (block.kind === 'paragraph') {
      const p = document.createElement('p');
      p.className = 'detail-p';
      appendInlineNodes(document, p, block.inline, hooks);
      nodes.push(p);
    } else if (block.kind === 'quote') {
      const q = document.createElement('blockquote');
      q.className = 'detail-quote';
      appendInlineNodes(document, q, block.inline, hooks);
      nodes.push(q);
    } else if (block.kind === 'list') {
      const list = document.createElement(block.ordered ? 'ol' : 'ul');
      list.className = 'detail-list';
      for (const item of block.itemsInline) {
        const li = document.createElement('li');
        appendInlineNodes(document, li, item, hooks);
        list.append(li);
      }
      nodes.push(list);
    } else if (block.kind === 'code') {
      const pre = document.createElement('pre');
      pre.className = 'detail-code';
      const code = document.createElement('code');
      if (block.lang) code.dataset.lang = block.lang;
      code.textContent = block.text;
      pre.append(code);
      nodes.push(pre);
    } else if (block.kind === 'hr') {
      const hr = document.createElement('hr');
      hr.className = 'detail-hr';
      nodes.push(hr);
    } else if (block.kind === 'image') {
      if (block.src.startsWith('/')) {
        const figure = document.createElement('figure');
        figure.className = 'detail-figure';
        const img = document.createElement('img');
        img.alt = block.alt;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        if (hooks.hubAsset) hooks.hubAsset(img, block.src);
        figure.append(img);
        if (block.alt) {
          const caption = document.createElement('figcaption');
          caption.textContent = block.alt;
          figure.append(caption);
        }
        nodes.push(figure);
      } else {
        const p = document.createElement('p');
        p.className = 'detail-p';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'detail-link';
        button.textContent = block.alt ? `画像を開く: ${block.alt}` : '画像を開く';
        button.title = block.src;
        button.onclick = () => hooks.openLink?.(block.src, true);
        p.append(button);
        nodes.push(p);
      }
    } else if (block.kind === 'embed') {
      const player = hooks.createYouTubePlayer?.(document, { id: block.id, title: 'YouTube動画' });
      if (player) nodes.push(player);
      else if (youtubeEmbedUrl(block.id)) {
        const p = document.createElement('p');
        p.className = 'detail-p';
        p.textContent = `https://www.youtube.com/watch?v=${block.id}`;
        nodes.push(p);
      }
    }
  }
  return nodes;
}
