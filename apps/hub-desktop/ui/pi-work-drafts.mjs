import {PI_WORK_MAX_PROMPT_CHARS} from "./pi-work.mjs";

const invalid = () => { throw new Error("ai_draft_invalid"); };
const checkKey = key => { if (key !== null && (typeof key !== "string" || !key)) invalid(); };
const checkText = text => { if (typeof text !== "string") invalid(); };

export function piWorkDraftLength(text) {
  checkText(text);
  return [...text].length;
}

export function createPiWorkDrafts() {
  const drafts = new Map();
  return {
    get(key) { checkKey(key); return drafts.get(key) ?? ""; },
    switchTo(fromKey, toKey, currentText) {
      checkKey(fromKey); checkKey(toKey); checkText(currentText);
      drafts.set(fromKey, currentText);
      return fromKey === toKey ? currentText : drafts.get(toKey) ?? "";
    },
    forget(key) { checkKey(key); return drafts.delete(key); },
    append(currentText, externalDraft) {
      checkText(currentText); checkText(externalDraft);
      if (!externalDraft.trim()) invalid();
      const combined = currentText ? `${currentText}\n\n${externalDraft}` : externalDraft;
      if (piWorkDraftLength(combined) > PI_WORK_MAX_PROMPT_CHARS) throw new Error("ai_draft_too_long");
      return combined;
    }
  };
}
