import { existsSync } from "node:fs";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(desktop, "../../node_modules/@tauri-apps/cli/tauri.js");

function hubIsRunning() {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port: 43127 });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => done(false));
    socket.once("timeout", () => { socket.destroy(); done(false); });
  });
}

if (!existsSync(cli)) {
  console.error("Tauri CLI がありません。リポジトリのルートで npm install を実行してください。");
  process.exitCode = 1;
} else if (await hubIsRunning()) {
  console.error("Hub が既に起動しています。開いている Hub を閉じてから npm run dev:hub-desktop を再実行してください。");
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, [cli, "dev", ...process.argv.slice(2)], {
    cwd: desktop,
    stdio: "inherit",
  });
  child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.once("exit", (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
}
