import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = dirname(fileURLToPath(import.meta.url));
const esbuild = createRequire(new URL("./workspace/package.json", import.meta.url))("esbuild");
// One pi-ai copy only: OAuth loaders register on module state (see pi-sidecar.src.mjs).
try {
  await readFile(resolve(root, "workspace/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/package.json"));
  throw new Error("nested pi-ai copy under pi-coding-agent; the bundled OAuth loaders would miss the runtime's copy");
} catch (error) { if (error.code !== "ENOENT") throw error; }
await esbuild.build({
  entryPoints: [resolve(root, "pi-sidecar.src.mjs")],
  outfile: resolve(root, "pi-sidecar.mjs"),
  nodePaths: [resolve(root, "workspace/node_modules")],
  bundle: true, format: "esm", platform: "node", target: "node22",
  banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
  plugins: [{
    name: "dsh-bundled-version",
    setup(build) {
      build.onLoad({ filter: /[\\/]@deepseek-ai[\\/]dsh-llm[\\/]lib[\\/]index\.js$/ }, async ({ path }) => {
        const source = await readFile(path, "utf8");
        const needle = 'createRequire(import.meta.url)("../package.json")';
        if (source.split(needle).length !== 2) throw new Error("DSH version lookup changed; review the pinned package before bundling");
        const { version } = JSON.parse(await readFile(resolve(dirname(path), "../package.json"), "utf8"));
        return { contents: source.replace(needle, JSON.stringify({ version })), loader: "js", resolveDir: dirname(path) };
      });
    },
  }],
});
