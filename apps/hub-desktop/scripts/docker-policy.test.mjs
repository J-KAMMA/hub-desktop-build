import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src-tauri/src/docker.rs", import.meta.url), "utf8").replace(/\s+/g, " ");
for (const required of [
  '"--network", "none"',
  '"--read-only"',
  '"--cap-drop", "ALL"',
  '"no-new-privileges"',
  '"--pids-limit", "64"',
  '"--memory", "512m"',
  '"{}:/workspace:ro"',
  '"{}:/output:rw"',
  'MAX_FILES: usize = 20',
  'MAX_FILE_BYTES: u64 = 10 * 1024 * 1024',
  'MAX_TOTAL_FILE_BYTES: u64 = 32 * 1024 * 1024'
]) {
  if (!source.includes(required)) throw new Error(`missing_policy:${required}`);
}
if (source.includes('/workspace:rw')) throw new Error('workspace_must_be_read_only');
console.log('docker isolation policy: ok');
