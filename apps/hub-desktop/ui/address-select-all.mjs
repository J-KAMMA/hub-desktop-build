// アドレス欄の選択挙動（Chrome/Edge と同じ）。
// 最初にフォーカスを得た時は全選択、フォーカス済みでのクリックは通常のキャレット、ドラッグ選択は妨げない。
export function attachAddressSelectAll(input) {
  if (!input || input.dataset?.addressSelectAll === '1') return () => {};
  input.dataset.addressSelectAll = '1';
  let focusingClick = false, startX = 0, startY = 0;
  const onMouseDown = (event) => {
    if (event.button !== 0) return;
    focusingClick = input.ownerDocument.activeElement !== input;
    startX = event.clientX; startY = event.clientY;
  };
  const onFocus = () => { input.select(); };
  const onMouseUp = (event) => {
    if (!focusingClick) return;
    focusingClick = false;
    const moved = Math.abs(event.clientX - startX) > 3 || Math.abs(event.clientY - startY) > 3;
    if (!moved) event.preventDefault(); // mouseup による選択解除だけを止める
  };
  input.addEventListener('mousedown', onMouseDown);
  input.addEventListener('focus', onFocus);
  input.addEventListener('mouseup', onMouseUp);
  return () => {
    input.removeEventListener('mousedown', onMouseDown);
    input.removeEventListener('focus', onFocus);
    input.removeEventListener('mouseup', onMouseUp);
    delete input.dataset.addressSelectAll;
  };
}
