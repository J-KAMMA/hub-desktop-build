const malformedUtf16 = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function validateReference(value) {
  try {
    if (!value || typeof value !== 'object' ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || !keys.every(key => ['title', 'url', 'text'].includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const limits = { title: 480, url: 8192, text: 32000 };
    if (!keys.every(key => Object.hasOwn(descriptors[key], 'value') &&
        typeof descriptors[key].value === 'string' &&
        descriptors[key].value.length <= limits[key] &&
        !malformedUtf16.test(descriptors[key].value))) return null;
    const { title, url, text } = Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
    if (/[\u0000-\u001F\u007F-\u009F]/u.test(url) || text.includes('\0')) return null;
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.href !== url) return null;
    return { title, url, text };
  } catch {
    return null;
  }
}

/** Displays only material already extracted for the explicit browser AI action. */
export function createBrowserAiReference({ document, host, open }) {
  let reference = null;
  host.hidden = true;

  function clear() {
    if (reference) {
      reference.url = null;
      reference.openButton.onclick = reference.closeButton.onclick = null;
      reference.card.replaceChildren();
      reference = null;
    }
    host.replaceChildren();
    host.hidden = true;
  }

  function show(value) {
    const snapshot = validateReference(value);
    if (!snapshot) return false;
    const card = document.createElement('section');
    card.className = 'rail-post-preview';
    const title = document.createElement('h3');
    title.textContent = snapshot.title;
    const source = document.createElement('p');
    source.className = 'meta';
    source.textContent = snapshot.url;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'AIへ渡した資料';
    const body = document.createElement('pre');
    body.className = 'rail-reader-body';
    body.textContent = snapshot.text;
    details.append(summary, body);
    const actions = document.createElement('div');
    actions.className = 'rail-post-preview-actions';
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.textContent = '元のページを開く';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = '閉じる';
    actions.append(openButton, closeButton);
    card.append(title, source, details, actions);
    clear();
    const next = { card, url: snapshot.url, openButton, closeButton };
    reference = next;
    openButton.onclick = () => {
      if (reference === next && next.url && card.parentNode === host && card.contains(openButton))
        open(next.url);
    };
    closeButton.onclick = () => { if (reference === next) clear(); };
    host.replaceChildren(card);
    host.hidden = false;
    return true;
  }

  return { show, clear, hasReference: () => reference !== null, matches: url => typeof url === 'string' && reference?.url === url && reference.card.parentNode === host && host.isConnected && !host.hidden };
}
