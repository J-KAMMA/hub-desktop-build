// research-git-browse.ts
function gitCommitOid(value) {
  return typeof value === "string" && (value.length === 40 || value.length === 64) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

// research-git-proposals.ts
var gitProposalId = (value) => typeof value === "string" && value.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
var gitProposalText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/\0|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value);

// research-git-application.ts
var gitBranchName = (value) => gitProposalText(value, 200) && new TextEncoder().encode(value).length <= 200 && !/[\x00-\x20\x7f\\]/u.test(value);

// research-git-import.ts
var GIT_IMPORT_MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
var GIT_IMPORT_MAX_METADATA_BYTES = 1024;
var GIT_IMPORT_MAX_HEADER_BYTES = 2048;
var metadataKeys = ["requestId", "branch", "baseOid", "headOid", "bundleSha256"];
var fail = (message = "invalid_git_import") => {
  throw Error(message);
};
var encoder = new TextEncoder();
var record = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return fail();
  return value;
};
var gitImportProjectId = (value) => typeof value === "string" && value.length === 35 && /^rp_[a-f0-9]{32}$/.test(value);
var gitImportBranchName = (value) => gitBranchName(value) && value !== "@" && !/[\u0080-\u009f~^:?*\[]|\.\.|@\{/u.test(value) && !value.endsWith(".") && value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
function parseGitImportMetadata(value) {
  const r = record(value, metadataKeys);
  if (!gitProposalId(r.requestId) || !gitImportBranchName(r.branch) || !gitCommitOid(r.baseOid) || !gitCommitOid(r.headOid) || r.baseOid.length !== r.headOid.length || r.baseOid === r.headOid || typeof r.bundleSha256 !== "string" || r.bundleSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(r.bundleSha256)) return fail();
  const metadata = { requestId: r.requestId, branch: r.branch, baseOid: r.baseOid, headOid: r.headOid, bundleSha256: r.bundleSha256 };
  if (encoder.encode(JSON.stringify(metadata)).length > GIT_IMPORT_MAX_METADATA_BYTES) return fail();
  return metadata;
}
var base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function encodeGitImportMetadataHeader(value) {
  const header = base64url(encoder.encode(JSON.stringify(parseGitImportMetadata(value))));
  if (header.length > GIT_IMPORT_MAX_HEADER_BYTES) return fail();
  return header;
}
function decodeGitImportMetadataHeader(value) {
  if (typeof value !== "string" || !value.length || value.length > GIT_IMPORT_MAX_HEADER_BYTES || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return fail();
  try {
    const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4)), (char) => char.charCodeAt(0));
    if (bytes.length > GIT_IMPORT_MAX_METADATA_BYTES || base64url(bytes) !== value) return fail();
    return parseGitImportMetadata(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)));
  } catch {
    return fail();
  }
}
function validateGitImportBundleLength(actualBytes, declaredLength) {
  if (!Number.isSafeInteger(actualBytes) || actualBytes < 1) return fail("invalid_git_import_length");
  if (actualBytes > GIT_IMPORT_MAX_BUNDLE_BYTES) return fail("git_import_bundle_too_large");
  if (declaredLength !== void 0) {
    if (typeof declaredLength !== "number" && (typeof declaredLength !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(declaredLength) || String(Number(declaredLength)) !== declaredLength)) return fail("invalid_git_import_length");
    const declared = Number(declaredLength);
    if (!Number.isSafeInteger(declared) || declared < 1) return fail("invalid_git_import_length");
    if (declared > GIT_IMPORT_MAX_BUNDLE_BYTES) return fail("git_import_bundle_too_large");
    if (declared !== actualBytes) return fail("invalid_git_import_length");
  }
  return actualBytes;
}
function binding(r, projectId, expected, keys) {
  const metadata = parseGitImportMetadata(expected);
  if (!gitImportProjectId(projectId) || r.projectId !== projectId || keys.some((key) => r[key] !== metadata[key]) || r.candidateBranch !== `hub-import/${metadata.requestId}`) return fail();
  return metadata;
}
function parseGitImportResult(value, projectId, expected, mode) {
  const r = record(value, [...metadataKeys, "projectId", "bundleBytes", "baseTreeOid", "headTreeOid", "objectFormat", "candidateBranch", "outcome"]);
  const metadata = binding(r, projectId, expected, metadataKeys), width = metadata.headOid.length;
  if (!gitCommitOid(r.baseTreeOid) || !gitCommitOid(r.headTreeOid) || r.baseTreeOid.length !== width || r.headTreeOid.length !== width || r.objectFormat !== (width === 40 ? "sha1" : "sha256") || typeof r.bundleBytes !== "number" || !(mode === "preview" ? r.outcome === "preview" : mode === "save" && (r.outcome === "imported" || r.outcome === "already_imported"))) return fail();
  validateGitImportBundleLength(r.bundleBytes);
  return { ...metadata, projectId, bundleBytes: r.bundleBytes, baseTreeOid: r.baseTreeOid, headTreeOid: r.headTreeOid, objectFormat: width === 40 ? "sha1" : "sha256", candidateBranch: r.candidateBranch, outcome: r.outcome };
}
function parseGitImportCheckResult(value, projectId, expected) {
  const keys = ["requestId", "branch", "baseOid", "headOid"];
  const r = record(value, [...keys, "projectId", "candidateBranch", "currentOid", "outcome"]), metadata = binding(r, projectId, expected, keys);
  if (r.currentOid !== null && (!gitCommitOid(r.currentOid) || r.currentOid.length !== metadata.headOid.length) || r.outcome !== (r.currentOid === metadata.headOid ? "imported" : "not_imported")) return fail();
  return { projectId, requestId: metadata.requestId, branch: metadata.branch, baseOid: metadata.baseOid, headOid: metadata.headOid, candidateBranch: r.candidateBranch, currentOid: r.currentOid, outcome: r.outcome };
}
export {
  GIT_IMPORT_MAX_BUNDLE_BYTES,
  GIT_IMPORT_MAX_HEADER_BYTES,
  GIT_IMPORT_MAX_METADATA_BYTES,
  decodeGitImportMetadataHeader,
  encodeGitImportMetadataHeader,
  gitImportBranchName,
  gitImportProjectId,
  parseGitImportCheckResult,
  parseGitImportMetadata,
  parseGitImportResult,
  validateGitImportBundleLength
};
