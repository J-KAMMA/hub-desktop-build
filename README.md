# Hub Desktop build mirror

This repository is a build mirror of Hub Desktop. It exists only to build the Windows binary on free GitHub Actions minutes. The source of truth is the owner's private development repository; this is a single snapshot and carries no history. Do not open pull requests here.

## Licence

- `apps/hub`, `apps/hub-desktop`: AGPL-3.0-only (see `LICENSE`).
- `apps/hub-desktop/hub-loop`: MIT.
- `packages/content-tags`: MIT.
- Third-party code, fonts, data and assets keep their own licences (see `apps/hub-desktop/vendor`).

Only the files needed to run `cargo build --release` in `apps/hub-desktop/src-tauri` are included.

## Vendored third-party parts

Vendored and bundled third-party code (for example `apps/hub-desktop/vendor/pi-sidecar`, `vendor/dsh`, `vendor/browser-reader`, `ui/vendor`, and the adblock filter lists under `src-tauri/assets`) keeps its own licence and is not relicensed under AGPL-3.0-only. See `apps/hub-desktop/THIRD_PARTY_NOTICES.md` and the LICENSE files next to each vendored part.
