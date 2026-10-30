import { writeFileSync } from "node:fs";

const repository = process.env.GITHUB_REPOSITORY;
const pubkey = process.env.TAURI_SIGNING_PUBLIC_KEY;
if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("invalid_repository");
if (!pubkey || pubkey.length < 32) throw new Error("missing_updater_public_key");
const config = {
  bundle: { createUpdaterArtifacts: true },
  plugins: { updater: { pubkey, endpoints: [`https://github.com/${repository}/releases/latest/download/latest.json`] } }
};
writeFileSync(new URL("../src-tauri/tauri.release.conf.json", import.meta.url), JSON.stringify(config));
