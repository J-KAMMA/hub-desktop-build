import test from "node:test";
import assert from "node:assert/strict";
import {createPiWorkDrafts, piWorkDraftLength} from "./pi-work-drafts.mjs";

test("new and run drafts are independent and restore their exact text", () => {
  const drafts = createPiWorkDrafts();
  assert.equal(drafts.get(null), "");
  assert.equal(drafts.get("run-a"), "");
  assert.equal(drafts.switchTo(null, "run-a", "新規 😀\n "), "");
  assert.equal(drafts.switchTo("run-a", "run-b", "  続き\n\n"), "");
  assert.equal(drafts.switchTo("run-b", null, "別の作業"), "新規 😀\n ");
  assert.equal(drafts.switchTo(null, "run-a", "新規追記"), "  続き\n\n");
  assert.equal(drafts.get("run-b"), "別の作業");
});

test("repeated same-context new or history selections preserve and save current text", () => {
  const drafts = createPiWorkDrafts();
  for (const key of [null, "run-a"]) {
    assert.equal(drafts.switchTo(key, key, "initial"), "initial");
    assert.equal(drafts.switchTo(key, key, "edited 😀"), "edited 😀");
    assert.equal(drafts.get(key), "edited 😀");
    assert.equal(drafts.switchTo(key, key, ""), "");
    assert.equal(drafts.get(key), "");
  }
});

test("forget removes only the specified submitted context", () => {
  const drafts = createPiWorkDrafts();
  drafts.switchTo(null, "r1", "new");
  drafts.switchTo("r1", "r2", "one");
  drafts.switchTo("r2", null, "two");
  assert.equal(drafts.forget("r1"), true);
  assert.equal(drafts.get("r1"), "");
  assert.equal(drafts.get(null), "new");
  assert.equal(drafts.get("r2"), "two");
  assert.equal(drafts.forget("r1"), false);
  assert.equal(drafts.forget(null), true);
  assert.equal(drafts.get("r2"), "two");
});

test("draft instances never share state or retain forgotten contexts", () => {
  const first = createPiWorkDrafts(), second = createPiWorkDrafts();
  first.switchTo(null, "r1", "private fixture");
  assert.equal(second.get(null), "");
  second.switchTo(null, "r1", "other fixture");
  first.forget(null);
  assert.equal(first.get(null), "");
  assert.equal(second.get(null), "other fixture");
  assert.equal(createPiWorkDrafts().get(null), "");
});

const invalidKeys = [undefined, "", 0, 1, NaN, false, true, {}, [], Symbol("key"), new String("r1")];
const invalidTexts = [null, undefined, 0, false, {}, [], Symbol("text"), new String("text")];

test("invalid keys or text reject before saving any part of a context switch", () => {
  const drafts = createPiWorkDrafts();
  drafts.switchTo(null, "r1", "new saved");
  drafts.switchTo("r1", null, "run saved");
  const unchanged = () => {
    assert.equal(drafts.get(null), "new saved");
    assert.equal(drafts.get("r1"), "run saved");
  };
  for (const key of invalidKeys) {
    assert.throws(() => drafts.get(key), /ai_draft_invalid/);
    assert.throws(() => drafts.forget(key), /ai_draft_invalid/);
    assert.throws(() => drafts.switchTo(null, key, "must not save"), /ai_draft_invalid/);
    assert.throws(() => drafts.switchTo(key, "r1", "must not save"), /ai_draft_invalid/);
    unchanged();
  }
  for (const text of invalidTexts) {
    assert.throws(() => drafts.switchTo(null, "r1", text), /ai_draft_invalid/);
    assert.throws(() => drafts.switchTo(null, null, text), /ai_draft_invalid/);
    unchanged();
  }
});

test("context IDs remain exact nonempty strings without normalization or object coercion", () => {
  const drafts = createPiWorkDrafts();
  for (const key of ["null", "__proto__", "constructor", " ", "r:😀", "r1", "R1"]) {
    drafts.switchTo(key, key, key);
    assert.equal(drafts.get(key), key);
  }
  let coerced = false;
  const object = {toString() { coerced = true; return "r1"; }};
  assert.throws(() => drafts.switchTo(null, object, "new"), /ai_draft_invalid/);
  assert.equal(coerced, false);
  assert.equal(drafts.get(null), "");
});

test("typed over-limit text is preserved across switches instead of silently truncated", () => {
  const drafts = createPiWorkDrafts(), text = "😀".repeat(8001);
  drafts.switchTo(null, "r1", text);
  assert.equal(drafts.switchTo("r1", null, "run"), text);
  assert.equal(piWorkDraftLength(drafts.get(null)), 8001);
});

test("length counts Unicode codepoints rather than UTF16 units or graphemes", () => {
  assert.equal(piWorkDraftLength(""), 0);
  assert.equal(piWorkDraftLength("😀𠮷a"), 3);
  assert.equal(piWorkDraftLength("e\u0301"), 2);
  assert.equal(piWorkDraftLength("🇯🇵"), 2);
  assert.equal(piWorkDraftLength("👨‍👩‍👧‍👦"), 7);
  assert.equal(piWorkDraftLength("😀".repeat(8000)), 8000);
  for (const value of invalidTexts) assert.throws(() => piWorkDraftLength(value), /ai_draft_invalid/);
});

test("append adds one blank line and preserves both inputs without mutating saved drafts", () => {
  const drafts = createPiWorkDrafts();
  drafts.switchTo(null, "r1", "saved");
  assert.equal(drafts.append("", " external 😀 "), " external 😀 ");
  assert.equal(drafts.append(" typed \n", " external \n"), " typed \n\n\n external \n");
  assert.equal(drafts.append("  ", "draft"), "  \n\ndraft");
  assert.equal(drafts.get(null), "saved");
  assert.equal(drafts.get("r1"), "");
});

test("append accepts exactly 8000 codepoints including separator and rejects the next", () => {
  const drafts = createPiWorkDrafts();
  assert.equal(drafts.append("", "😀".repeat(8000)).length, 16000);
  assert.throws(() => drafts.append("", "😀".repeat(8001)), /ai_draft_too_long/);
  const current = "😀".repeat(7997);
  assert.equal(piWorkDraftLength(drafts.append(current, "x")), 8000);
  assert.throws(() => drafts.append(current, "xy"), /ai_draft_too_long/);
  assert.equal(piWorkDraftLength(drafts.append("a".repeat(7997), "𠮷")), 8000);
  assert.throws(() => drafts.append("a".repeat(7998), "𠮷"), /ai_draft_too_long/);
});

test("invalid append inputs and overflow never save or partially alter a draft", () => {
  const drafts = createPiWorkDrafts();
  drafts.switchTo(null, "r1", "saved new");
  drafts.switchTo("r1", null, "saved run");
  for (const value of invalidTexts) {
    assert.throws(() => drafts.append(value, "external"), /ai_draft_invalid/);
    assert.throws(() => drafts.append("current", value), /ai_draft_invalid/);
  }
  for (const value of ["", " ", "\t\r\n", "\uFEFF"]) assert.throws(() => drafts.append("current", value), /ai_draft_invalid/);
  assert.throws(() => drafts.append("x".repeat(8000), "y"), /ai_draft_too_long/);
  assert.equal(drafts.get(null), "saved new");
  assert.equal(drafts.get("r1"), "saved run");
});
