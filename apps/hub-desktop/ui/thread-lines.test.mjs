import test from "node:test";
import assert from "node:assert/strict";
import { threadLinkFlags, applyThreadLinks, isDirectReply } from "./thread-lines.mjs";

const p = (id, replyToPostId = null, authorProfileId = "a") => ({ post: { id, replyToPostId, authorProfileId } });

test("direct parent above reply below connects", () => {
  const flags = threadLinkFlags([p("1"), p("2", "1"), p("3", "2", "b")]);
  assert.deepEqual(flags, [{ prev: false, next: true }, { prev: true, next: true }, { prev: true, next: false }]);
});

test("gap or unrelated rows end the line", () => {
  assert.deepEqual(threadLinkFlags([p("1"), p("3", "2"), p("4")]).map((f) => f.next || f.prev), [false, false, false]);
  assert.deepEqual(threadLinkFlags([p("1"), null, p("2", "1")]).map((f) => f.next || f.prev), [false, false, false]);
});

test("reply order must be parent first", () => {
  assert.equal(threadLinkFlags([p("2", "1"), p("1")]).some((f) => f.next), false);
  assert.equal(isDirectReply({ id: "1" }, { replyToPostId: null }), false);
});

test("selfOnly joins only same-author consecutive posts", () => {
  const flags = threadLinkFlags([p("1", null, "a"), p("2", "1", "a"), p("3", "2", "b")], { selfOnly: true });
  assert.deepEqual(flags, [{ prev: false, next: true }, { prev: true, next: false }, { prev: false, next: false }]);
  assert.equal(threadLinkFlags([p("1", null, ""), p("2", "1", "")], { selfOnly: true }).some((f) => f.next), false);
});

test("applyThreadLinks sets and clears classes", () => {
  const mk = () => { const s = new Set(); return { classList: { toggle: (c, on) => (on ? s.add(c) : s.delete(c)), has: (c) => s.has(c) } }; };
  const entries = [{ ...p("1"), node: mk() }, { ...p("2", "1"), node: mk() }, { ...p("9"), node: mk() }];
  applyThreadLinks(entries);
  assert.ok(entries[0].node.classList.has("has-thread-next"));
  assert.ok(entries[1].node.classList.has("has-thread-prev"));
  assert.ok(!entries[1].node.classList.has("has-thread-next"));
  assert.ok(!entries[2].node.classList.has("has-thread-prev"));
});
