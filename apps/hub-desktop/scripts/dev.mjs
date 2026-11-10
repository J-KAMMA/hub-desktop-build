import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, extname, resolve, sep } from "node:path";

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
  // Tauri の内蔵の配信は http://127.0.0.1:1430 で開く。YouTube は IP アドレスの埋め込み元を嫌い、
  // レーベルの曲を 150 で拒む（localhost と配布版の tauri.localhost は通る。2026-11-05 実測）。
  // そこで ui を localhost:1430 で自前で配り、devUrl をそこへ向ける。読み直しは Ctrl+R。
  const ui = resolve(desktop, "ui");
  const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
    ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".json": "application/json", ".woff2": "font/woff2", ".ico": "image/x-icon", ".wasm": "application/wasm" };
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const file = resolve(ui, "." + (path === "/" ? "/index.html" : path));
    if (file !== ui && !file.startsWith(ui + sep)) { response.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": types[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done, fail) => { server.once("error", fail); server.listen(1430, "127.0.0.1", done); });
  const config = JSON.stringify({ build: { devUrl: "http://localhost:1430" } });
  const child = spawn(process.execPath, [cli, "dev", "--config", config, ...process.argv.slice(2)], {
    cwd: desktop,
    stdio: "inherit",
  });
  child.once("error", (error) => { console.error(error.message); process.exitCode = 1; server.close(); });
  child.once("exit", (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); server.close(); });
}
