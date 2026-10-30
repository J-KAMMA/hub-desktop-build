import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { channelAvatar, createSidebarRemote, durationSeconds, isShortVideo, renderChipRow, sidebarIcon, SIDEBAR_ICON_NAMES } from "./sidebar-media.mjs";

test("short videos are the ones known to last 60 seconds or less, never live", () => {
  assert.equal(durationSeconds("0:19"), 19);
  assert.equal(durationSeconds("1:02:03"), 3723);
  assert.equal(durationSeconds("PT45S"), 45);
  assert.equal(durationSeconds("PT1M"), 60);
  for (const bad of ["", "abc", "1:2:3:4", null, undefined, "PT"]) assert.equal(durationSeconds(bad), null);
  assert.equal(isShortVideo({ duration: "0:59" }), true);
  assert.equal(isShortVideo({ duration: "1:00" }), true);
  assert.equal(isShortVideo({ duration: "1:01" }), false);
  assert.equal(isShortVideo({ duration: "0:30", broadcastStatus: "live" }), false);
  assert.equal(isShortVideo({}), false);
});

test("avatars only load Hub's own /-relative images; anything else falls back to an initial", () => {
  const { document } = new JSDOM("").window;
  const seen = [];
  const resolve = (img, url) => { seen.push(url); img.src = `https://hub.invalid${url}`; };
  assert.equal(channelAvatar(document, { type: "profile", name: "あおい", avatarUrl: "/api/a.png" }, resolve).querySelector("img").width, 28);
  for (const url of ["https://evil.example/a.png", "//evil.example/a.png", "/a\\b.png", null]) {
    const slot = channelAvatar(document, { type: "profile", name: "ren", avatarUrl: url }, resolve);
    assert.equal(slot.querySelector("img"), null);
    assert.equal(slot.textContent, "R");
  }
  assert.equal(channelAvatar(document, { type: "video_channel", name: "Rick", avatarUrl: "/x.png" }, resolve).textContent, "R");
  assert.deepEqual(seen, ["/api/a.png"]);
});

test("icons are plain 24px line drawings", () => {
  const { document } = new JSDOM("").window;
  for (const name of SIDEBAR_ICON_NAMES) {
    const svg = sidebarIcon(document, name);
    assert.equal(svg.getAttribute("viewBox"), "0 0 24 24");
    assert.equal(svg.getAttribute("aria-hidden"), "true");
    assert.ok(svg.querySelector("path").getAttribute("d").length > 4);
  }
});

test("the chip row inverts the selected chip, marks tags, and shows a › button only when it overflows", () => {
  const { document } = new JSDOM("<div id=host></div>").window;
  const host = document.querySelector("#host");
  const picked = [];
  renderChipRow(document, host, { label: "絞り込み", chips: [
    { key: "", label: "すべて", kind: "all", selected: true },
    { key: "音楽", label: "音楽", kind: "category", selected: false },
    { key: "UI", label: "UI", kind: "tag", selected: false },
  ], onSelect: (chip) => picked.push(chip.key) });
  const chips = [...host.querySelectorAll(".sidebar-chip")];
  assert.deepEqual(chips.map((chip) => [chip.textContent, chip.getAttribute("aria-pressed")]), [["すべて", "true"], ["音楽", "false"], ["#UI", "false"]]);
  chips[2].click();
  assert.deepEqual(picked, ["UI"]);
  const track = host.querySelector(".sidebar-chip-track");
  assert.equal(host.querySelector(".sidebar-chip-step.is-next").hidden, true, "no overflow in jsdom: no button");
  Object.defineProperty(track, "scrollWidth", { value: 900 });
  Object.defineProperty(track, "clientWidth", { value: 300 });
  track.dispatchEvent(new document.defaultView.Event("scroll"));
  assert.equal(host.querySelector(".sidebar-chip-step.is-next").hidden, false);
  assert.equal(host.querySelector(".sidebar-chip-step.is-prev").hidden, true);
  renderChipRow(document, host, { label: "絞り込み", chips: [], onSelect() {} });
  assert.equal(host.hidden, true);
});

test("the channel loader reads page by page with the cursor and forgets everything when the account changes", async () => {
  let epoch = 1;
  const calls = [];
  const remote = createSidebarRemote({
    epoch: () => epoch, registered: () => true, changed: (kind) => calls.push(["changed", kind]),
    invoke: async (command, args) => {
      calls.push([args.name, ...args.ids]);
      return args.name === "sidebar"
        ? { followedTags: ["UI"], channels: [{ id: "a", name: "A" }, { id: "b", name: "B" }], nextCursor: "YQ" }
        : { channels: [{ id: "b", name: "B" }, { id: "c", name: "C" }], nextCursor: null };
    },
  });
  await remote.load("feed");
  await remote.load("feed");
  assert.deepEqual(remote.tags(), ["UI"]);
  await remote.more("feed");
  await remote.more("feed");
  assert.deepEqual(remote.state("feed").items.map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(calls.filter(([name]) => name !== "changed"), [["sidebar", "feed"], ["sidebar_page", "feed", "YQ"]]);
  epoch = 2;
  assert.deepEqual(remote.state("feed").items, []);
  assert.deepEqual(remote.tags(), []);
});
