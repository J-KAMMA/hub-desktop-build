export function initRailTooltips(document, { delay = 500 } = {}) {
  const rail = document.querySelector('.icon-rail'), window = document.defaultView;
  if (!rail) return () => {};
  const tip = document.createElement('div');
  tip.id = 'rail-tooltip'; tip.className = 'rail-tooltip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
  document.body.append(tip);
  let active, timer = 0, suppressed = null;
  const buttonOf = node => node?.closest?.('.icon-rail button[aria-label]');
  const cancel = () => { if (timer) { window.clearTimeout(timer); timer = 0; } };
  const hide = () => {
    cancel();
    if (active) {
      const ids = (active.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== tip.id);
      if (ids.length) active.setAttribute('aria-describedby', ids.join(' ')); else active.removeAttribute('aria-describedby');
    }
    active = null; tip.hidden = true;
  };
  const show = button => {
    if (!button) return;
    hide(); active = button; tip.textContent = button.getAttribute('aria-label');
    button.removeAttribute('title');
    button.setAttribute('aria-describedby', [button.getAttribute('aria-describedby'), tip.id].filter(Boolean).join(' '));
    tip.hidden = false;
    const rect = button.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(rect.right + 4, window.innerWidth - tip.offsetWidth - 8)) + 'px';
    tip.style.top = Math.max(8, Math.min(rect.top + (rect.height - tip.offsetHeight) / 2, window.innerHeight - tip.offsetHeight - 8)) + 'px';
  };
  const enter = event => {
    const button = buttonOf(event.target); if (!button || button === active || (button === suppressed && event.type !== 'focusin')) return;
    if (event.type === 'focusin' || delay <= 0) { show(button); return; }
    hide(); timer = window.setTimeout(() => { timer = 0; show(button); }, delay);
  };
  const leave = event => { if (buttonOf(event.relatedTarget) === buttonOf(event.target) && buttonOf(event.target)) return; suppressed = null; hide(); };
  const press = event => { suppressed = buttonOf(event.target) || null; hide(); };
  const escape = event => { if (event.key === 'Escape') hide(); };
  const listeners = [[rail, 'pointerover', enter], [rail, 'pointerout', leave], [rail, 'focusin', enter], [rail, 'focusout', hide], [rail, 'click', hide], [rail, 'pointerdown', press], [rail, 'mousedown', press], [document, 'keydown', escape], [document, 'scroll', hide, true], [window, 'resize', hide]];
  for (const [target, event, handler, capture] of listeners) target.addEventListener(event, handler, capture);
  return () => { hide(); tip.remove(); for (const [target, event, handler, capture] of listeners) target.removeEventListener(event, handler, capture); };
}
