// 投稿の種類の導出。apps/hub/lib/posts/kind.ts の写し（docs/hub-unified-post/DESIGN.md 3）。
// 画面の札を出すためだけに使う。保存する種類はサーバーが決める。post-kind.test.mjs が kind.ts と同じ表で一致を確かめる。
// 上から最初に当たったもの：paper → video → music → article → post。返信はいつも post。
export const PAPER_LICENCE_IDS = Object.freeze([
  "arr", "cc-by-4.0", "cc-by-sa-4.0", "cc-by-nc-4.0", "cc-by-nc-sa-4.0", "cc-by-nd-4.0", "cc-by-nc-nd-4.0", "cc0-1.0",
  "hub-distribution-only",
]);
export const POST_KINDS = Object.freeze(["post", "article", "music", "video", "paper"]);
export const isPaperLicence = (value) => typeof value === "string" && PAPER_LICENCE_IDS.includes(value);
const present = (value) => typeof value === "string" && value.trim().length > 0;

export function derivePostKind(input = {}) {
  if (input.isReply) return "post";
  const attachments = input.attachments ?? [];
  const hasTitle = present(input.title);
  const anyGate = Boolean(input.gated) || attachments.some((a) => present(a.gateId));
  if (hasTitle && isPaperLicence(input.licence) && attachments.some((a) => a.type === "reference") && !anyGate) return "paper";
  if (attachments.some((a) => a.type === "video" || a.type === "external_video")) return "video";
  if (attachments.some((a) => a.type === "audio")) return "music";
  if (hasTitle && present(input.body)) return "article";
  return "post";
}

/** 札の記号名と短い語。 */
export const KIND_BADGE = Object.freeze({
  post: { icon: "bubble", label: "投稿" },
  article: { icon: "doc", label: "記事" },
  music: { icon: "music", label: "曲" },
  video: { icon: "video", label: "動画" },
  paper: { icon: "paper", label: "論文" },
});
