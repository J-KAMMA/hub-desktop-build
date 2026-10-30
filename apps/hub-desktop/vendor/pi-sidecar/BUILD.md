# pi-sidecar vendored build

Canonical home: `apps/hub-desktop/vendor/pi-sidecar/` — committed so any
checkout (and every parallel CI/dev session) can run `pi_work` with no
install step.

`pi-sidecar.mjs` is the single-file bundle the Hub runs:
`node pi-sidecar.mjs <model> <prompt>` in the leased workspace.

Resolution order in `pi_work.rs::default_script`, first hit wins:

1. `PI_WORK_SIDECAR` env (ops/test override)
2. this repo copy (`../vendor/pi-sidecar/` relative to `src-tauri`)
3. `%APPDATA%\jkamma-hub\vendor\pi-sidecar\pi-sidecar.mjs` — the installed
   app-data layout; copy the rebuilt bundle there when the installed app
   should pick changes up.

Source: `pi-sidecar.src.mjs` (reviewed). It imports
`@earendil-works/pi-coding-agent` 1.3.0, `@earendil-works/pi-ai` 1.3.0 (exact pins, one hoisted pi-ai copy),
`typebox` 1.3.x — the pinned versions live in `workspace/` (`npm ci` there
installs the build-time deps; `node_modules` is never committed).

Rebuild with Node 22 or later. Both SDK dependency trees and esbuild are pinned
by their lockfiles. No CLI profile or install script is needed:

```sh
npm ci --prefix workspace --ignore-scripts
npm ci --prefix ../dsh --ignore-scripts
node build.mjs
node --check pi-sidecar.mjs
```

The commands also work in PowerShell. The build resolves workspace dependencies
and embeds DSH's package version where the upstream LLM module uses a relative
runtime `createRequire()` lookup. It refuses to build if that pinned lookup
changes. The resulting bundle includes the DSH kernel; runtime node_modules
and the DSH CLI are not required. Retain `../dsh/LICENSE` with distributions.

The banner renames `createRequire` on purpose: esbuild already emits its own
`createRequire` import inside wrapped CJS modules, so an identically named one
collides. The `require` binding it creates satisfies dynamic `require(...)`
calls in CJS deps (cross-spawn et al.) that esbuild's ESM output cannot shim.

Model: `provider/modelId` resolved by pi's `~/.pi/agent/models.json`
(e.g. `ollama/qwen2.5:3b` against local Ollama). Tool calls cross stdio to
the Hub; the script itself performs no filesystem writes.

`node pi-sidecar.mjs --list-models` prints the full resolvable registry —
builtin providers plus models.json entries — as one
`{"type":"models","models":[...],"ready":[...]}` frame and exits; `ready` is
the subset whose provider auth resolves right now (absent when the check
stalls). The Hub picker endpoint serves this list.

Enabling a provider is a pi-local concern — Hub never handles keys:

- **Sidecar CLI:** `node pi-sidecar.mjs --set-key <provider>` reads the
  key from stdin and stores it via the runtime's own login into
  `~/.pi/agent/auth.json`. Supply stdin from a protected input source;
  writing the key in an `echo` command can leave it in shell history.
  `--auth-status` lists stored providers
  (metadata only, never values); `--remove-key <provider>` deletes one.
- **OAuth providers:** `node pi-sidecar.mjs --login <provider>` runs pi's
  OAuth flow (e.g. `openai-codex` for a ChatGPT subscription — no API key
  needed). Select prompts list numbered options on stderr (empty answer =
  default); `auth_url` events auto-open the system browser while a
  localhost callback races a `manual_code` paste fallback; device-code
  flows print the code and URI. Tokens are never printed — only the
  URLs/codes the user is meant to see.
- Env vars in the runner's environment: `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`,
  `DEEPSEEK_API_KEY`, … (full list in `pi --help`). Ambient auth applies
  only while nothing is stored for that provider.
- The pi TUI `/login` (OAuth flows) writes the same `auth.json`;
  `pi auth check --provider <id>` reports readiness.

OAuth bundling note: pi lazy-loads flow modules through a computed
specifier bundlers cannot follow, so the source registers
`registerBunOAuthFlows()` once at startup. It must register the **nested**
copy of pi-ai under `pi-coding-agent/node_modules/` (npm's lockfile-pinned
layout — `bundledLoaders` is per-module-instance state), which is why the
import uses a literal relative path into `workspace/node_modules/…`. If a
future install hoists pi-ai to a single copy, that path stops resolving
and the build fails — switch to the bare `@earendil-works/pi-ai/bun-oauth`
specifier then.

`PI_CODING_AGENT_DIR` redirects the whole agent dir — point it at a temp
dir to test credential commands without touching the real auth.json.
