// ../../hub/lib/hub-network-client.ts
function normalizeHubOrigin(value) {
  if (typeof value !== "string" || value.length > 512) throw Error("Hub\u306EURL\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    throw Error("https:// \u304B\u3089\u59CB\u307E\u308BHub\u306EURL\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
  return url.origin;
}

// ../../hub/lib/research-fork-package.ts
var RESEARCH_FORK_BYTES = 1e6;
var invalid = () => {
  throw Error("\u516C\u958B\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u306E\u7248\u3092\u78BA\u8A8D\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002");
};
var record = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return invalid();
  return value;
};
var text = (value, max, min = 0) => typeof value === "string" && value.length >= min && value.length <= max && !/[\uD800-\uDFFF]/u.test(value) ? value : invalid();
var sha = (value) => typeof value === "string" && value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value) ? value : invalid();
var researchForkDigest = async (value) => `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
function researchForkPackagePath(id) {
  if (id.length !== 35 || !/^rp_[a-f0-9]{32}$/.test(id)) return invalid();
  return `/api/network/v1/research/${id}/fork`;
}
async function parseResearchForkPackage(input, origin, id) {
  origin = normalizeHubOrigin(origin);
  researchForkPackagePath(id);
  const raw = record(input, ["protocol", "project", "href", "snapshotHash", "documents"]);
  if (raw.protocol !== "hub.research-fork.v1" || raw.href !== `${origin}/v2/research/${id}` || !Array.isArray(raw.documents) || raw.documents.length > 20) return invalid();
  const p = record(raw.project, ["id", "title", "description", "license", "status", "updatedAt"]);
  if (p.id !== id || !["draft", "active", "paused", "completed"].includes(String(p.status))) return invalid();
  const project = { id, title: text(p.title, 240, 3), description: text(p.description, 5e3), license: p.license === null ? null : text(p.license, 200, 1), status: p.status, updatedAt: text(p.updatedAt, 64, 1) };
  if (!project.title.trim() || !Number.isFinite(Date.parse(project.updatedAt))) return invalid();
  let previous = "";
  const documents = [];
  for (const item of raw.documents) {
    const d = record(item, ["id", "title", "kind", "head", "body", "contentHash"]), docId = text(d.id, 128, 1), body = text(d.body, 1e5, 1), contentHash = sha(d.contentHash);
    if (!/^[A-Za-z0-9_.-]+$/.test(docId) || docId <= previous || !Number.isSafeInteger(d.head) || d.head < 1 || !["paper", "software", "dataset", "notebook"].includes(String(d.kind)) || !body.trim() || contentHash !== await researchForkDigest(body)) return invalid();
    const title = text(d.title, 240, 1);
    if (!title.trim()) return invalid();
    previous = docId;
    documents.push({ id: docId, title, kind: d.kind, head: d.head, body, contentHash });
  }
  const value = { protocol: "hub.research-fork.v1", project, href: raw.href, snapshotHash: sha(raw.snapshotHash), documents };
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > RESEARCH_FORK_BYTES || value.snapshotHash !== await researchForkDigest(JSON.stringify([value.href, project.title, project.description, project.license, project.status, project.updatedAt, documents]))) return invalid();
  return value;
}
export {
  RESEARCH_FORK_BYTES,
  parseResearchForkPackage,
  researchForkDigest,
  researchForkPackagePath
};
