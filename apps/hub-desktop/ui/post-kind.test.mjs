import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { derivePostKind, PAPER_LICENCE_IDS, KIND_BADGE, POST_KINDS } from "./post-kind.mjs";

// 本物の apps/hub/lib/posts/kind.ts を型を外して読み込み、同じ表で JS の写しと比べる。
const root = new URL("../../hub/lib/posts/", import.meta.url);
const licenceSource = readFileSync(new URL("../../hub/lib/content-license.ts", import.meta.url), "utf8");
const ids = [...licenceSource.match(/CONTENT_LICENSE_IDS = \[([\s\S]*?)\] as const/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const typesSource = readFileSync(new URL("types.ts", root), "utf8");
const distribution = typesSource.match(/HUB_DISTRIBUTION_ONLY_LICENCE = "([^"]+)"/)[1];
let kindSource = stripTypeScriptTypes(readFileSync(new URL("kind.ts", root), "utf8"));
kindSource = kindSource.replace(/^import[^\n]*\n/gm, "");
const real = await import(`data:text/javascript;base64,${Buffer.from(`const CONTENT_LICENSE_IDS=${JSON.stringify(ids)};const HUB_DISTRIBUTION_ONLY_LICENCE=${JSON.stringify(distribution)};\n${kindSource}`).toString("base64")}`);

const TITLES = [null, "   ", "題"];
const BODIES = ["", "  ", "本文"];
const LICENCES = [null, "cc-by-4.0", "arr", "hub-distribution-only", "cc-by-nc-4.0", "GPL-3.0", "CC-BY-4.0"];
const REFS = [0, 1, 3];
const GATES = ["none", "post", "reference", "image"];
const MEDIA = [[], ["image"], ["audio"], ["video"], ["external_video"], ["audio", "video"], ["audio", "external_video", "image"]];

test("the licence allowlist matches kind.ts", () => {
  assert.deepEqual([...PAPER_LICENCE_IDS], [...real.PAPER_LICENCE_IDS]);
});

test("derivePostKind agrees with kind.ts on every combination", () => {
  let n = 0;
  for (const title of TITLES) for (const body of BODIES) for (const licence of LICENCES) for (const refs of REFS)
    for (const gate of GATES) for (const media of MEDIA) for (const isReply of [false, true]) {
      const attachments = [...media.map((type) => ({ type })), ...Array.from({ length: refs }, () => ({ type: "reference", gateId: gate === "reference" ? "g1" : null }))];
      if (gate === "image") attachments.push({ type: "image", gateId: "g2" });
      const input = { title, body, licence, isReply, gated: gate === "post", attachments };
      assert.equal(derivePostKind(input), real.derivePostKind(input), JSON.stringify(input));
      n++;
    }
  assert.ok(n > 1000);
});

test("every kind has a badge", () => {
  for (const kind of POST_KINDS) assert.ok(KIND_BADGE[kind].icon && KIND_BADGE[kind].label);
});
