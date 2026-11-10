/*
 * Hub Desktop 用: 本文を DOM に組み立て、外部リンクは確認パネルを経由させ、
 * 釣り文句に当たる本文の上へ警告行を付ける。判定は link-safety.mjs / bait-warning.mjs。
 * 外部ブラウザを開く処理は呼び出し側が渡す（open）。通信はしない。
 */
import { inspectLink, leaveFacts, LEAVE_LABELS, segmentUrls } from './link-safety.mjs';
import { detectBait, BAIT_LABELS } from './bait-warning.mjs';

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 行き先の確認パネル。「開く」で open(href)、「やめる」で panel を外す。 */
export function leavePanel(doc, info, { open }) {
  const { facts, warnings } = leaveFacts(info);
  const panel = el(doc, 'span', 'outbound-link__panel');
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', LEAVE_LABELS.title);
  panel.append(el(doc, 'strong', 'outbound-link__title', LEAVE_LABELS.title));
  facts.forEach((fact, index) => panel.append(el(doc, 'span', index === 0 ? 'outbound-link__host' : 'outbound-link__fact', fact)));
  for (const warning of warnings) {
    const w = el(doc, 'span', 'outbound-link__warning', warning);
    w.setAttribute('role', 'alert');
    panel.append(w);
  }
  const actions = el(doc, 'span', 'outbound-link__actions');
  const go = el(doc, 'button', 'outbound-link__open', LEAVE_LABELS.open);
  go.type = 'button';
  go.addEventListener('click', () => { panel.remove(); open(info.href); });
  const cancel = el(doc, 'button', 'outbound-link__cancel', LEAVE_LABELS.cancel);
  cancel.type = 'button';
  cancel.addEventListener('click', () => panel.remove());
  actions.append(go, cancel);
  panel.append(actions);
  return panel;
}

/**
 * 本文 text を <p> にして返す。釣り文句に当たれば先頭に警告行を付けた <div> を返す。
 * 内部リンクは open(href, {internal:true}) で直接、外部は確認パネル経由。
 */
export function renderUserText(doc, text, { open, hubHosts = [], className = '' } = {}) {
  const p = el(doc, 'p', className);
  for (const part of segmentUrls(String(text ?? ''))) {
    if (part.t === 'text') { p.append(doc.createTextNode(part.v)); continue; }
    const info = inspectLink(part.v, { hubHosts });
    if (!info.ok) { p.append(doc.createTextNode(part.v)); continue; }
    const a = el(doc, 'a', 'translated-text__link', part.v);
    a.href = info.href;
    a.rel = 'noopener noreferrer nofollow ugc';
    a.addEventListener('click', (event) => {
      event.preventDefault();
      if (info.internal) { open(info.href, { internal: true }); return; }
      const next = a.nextElementSibling;
      if (next?.classList?.contains('outbound-link__panel')) { next.remove(); return; }
      a.after(leavePanel(doc, info, { open: (href) => open(href, { internal: false }) }));
    });
    p.append(a);
  }
  if (!detectBait(String(text ?? '')).flagged) return p;
  const wrap = el(doc, 'div', 'bait-warning-wrap');
  const row = el(doc, 'div', 'bait-warning');
  row.setAttribute('role', 'note');
  row.append(el(doc, 'span', 'bait-warning__icon', BAIT_LABELS.icon), el(doc, 'span', 'bait-warning__text', `${BAIT_LABELS.short} ${BAIT_LABELS.notice}`));
  wrap.append(row, p);
  return wrap;
}

/**
 * 既存のリンク描画（renderContentReferenceLinks の openUrl など）から呼ぶ入口。
 * 内部リンクなら open(href) をそのまま呼び、外部なら anchor の直後に確認パネルを出す（もう一度押すと閉じる）。
 */
export function confirmLeave(doc, anchor, href, { open, hubHosts = [] }) {
  const info = inspectLink(href, { hubHosts });
  if (!info.ok || info.internal || !anchor) { open(href); return; }
  const next = anchor.nextElementSibling;
  if (next?.classList?.contains('outbound-link__panel')) { next.remove(); return; }
  anchor.after(leavePanel(doc, info, { open }));
}

/**
 * textContent で入れた本文（DM の吹き出し・自己紹介など）の直前に、釣り文句の警告行を足す。
 * 当たらなければ何もしない。本文は隠さない。足した行を返す（無ければ null）。
 */
export function addBaitRow(doc, textElement, text) {
  if (!detectBait(String(text ?? '')).flagged) return null;
  textElement.previousElementSibling?.classList?.contains('bait-warning') && textElement.previousElementSibling.remove();
  const row = el(doc, 'div', 'bait-warning');
  row.setAttribute('role', 'note');
  row.append(el(doc, 'span', 'bait-warning__icon', BAIT_LABELS.icon), el(doc, 'span', 'bait-warning__text', `${BAIT_LABELS.short} ${BAIT_LABELS.notice}`));
  textElement.before(row);
  return row;
}
