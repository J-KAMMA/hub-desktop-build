import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
test("all bundled JavaScript parses as browser ES modules", () => {
  const root = new URL("./", import.meta.url);
  for (const name of readdirSync(root).filter(name => /\.m?js$/.test(name) && !name.endsWith(".test.mjs"))) {
    execFileSync(process.execPath, ["--input-type=module", "--check"], {input: readFileSync(new URL(name, root)), encoding:"utf8"});
  }
});
