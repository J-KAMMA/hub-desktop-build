import { bindPopover } from './pi-model-picker.mjs';

// The three checkboxes stay the source of truth sent to pi_work_start; a preset only sets them.
// There is deliberately no full-access preset.
export const PI_PERMISSION_PRESETS = Object.freeze([
  { id: 'ask', label: '都度承認', write: false, exec: false, http: false, text: 'ファイルの読み取りのみ自動。書き込みは1件ずつ承認します。' },
  { id: 'write', label: '書き込みを許可', write: true, exec: false, http: false, text: 'このセッションのファイル書き込みを事前に許可します。実行・通信は使えません。' },
  { id: 'tools', label: 'コマンドと通信を使う', write: false, exec: true, http: true, text: 'コマンド実行とHTTPを使えます。書き込み・実行・送信は1件ずつ承認します。' }
]);
export const PI_PERMISSION_CUSTOM = Object.freeze({ id: 'custom', label: 'カスタム', text: '個別に設定した状態です。' });
export const PI_WRITE_CONFIRM_TEXT = 'このセッションでは書き込みの承認が省略されます。';
export const PI_VERIFY_NEEDS_EXEC_TEXT = '検証にはコマンド実行が必要です';
export const PI_PERMISSION_LOCKED_TEXT = '作業中は変更できません';

export function piPermissionPreset({ write, exec, http }) {
  return PI_PERMISSION_PRESETS.find(preset => preset.write === Boolean(write) && preset.exec === Boolean(exec) && preset.http === Boolean(http))?.id ?? 'custom';
}

export function createPiPermissionPresets(document, { chip, chipLabel, popover, checkboxes, presetButtons, customRow, confirmBox, confirmOk, confirmCancel, lockNote, verifyProgram, verifyWarning, verifyEnable, isLocked = () => false }) {
  let confirming = false, destroyed = false;
  const view = bindPopover(document, { trigger: chip, panel: popover, onOpen: () => sync() });
  const current = () => piPermissionPreset({ write: checkboxes.write.checked, exec: checkboxes.exec.checked, http: checkboxes.http.checked });
  const setFlags = preset => {
    for (const key of ['write', 'exec', 'http']) {
      if (checkboxes[key].checked === preset[key]) continue;
      checkboxes[key].checked = preset[key];
      checkboxes[key].dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
    }
  };
  function sync() {
    if (destroyed) return;
    const locked = isLocked(), id = current(), known = PI_PERMISSION_PRESETS.find(preset => preset.id === id) ?? PI_PERMISSION_CUSTOM;
    if (locked || id === 'write') confirming = false;
    chipLabel.textContent = known.label;
    chip.setAttribute('aria-label', `権限: ${known.label}`);
    chip.title = known.text;
    for (const button of presetButtons) {
      button.setAttribute('aria-checked', String(button.dataset.preset === id));
      button.disabled = locked;
    }
    customRow.hidden = id !== 'custom';
    confirmBox.hidden = !confirming;
    lockNote.hidden = !locked; lockNote.textContent = PI_PERMISSION_LOCKED_TEXT;
    const needsExec = verifyProgram.value.trim() !== '' && !checkboxes.exec.checked;
    verifyWarning.hidden = !needsExec; verifyEnable.disabled = locked;
  }
  // Returns what happened: 'locked', 'confirm' (waiting for the explicit 許可する), 'applied' or 'same'.
  function choose(id) {
    const preset = PI_PERMISSION_PRESETS.find(item => item.id === id);
    if (!preset || isLocked()) return 'locked';
    if (current() === id) { confirming = false; sync(); return 'same'; }
    if (id === 'write') { confirming = true; sync(); return 'confirm'; }
    confirming = false; setFlags(preset); sync(); return 'applied';
  }
  function confirmWrite() {
    if (!confirming || isLocked()) return 'locked';
    confirming = false; setFlags(PI_PERMISSION_PRESETS[1]); sync(); return 'applied';
  }
  function cancelConfirm() { confirming = false; sync(); }
  const listeners = [];
  const on = (node, type, handler) => { node.addEventListener(type, handler); listeners.push(() => node.removeEventListener(type, handler)); };
  for (const button of presetButtons) on(button, 'click', () => choose(button.dataset.preset));
  on(confirmOk, 'click', confirmWrite);
  on(confirmCancel, 'click', cancelConfirm);
  on(verifyEnable, 'click', () => choose('tools'));
  on(verifyProgram, 'input', sync);
  for (const box of Object.values(checkboxes)) on(box, 'change', sync);
  sync();
  return { sync, choose, confirmWrite, cancelConfirm, current, isConfirming: () => confirming, popover: view,
    destroy() { destroyed = true; for (const off of listeners) off(); view.destroy(); } };
}
