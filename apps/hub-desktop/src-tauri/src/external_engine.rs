//! Type-B external engines for AI work (docs/hub-harness-swap/PLAN.md, "外部 CLI 型", phase 3-4;
//! implemented 2026-10-19, owner-approved).
//!
//! An external engine is a CLI that runs its own agent loop in a separate process. Hub keeps the
//! tools, approvals, workspace, key and record:
//! - the engine gets only Hub's tools, over a per-run MCP server inside the bridge
//!   (`vendor/engine-bridge`); its own shell, file, web and sub-agent tools are switched off;
//! - it runs in an empty scratch folder under `engine-runs\<run>\e\` and never learns the
//!   workspace path (Hub's tools take workspace-relative paths only);
//! - the bridge starts it through `engine_jail.rs`: Low integrity, one-process job object;
//! - HOME, APPDATA, LOCALAPPDATA, XDG and TEMP point into the run folder, which is deleted when
//!   the run ends; telemetry and the engine's own uploads are off;
//! - the model is reached only through the run's BYOK proxy (`byok/proxy.rs`) with a one-time
//!   token: the API key never reaches the bridge or the engine;
//! - only a pinned build that passed `scripts/engine-escape.mjs` may run ([`TESTED`]); any other
//!   build is refused with `engine_version_unverified`, never run unconfined.
//!
//! Network is not blocked by the OS (decision 5): web tools are off, the model goes through the
//! proxy and proxy variables point at a dead end. The picker says so.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub(crate) const OPENCODE: &str = "opencode";
pub(crate) const DSH_CLI: &str = "dsh-cli";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Opencode,
    DshCli,
}

impl Kind {
    pub(crate) fn id(self) -> &'static str {
        match self {
            Kind::Opencode => OPENCODE,
            Kind::DshCli => DSH_CLI,
        }
    }
    fn pinned_version(self) -> &'static str {
        match self {
            Kind::Opencode => "1.19.3",
            Kind::DshCli => "0.2.1-rc.2",
        }
    }
    fn pinned_fingerprint(self) -> &'static str {
        match self {
            // SHA-256 of opencode-windows-x64 1.19.3 `bin/opencode.exe`.
            Kind::Opencode => "81bb8ddc61554dd8328fd1b69ef2411b54037c32838f8009b1066894696722e3",
            // deepseek-ai/deepseek-harness 687f282e8625c6b8d11ff58211a90524be2e4317, built with
            // `pnpm install --frozen-lockfile && pnpm run build`: SHA-256 over `apps/cli/lib/*.js`
            // in name order, each as `name\0content\0` ([`dsh_fingerprint`]).
            Kind::DshCli => "f1c01826313a46cc8f7b243b7a50c162b62e23972ba727359116ca20f1e0247d",
        }
    }
}

/// Engine builds that passed every check of `scripts/engine-escape.mjs`. Only these run.
struct Tested {
    kind: Kind,
    fingerprint: &'static str,
    passed_on: &'static str,
}

const TESTED: &[Tested] = &[];

fn tested(kind: Kind, fingerprint: &str) -> Option<&'static Tested> {
    TESTED.iter().find(|entry| entry.kind == kind && entry.fingerprint == fingerprint)
}

/// A located, pinned engine build ready to hand to the bridge.
#[derive(Clone, Debug)]
pub(crate) struct Resolved {
    pub kind: Kind,
    /// `opencode.exe`, or dsh's `apps/cli/lib/bin.js` (started with node).
    pub program: PathBuf,
    pub version: String,
}

fn opencode_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os("HUB_OPENCODE_BIN") {
        paths.push(PathBuf::from(path));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        paths.push(PathBuf::from(appdata).join(r"npm\node_modules\opencode-ai\node_modules\opencode-windows-x64\bin\opencode.exe"));
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        paths.push(PathBuf::from(home).join(r".opencode\bin\opencode.exe"));
    }
    paths
}

/// The registered dsh build: `HUB_DSH_CLI_ROOT`, else the root named by
/// `%APPDATA%\jkamma-hub\vendor\dsh-cli.json` (`scripts/install-dsh-cli.ps1`).
fn dsh_root() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("HUB_DSH_CLI_ROOT") {
        return Some(PathBuf::from(root));
    }
    let pointer = PathBuf::from(std::env::var_os("APPDATA")?).join(r"jkamma-hub\vendor\dsh-cli.json");
    let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(pointer).ok()?).ok()?;
    value["root"].as_str().map(PathBuf::from)
}

fn file_sha256(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

pub(crate) fn dsh_fingerprint(lib: &Path) -> Option<String> {
    let mut names: Vec<String> = std::fs::read_dir(lib).ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.ends_with(".js"))
        .collect();
    names.sort();
    let mut hasher = Sha256::new();
    for name in names {
        hasher.update(name.as_bytes());
        hasher.update([0]);
        hasher.update(std::fs::read(lib.join(&name)).ok()?);
        hasher.update([0]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

/// Hashing a 180 MB executable takes a while; keyed by path, size and modification time.
fn cached_fingerprint(path: &Path, compute: impl FnOnce() -> Option<String>) -> Option<String> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<(PathBuf, u64, std::time::SystemTime), String>>> = OnceLock::new();
    let meta = std::fs::metadata(path).ok()?;
    let key = (path.to_path_buf(), meta.len(), meta.modified().ok()?);
    let cache = CACHE.get_or_init(Default::default);
    if let Some(hit) = cache.lock().ok()?.get(&key) {
        return Some(hit.clone());
    }
    let value = compute()?;
    cache.lock().ok()?.insert(key, value.clone());
    Some(value)
}

/// Version string next to an installed build, for the refusal message only (never executed).
fn installed_version(kind: Kind, program: &Path) -> Option<String> {
    let manifest = match kind {
        Kind::Opencode => program.parent()?.parent()?.join("package.json"),
        Kind::DshCli => program.parent()?.parent()?.join("package.json"),
    };
    let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(manifest).ok()?).ok()?;
    value["version"].as_str().map(|v| v.chars().take(40).collect())
}

/// Why an engine cannot run, as a stable code plus the operator-facing detail.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Unavailable {
    pub code: &'static str,
    pub detail: String,
}

fn locate(kind: Kind) -> Result<(PathBuf, String), Unavailable> {
    let (program, fingerprint) = match kind {
        Kind::Opencode => {
            let program = opencode_candidates().into_iter().find(|path| path.is_file()).ok_or_else(|| Unavailable {
                code: "engine_not_installed",
                detail: format!("OpenCode {} が見つかりません。npm で opencode-ai@{} を入れると選べます。", kind.pinned_version(), kind.pinned_version()),
            })?;
            let fingerprint = cached_fingerprint(&program, || file_sha256(&program));
            (program, fingerprint)
        }
        Kind::DshCli => {
            let root = dsh_root().ok_or_else(|| Unavailable {
                code: "engine_not_installed",
                detail: "DeepSeek Harness（commit 687f282e のビルド）が登録されていません。".into(),
            })?;
            let lib = root.join(r"apps\cli\lib");
            let program = lib.join("bin.js");
            if !program.is_file() {
                return Err(Unavailable { code: "engine_not_installed", detail: "登録された DeepSeek Harness に apps/cli/lib/bin.js がありません。".into() });
            }
            let fingerprint = cached_fingerprint(&program, || dsh_fingerprint(&lib));
            (program, fingerprint)
        }
    };
    let fingerprint = fingerprint.ok_or_else(|| Unavailable { code: "engine_unreadable", detail: "エンジンのファイルを読めません。".into() })?;
    if fingerprint != kind.pinned_fingerprint() {
        let found = installed_version(kind, &program).unwrap_or_else(|| "不明な版".into());
        return Err(Unavailable {
            code: "engine_version_unverified",
            detail: format!("入っているのは {found} です。Hub が動かすのは、抜け道試験に通った {} の固定ビルドだけです。", kind.pinned_version()),
        });
    }
    Ok((program, fingerprint))
}

/// The engine build to run. `allow_untested` exists only for the escape suite itself.
pub(crate) fn resolve(kind: Kind, allow_untested: bool) -> Result<Resolved, Unavailable> {
    if !cfg!(windows) {
        return Err(Unavailable { code: "engine_jail_unsupported", detail: "外部エンジンは Windows でだけ動かせます。".into() });
    }
    if !allow_untested && !TESTED.iter().any(|entry| entry.kind == kind) {
        return Err(escape_tests_pending());
    }
    let (program, fingerprint) = locate(kind)?;
    if tested(kind, &fingerprint).is_none() && !allow_untested {
        return Err(Unavailable {
            code: "engine_version_unverified",
            detail: format!("{} {} はまだ抜け道試験に通っていません。", label(kind), kind.pinned_version()),
        });
    }
    Ok(Resolved { kind, program, version: kind.pinned_version().into() })
}

/// Shown while no build of an engine has passed the escape suite (TESTED has no entry for it).
fn escape_tests_pending() -> Unavailable {
    Unavailable { code: "engine_escape_tests_pending", detail: "抜け道の試験が未完了のため使えません。".into() }
}

fn label(kind: Kind) -> &'static str {
    match kind {
        Kind::Opencode => "OpenCode",
        Kind::DshCli => "DeepSeek Harness",
    }
}

/// One row of the engine picker. Display data only; `pi_work_start` resolves again.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub default: bool,
    pub available: bool,
    pub reason: Option<&'static str>,
    pub detail: Option<String>,
    pub version: &'static str,
    pub license: &'static str,
    pub source: &'static str,
    pub preview: bool,
    pub tools: &'static str,
    pub resume: &'static str,
    pub usage: &'static str,
    pub network: &'static str,
    pub tested_on: Option<&'static str>,
}

const B_TOOLS: &str = "Hub の道具だけ（MCP で渡す）。エンジン自前のシェル・ファイル・ウェブ・サブエージェントの道具は切ってある。";
const B_RESUME: &str = "同じエンジンでだけ続けられる。続きは新しいエンジンの会話に、Hub が保存した記録を渡し直して始める。";
const B_USAGE: &str = "トークン数はエンジンの報告を表示する。鍵は Hub の代理だけが持つ。";
const B_NETWORK: &str = "ネットワークは OS では止めていない。ウェブの道具を切り、モデルへの通信を Hub の代理に向け、プロキシを行き止まりにして防いでいる。";

pub(crate) fn catalog() -> Vec<EngineInfo> {
    let mut rows = vec![EngineInfo {
        id: "thin", label: "Hub（標準）", default: true, available: true, reason: None, detail: None,
        version: "Pi 1.3.0", license: "MIT（Pi）", source: "同梱", preview: false,
        tools: "Pi の道具。ファイルとコマンドはすべて Hub を通る。",
        resume: "再開できる。", usage: "Pi の報告。", network: "モデルへの通信だけ。", tested_on: None,
    }];
    for kind in [Kind::Opencode, Kind::DshCli] {
        let located = if TESTED.iter().any(|entry| entry.kind == kind) {
            locate(kind).map(|(_, fingerprint)| tested(kind, &fingerprint))
        } else {
            Err(escape_tests_pending())
        };
        let (available, reason, detail, tested_on) = match located {
            Ok(Some(entry)) => (true, None, None, Some(entry.passed_on)),
            Ok(None) => (false, Some("engine_version_unverified"),
                Some(format!("{} {} はまだ抜け道試験に通っていません。", label(kind), kind.pinned_version())), None),
            Err(why) => (false, Some(why.code), Some(why.detail), None),
        };
        let (available, reason, detail) = if cfg!(windows) { (available, reason, detail) } else {
            (false, Some("engine_jail_unsupported"), Some("外部エンジンは Windows でだけ動かせます。".into()))
        };
        rows.push(EngineInfo {
            id: kind.id(), label: label(kind), default: false, available, reason, detail,
            version: kind.pinned_version(), license: "MIT",
            source: if kind == Kind::Opencode { "利用者が入れたもの（固定版）" } else { "同梱（commit 687f282e のビルド）" },
            preview: kind == Kind::DshCli, tools: B_TOOLS, resume: B_RESUME, usage: B_USAGE, network: B_NETWORK, tested_on,
        });
    }
    rows
}

// ---------------------------------------------------------------------------
// Per-run folder

fn runs_base() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(base) = std::env::var_os("HUB_ENGINE_RUNS_DIR") {
        return Some(PathBuf::from(base));
    }
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("jkamma-hub").join("engine-runs"))
}

/// `engine-runs\<run>\`: the bridge makes `e\` (Low integrity, the engine's whole world) and the
/// jail writes `jail-stats.json` beside it. Dropping this removes the folder.
pub(crate) struct RunDir {
    pub path: PathBuf,
}

impl Drop for RunDir {
    fn drop(&mut self) {
        let path = self.path.clone();
        // The engine may still be exiting and hold files open; retry briefly off the runtime.
        std::thread::spawn(move || {
            for _ in 0..50 {
                if std::fs::remove_dir_all(&path).is_ok() || !path.exists() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        });
    }
}

pub(crate) fn create_run_dir() -> Result<RunDir, String> {
    let base = runs_base().ok_or("engine_run_dir_unavailable")?;
    std::fs::create_dir_all(&base).map_err(|_| "engine_run_dir_unavailable")?;
    // Leftovers of a crash: anything older than a day.
    if let Ok(entries) = std::fs::read_dir(&base) {
        let day = std::time::Duration::from_secs(24 * 3600);
        for entry in entries.filter_map(Result::ok) {
            let old = entry.metadata().ok().and_then(|meta| meta.modified().ok())
                .and_then(|time| time.elapsed().ok()).is_some_and(|age| age > day);
            if old {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    let path = base.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir(&path).map_err(|_| "engine_run_dir_unavailable")?;
    Ok(RunDir { path })
}

/// `vendor/engine-bridge/bridge.mjs`: `HUB_ENGINE_BRIDGE`, the repo copy, then the installed copy.
pub(crate) fn bridge_script() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("HUB_ENGINE_BRIDGE") {
        return Some(PathBuf::from(path));
    }
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("vendor").join("engine-bridge").join("bridge.mjs");
    if repo.is_file() {
        return Some(repo);
    }
    let base = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(base).join(r"jkamma-hub\vendor\engine-bridge\bridge.mjs"))
}

/// The jail is this executable (`--hub-engine-jail`). Tests run inside the test binary, so the
/// escape suite names the built app with `HUB_ENGINE_JAIL`.
pub(crate) fn jail_program() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(path) = std::env::var_os("HUB_ENGINE_JAIL") {
        return Ok(PathBuf::from(path));
    }
    std::env::current_exe().map_err(|_| "engine_jail_unavailable".into())
}

/// Environment for the bridge process (it builds the engine's own, much smaller environment).
pub(crate) fn bridge_env(resolved: &Resolved, run: &RunDir, jail: &Path) -> Vec<(String, String)> {
    vec![
        ("HUB_ENGINE_PROGRAM".into(), resolved.program.to_string_lossy().into_owned()),
        ("HUB_ENGINE_VERSION".into(), resolved.version.clone()),
        ("HUB_ENGINE_RUN_DIR".into(), run.path.to_string_lossy().into_owned()),
        ("HUB_ENGINE_JAIL".into(), jail.to_string_lossy().into_owned()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untested_or_unknown_builds_are_refused_with_a_clear_reason() {
        let dir = std::env::temp_dir().join(format!("hub-engine-{}", uuid::Uuid::new_v4()));
        let lib = dir.join(r"apps\cli\lib");
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join("bin.js"), "console.log('not the pinned build')").unwrap();
        std::fs::write(dir.join(r"apps\cli\package.json"), r#"{"version":"9.9.9"}"#).unwrap();
        let fingerprint = dsh_fingerprint(&lib).unwrap();
        assert_ne!(fingerprint, Kind::DshCli.pinned_fingerprint());
        assert_eq!(installed_version(Kind::DshCli, &lib.join("bin.js")).as_deref(), Some("9.9.9"));
        assert!(tested(Kind::DshCli, &fingerprint).is_none(), "an unknown build never counts as tested");
        // The fingerprint covers every top-level chunk, not just bin.js.
        std::fs::write(lib.join("chunk-x.js"), "x").unwrap();
        assert_ne!(dsh_fingerprint(&lib).unwrap(), fingerprint);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_picker_lists_thin_first_and_never_marks_an_untested_engine_available() {
        let rows = catalog();
        assert_eq!(rows[0].id, "thin");
        assert!(rows[0].default && rows[0].available);
        assert_eq!(rows.iter().filter(|row| row.default).count(), 1);
        for row in &rows[1..] {
            assert!(!row.default);
            if row.available {
                assert!(TESTED.iter().any(|entry| entry.kind.id() == row.id), "{}", row.id);
                assert!(row.tested_on.is_some());
            } else {
                assert!(row.reason.is_some() && row.detail.is_some());
            }
            assert!(row.network.contains("止めていない"), "type B says the network is not blocked");
        }
        assert!(rows.iter().any(|row| row.id == DSH_CLI && row.preview));
    }

    #[test]
    fn no_external_engine_is_selectable_or_startable_while_nothing_is_tested() {
        if !TESTED.is_empty() {
            return;
        }
        for row in catalog().iter().skip(1) {
            assert!(!row.available, "{}", row.id);
            assert_eq!(row.reason, Some("engine_escape_tests_pending"));
            assert_eq!(row.detail.as_deref(), Some("抜け道の試験が未完了のため使えません。"));
        }
        for kind in [Kind::Opencode, Kind::DshCli] {
            assert_eq!(resolve(kind, false).err().map(|why| why.code), Some("engine_escape_tests_pending"));
        }
    }

    #[test]
    fn every_tested_entry_is_a_pinned_build() {
        for entry in TESTED {
            assert_eq!(entry.fingerprint, entry.kind.pinned_fingerprint());
            assert!(entry.passed_on.len() == 10 && entry.passed_on.starts_with("20"));
        }
    }
}
