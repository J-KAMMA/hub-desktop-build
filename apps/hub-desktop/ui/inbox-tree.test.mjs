import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./sidebar-context.fixture.mjs";

// 受信トレイの列は切り替え無しの木（2026-11-02、所有者の指定）：根「メール」と根「連絡先」（枝は DM の相手）。
const DATA = {
  currentProfileId: "me",
  profiles: [{ id: "me", displayName: "私" }, { id: "a", displayName: "あおい" }, { id: "b", displayName: "ひなた" }],
  conversations: [
    { id: "c1", participantIds: ["me", "a"], lastMessageAt: "2026-11-02T00:00:00Z" },
    { id: "c2", participantIds: ["me", "b"], lastMessageAt: "2026-11-01T00:00:00Z" },
  ],
};
const roots = (f) => [...f.document.querySelectorAll("#sidebar-context .sidebar-tree-root")].map((node) => node.textContent);
const kids = (f) => [...f.document.querySelectorAll("#sidebar-context .sidebar-tree-children .sidebar-contact-row")];

test("the inbox column is two roots, メール and 連絡先, with no switch and no 会話 heading", () => {
  const f = fixture();
  f.state.messagesData = DATA;
  for (const view of ["messages", "mail"]) {
    f.show(view);
    assert.deepEqual(roots(f), ["メール", "連絡先"], view);
    assert.equal(f.document.querySelector("#sidebar-context .sidebar-switch"), null, "no DM・メール・連絡先 switch");
    assert.equal(f.document.querySelector(".sidebar .brand h1").textContent, "", "no 会話 heading");
  }
  f.dom.window.close();
});

test("連絡先 holds one row per DM partner with an avatar, a name and a muted time, hung on the tree", () => {
  const f = fixture();
  f.state.messagesData = DATA;
  f.show("messages");
  const rows = kids(f);
  assert.deepEqual(rows.map((row) => row.querySelector(".sidebar-item-label").textContent), ["あおい", "ひなた"]);
  for (const row of rows) {
    assert.ok(row.querySelector(".sidebar-avatar"));
    assert.equal(row.querySelector(".sidebar-item-meta").textContent, "1時間前");
  }
  assert.ok(rows[0].classList.contains("is-tree-first"));
  assert.ok(rows[1].classList.contains("is-tree-last"));
  assert.equal(f.document.querySelector("#sidebar-context .sidebar-tree-children").getAttribute("aria-label"), "連絡先");
  f.dom.window.close();
});

test("clicking a person opens the thread and keeps the column; the clicked row becomes current", () => {
  const f = fixture();
  f.state.messagesData = DATA;
  f.show("messages");
  const before = f.document.querySelector("#sidebar-context").innerHTML;
  kids(f)[1].click();
  assert.deepEqual(f.calls.filter(([kind]) => kind === "openConversation"), [["openConversation", "c2"]]);
  assert.equal(roots(f).join(), "メール,連絡先", "same roots after the click");
  assert.equal(kids(f)[1].getAttribute("aria-current"), "true");
  assert.equal(kids(f)[0].getAttribute("aria-current"), null);
  assert.ok(before.includes("あおい"));
  f.dom.window.close();
});

test("clicking メール asks for the mail view, and the same tree stays while mail is shown", () => {
  const f = fixture();
  f.state.messagesData = DATA;
  f.show("messages");
  f.document.querySelector("#sidebar-context .sidebar-tree-root").click();
  f.show("mail");
  assert.deepEqual(roots(f), ["メール", "連絡先"]);
  assert.equal(f.document.querySelector("#sidebar-context .sidebar-tree-root").getAttribute("aria-current"), "true");
  f.dom.window.close();
});

test("with no partners yet: one quiet line and a 相手を探す child, no empty avatar", () => {
  const f = fixture();
  f.state.messagesData = { currentProfileId: "me", profiles: [], conversations: [] };
  f.show("messages");
  const notes = [...f.document.querySelectorAll("#sidebar-context .sidebar-tree-note")].map((node) => node.textContent);
  assert.deepEqual(notes, ["まだやり取りはありません"]);
  assert.ok([...f.document.querySelectorAll("#sidebar-context .sidebar-tree-children .sidebar-context-item")].some((node) => node.textContent === "相手を探す"));
  assert.equal(f.document.querySelector("#sidebar-context .sidebar-avatar"), null);
  f.dom.window.close();
});
