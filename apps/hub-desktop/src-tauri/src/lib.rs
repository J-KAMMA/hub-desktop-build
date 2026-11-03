pub mod engine_jail;
mod external_engine;
mod agent_discovery;
mod workspace_paths;
mod workspace_open;
mod windows_startup;
#[tauri::command]
fn pi_work_paths(window: tauri::Webview, cwd: String, query: String, limit: usize,
    kind: Option<String>, image_only: Option<bool>) -> Result<serde_json::Value, String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !local_pairing_address(window.label(), &url) { return Err("native_window_required".to_owned()); }
    workspace_paths::query(&cwd, &query, limit, kind.as_deref(), image_only)
}
#[tauri::command]
async fn browser_reader_read(app: tauri::AppHandle, webview: tauri::Webview, id: u64, url: String)
    -> Result<browser_window::reading::ReadingArticle, String> {
    browser_window::reading::read(app, webview, id, url).await
}
#[tauri::command]
async fn browser_reader_open(app: tauri::AppHandle, webview: tauri::Webview, id: u64, url: String, context_token: String)
    -> Result<browser_window::reading::ReadingOpened, String> {
    browser_window::reading::open(app, webview, id, url, context_token).await
}
#[tauri::command]
async fn browser_reader_close(app: tauri::AppHandle, webview: tauri::Webview, context_token: String)
    -> Result<browser_window::reading::ReadingClosed, String> {
    browser_window::reading::close(app, webview, context_token).await
}
mod agent_exec;
mod web_search;
mod agent_native;
mod agent_market;
mod agent_tools;
mod agent_usage;
mod cli_auth;
mod artifact_store;
mod browser_window;
mod window_fit;
mod window_material;
mod no_activate;
mod browser_site_permissions;
mod browser_bookmarks;
mod browser_favicon;
mod native_browser_tabs;
mod native_shell_resize;
mod native_sidebar;
mod shell_control;
mod desktop_control;
mod browser_ai_control;
mod desktop_control_protocol;
mod desktop_metrics;
mod checkpoint;
mod image_validation;
mod pi_images;
mod commerce;
mod compute_client;
mod content_e2ee;
mod content_protocol;
mod desktop_account;
mod desktop_wallet;
mod dev_cli;
mod docker;
mod game_launcher;
mod harness_adapter;
mod harness_context;
mod harness_control;
mod harness_workspace;
mod hub_client;
mod hub_network;
mod media_manifest;
mod media_cache;
mod portable_identity;
mod hub_window;
mod music_player;
mod native_video;
mod research_pdf_client;
mod research_change_file;
mod research_public_export;
mod personal_node_registration;
mod personal_node_reactivation;
mod ai_client;
mod byok;
mod local_ai;
mod local_cli;
mod mail_client;
mod music_attribution;
mod node_identity;
mod node_log;
mod node_store;
mod peer_node;
mod p2p_pairing;
mod research_git_bundle;
mod personal_node;
mod pi_sidecar;
mod pi_changes;
mod pi_work;
mod verification;
mod fast_check;
mod security;
mod single;
mod workspace_files;
mod local_data;
mod node_key_backup;
// スマートウォレット（第0段の試作・第1段）が使う WebAuthn P-256 の包み。
#[allow(dead_code)]
mod webauthn_p256;

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use rand::RngCore;
use security::{allowed_origins, canonical_workspace_root, validate_run, SecurityError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;
use tower_http::limit::RequestBodyLimitLayer;
use uuid::Uuid;

const SESSION_TTL: Duration = Duration::from_secs(300);
const JOB_TTL: Duration = Duration::from_secs(600);
const MAX_SESSIONS: usize = 4;
const MAX_JOBS_PER_SESSION: usize = 8;
const MAX_TOTAL_JOBS: usize = 32;

// The broader machine-side command gate remains limited to the bundled
// harness window. Pi work has its own narrower gate below for the Hub AI view.
fn local_address(label: &str, scheme: &str, host: &str, path: &str) -> bool {
    label == "harness"
        && path == "/index.html"
        && ((scheme == "tauri" && host == "localhost")
            || (matches!(scheme, "http" | "https") && host == "tauri.localhost"))
}
fn local_pi_address(label: &str, scheme: &str, host: &str, port: Option<u16>, path: &str) -> bool {
    matches!(label, "main" | "harness")
        && (path == "/index.html" || (label == "main" && path == "/"))
        && ((scheme == "tauri" && host == "localhost")
            || (matches!(scheme, "http" | "https") && host == "tauri.localhost")
            // Tauri dev serves this same app window from the local UI server.
            || (cfg!(debug_assertions)
                && scheme == "http"
                && matches!(host, "127.0.0.1" | "localhost")
                && port == Some(1430)))
}
pub(crate) fn native(window: &tauri::Webview) -> Result<(), String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !local_address(
        window.label(),
        url.scheme(),
        url.host_str().unwrap_or(""),
        url.path(),
    ) {
        return Err("native_window_required".into());
    }
    Ok(())
}
pub(crate) fn native_pi(window: &tauri::Webview) -> Result<(), String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !local_pi_address(
        window.label(),
        url.scheme(),
        url.host_str().unwrap_or(""),
        url.port(),
        url.path(),
    ) {
        return Err("native_window_required".into());
    }
    Ok(())
}

fn local_pairing_address(label: &str, url: &tauri::Url) -> bool {
    label == "main" && url.query().is_none() && url.fragment().is_none()
        && url.username().is_empty() && url.password().is_none()
        && matches!(url.path(), "/" | "/index.html")
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
            || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost") && url.port().is_none())
            || (cfg!(debug_assertions) && url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost")) && url.port() == Some(1430)))
}

#[tauri::command]
async fn p2p_pairing_request(window: tauri::Webview, request: p2p_pairing::PairingRequest) -> Result<p2p_pairing::PairingResponse, String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !local_pairing_address(window.label(), &url) { return Err("native_window_required".into()); }
    p2p_pairing::request(&hub_origin(), request).await
}

#[derive(Clone)]
pub struct RunnerState {
    inner: Arc<Mutex<Inner>>,
    origins: Vec<HeaderValue>,
    checkpoint: Option<Arc<checkpoint::CheckpointStore>>,
    node: Option<personal_node::PersonalNodeService>,
    games: Option<game_launcher::GameLibrary>,
    dev_runs: Arc<Mutex<dev_cli::DevRuns>>,
    /// Shared with the Tauri-managed instance through `.manage(clone())` —
    /// the native window and the paired-HTTP routes observe the same runs.
    pi_work: pi_work::PiWorkService,
}
struct Inner {
    sessions: HashMap<String, Instant>,
    jobs: HashMap<String, Job>,
    ai_jobs: HashMap<String, LocalAiJob>,
    file_writes: HashMap<String, PendingFileWrite>,
}
struct Job {
    owner: String,
    language: String,
    code: String,
    workspace: String,
    timeout_ms: u64,
    status: JobStatus,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    files: Vec<GeneratedArtifact>,
    created: Instant,
}
struct LocalAiJob {
    owner: String,
    status: LocalAiJobStatus,
    output: Option<local_ai::LocalOrchestrationResponse>,
    error: Option<String>,
    created: Instant,
    abort: Option<tokio::task::AbortHandle>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum JobStatus {
    PendingApproval,
    Running,
    Completed,
    Denied,
    Cancelled,
    Failed,
    IsolationUnavailable,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum LocalAiJobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalAiCheckpoint {
    id: String,
    status: LocalAiJobStatus,
    output: Option<local_ai::LocalOrchestrationResponse>,
    error: Option<String>,
}
struct PendingFileWrite {
    owner: String,
    workspace_root: String,
    relative_path: String,
    next_content: String,
    expected_previous: Option<String>,
    expected_next: String,
    created: Instant,
    status: FileWriteStatus,
    result: Option<workspace_files::FileWriteResult>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum FileWriteStatus {
    PendingApproval,
    Completed,
    Denied,
    Failed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    session_token: String,
    expires_in_seconds: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunRequest {
    language: String,
    code: String,
    workspace_root: String,
    network: bool,
    timeout_ms: u64,
    #[serde(default)]
    policy: local_ai::LocalExecutionPolicy,
}
#[derive(Serialize)]
struct RunResponse {
    id: String,
    status: JobStatus,
}
#[derive(Serialize)]
pub struct ApprovalView {
    pub id: String,
    pub language: String,
    pub code: String,
    pub workspace_root: String,
    pub timeout_ms: u64,
    pub expires_in_seconds: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedArtifact {
    path: String,
    size_bytes: usize,
    content_base64: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunStatus {
    id: String,
    status: JobStatus,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    files: Vec<GeneratedArtifact>,
}
#[derive(Serialize)]
struct Health {
    status: &'static str,
    isolation: &'static str,
    checkpoint: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalAiJobView {
    id: String,
    status: LocalAiJobStatus,
    output: Option<local_ai::LocalOrchestrationResponse>,
    error: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileRequest {
    workspace_root: String,
    relative_path: String,
    #[serde(default)]
    policy: local_ai::LocalExecutionPolicy,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileSearchRequest {
    workspace_root: String,
    query: String,
    #[serde(default)]
    policy: local_ai::LocalExecutionPolicy,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileDiffRequest {
    workspace_root: String,
    relative_path: String,
    next_content: String,
    #[serde(default)]
    policy: local_ai::LocalExecutionPolicy,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileWriteRequest {
    workspace_root: String,
    relative_path: String,
    next_content: String,
    expected_previous_sha256: Option<String>,
    expected_next_sha256: String,
    #[serde(default)]
    policy: local_ai::LocalExecutionPolicy,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileRevisionRequest {
    workspace_root: String,
    relative_path: String,
    #[serde(default)]
    policy: local_ai::LocalExecutionPolicy,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileRestoreRequest {
    workspace_root: String,
    relative_path: String,
    revision_id: String,
    expected_current_sha256: Option<String>,
    #[serde(default)]
    policy: local_ai::LocalExecutionPolicy,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileWriteView {
    id: String,
    status: FileWriteStatus,
    result: Option<workspace_files::FileWriteResult>,
}
#[derive(Serialize)]
pub struct FileApprovalView {
    id: String,
    relative_path: String,
    workspace_root: String,
    expected_previous_sha256: Option<String>,
    expected_next_sha256: String,
    expires_in_seconds: u64,
}

impl RunnerState {
    pub fn new() -> Result<Self, SecurityError> {
        let origins = allowed_origins()?
            .into_iter()
            .map(|x| HeaderValue::from_str(&x).map_err(|_| SecurityError::InvalidRequest))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                sessions: HashMap::new(),
                jobs: HashMap::new(),
                ai_jobs: HashMap::new(),
                file_writes: HashMap::new(),
            })),
            origins,
            checkpoint: None,
            node: None,
            games: None,
            dev_runs: Arc::new(Mutex::new(dev_cli::DevRuns::default())),
            pi_work: pi_work::PiWorkService::default(),
        })
    }
    pub fn new_persistent() -> Result<Self, SecurityError> {
        let mut state = Self::new()?;
        if let Ok(store) = checkpoint::CheckpointStore::system() {
            let inner = Arc::get_mut(&mut state.inner)
                .expect("state is not shared")
                .get_mut();
            for saved in store.load_all::<LocalAiCheckpoint>() {
                let interrupted = matches!(
                    saved.status,
                    LocalAiJobStatus::Queued | LocalAiJobStatus::Running
                );
                let status = if interrupted {
                    LocalAiJobStatus::Failed
                } else {
                    saved.status
                };
                let error = if interrupted {
                    Some("runner_restarted".into())
                } else {
                    saved.error
                };
                inner.ai_jobs.insert(
                    saved.id,
                    LocalAiJob {
                        owner: String::new(),
                        status,
                        output: saved.output,
                        error,
                        created: Instant::now(),
                        abort: None,
                    },
                );
            }
            state.checkpoint = Some(Arc::new(store));
        }
        // Development history lives in its own directory: a failed run and a
        // failed AI job share a status, so one directory would mix them.
        if let Ok(runs) = checkpoint::CheckpointStore::named("development-runs") {
            state.dev_runs = Arc::new(Mutex::new(dev_cli::DevRuns::with_store(Arc::new(runs))));
        }
        state.pi_work = pi_work::PiWorkService::persistent();
        // Personal Node identity and settings. For everything else this app keeps
        // on disk, see docs/hub-desktop-local-data/INVENTORY.md.
        if let Some(dir) = personal_node_dir() {
            if let Ok(service) = personal_node::PersonalNodeService::load(dir.clone()) {
                state.node = Some(service);
            }
            if let Ok(games) = game_launcher::GameLibrary::load(dir) {
                state.games = Some(games);
            }
        }
        Ok(state)
    }
    fn save_ai_checkpoint(&self, id: &str, job: &LocalAiJob) {
        if let Some(store) = &self.checkpoint {
            let _ = store.save(
                id,
                &LocalAiCheckpoint {
                    id: id.into(),
                    status: job.status.clone(),
                    output: job.output.clone(),
                    error: job.error.clone(),
                },
            );
        }
    }
    pub async fn pending_runs(&self) -> Vec<ApprovalView> {
        let mut inner = self.inner.lock().await;
        inner.jobs.retain(|_, job| job.created.elapsed() < JOB_TTL);
        inner
            .jobs
            .iter()
            .filter_map(|(id, job)| {
                matches!(job.status, JobStatus::PendingApproval).then(|| ApprovalView {
                    id: id.clone(),
                    language: job.language.clone(),
                    code: job.code.clone(),
                    workspace_root: job.workspace.clone(),
                    timeout_ms: job.timeout_ms,
                    expires_in_seconds: JOB_TTL.saturating_sub(job.created.elapsed()).as_secs(),
                })
            })
            .collect()
    }
    pub async fn pending_file_writes(&self) -> Vec<FileApprovalView> {
        let mut inner = self.inner.lock().await;
        inner
            .file_writes
            .retain(|_, item| item.created.elapsed() < JOB_TTL);
        inner
            .file_writes
            .iter()
            .filter_map(|(id, item)| {
                matches!(item.status, FileWriteStatus::PendingApproval).then(|| FileApprovalView {
                    id: id.clone(),
                    relative_path: item.relative_path.clone(),
                    workspace_root: item.workspace_root.clone(),
                    expected_previous_sha256: item.expected_previous.clone(),
                    expected_next_sha256: item.expected_next.clone(),
                    expires_in_seconds: JOB_TTL.saturating_sub(item.created.elapsed()).as_secs(),
                })
            })
            .collect()
    }
    pub async fn approve_file_write(&self, id: &str) -> Result<(), SecurityError> {
        let mut inner = self.inner.lock().await;
        let item = inner
            .file_writes
            .get_mut(id)
            .ok_or(SecurityError::InvalidRequest)?;
        if !matches!(item.status, FileWriteStatus::PendingApproval) {
            return Err(SecurityError::InvalidRequest);
        }
        let root = canonical_workspace_root(&item.workspace_root)?;
        // The write is synchronous fs work; run it off the async worker
        // while the pending-write lock stays held for the status update.
        let write = {
            let path = item.relative_path.clone();
            let next = item.next_content.clone();
            let previous = item.expected_previous.clone();
            let expected = item.expected_next.clone();
            tokio::task::spawn_blocking(move || {
                workspace_files::write(&root, &path, &next, previous.as_deref(), &expected)
            })
            .await
            .unwrap_or_else(|_| Err("file_internal"))
        };
        match write {
            Ok(result) => {
                item.result = Some(result);
                item.status = FileWriteStatus::Completed
            }
            Err(_) => item.status = FileWriteStatus::Failed,
        }
        item.next_content.clear();
        Ok(())
    }
    pub async fn deny_file_write(&self, id: &str) -> Result<(), SecurityError> {
        let mut inner = self.inner.lock().await;
        let item = inner
            .file_writes
            .get_mut(id)
            .ok_or(SecurityError::InvalidRequest)?;
        item.next_content.clear();
        item.status = FileWriteStatus::Denied;
        Ok(())
    }
    pub async fn approve_from_desktop(&self, id: &str) -> Result<(), SecurityError> {
        let (language, code, workspace, timeout_ms) = {
            let mut inner = self.inner.lock().await;
            let job = inner
                .jobs
                .get_mut(id)
                .ok_or(SecurityError::InvalidRequest)?;
            if !matches!(job.status, JobStatus::PendingApproval) {
                return Err(SecurityError::InvalidRequest);
            }
            job.status = JobStatus::Running;
            (
                job.language.clone(),
                std::mem::take(&mut job.code),
                job.workspace.clone(),
                job.timeout_ms,
            )
        };
        let state = self.clone();
        let job_id = id.to_owned();
        tokio::spawn(async move {
            let result = docker::execute(
                &job_id,
                &language,
                code,
                std::path::Path::new(&workspace),
                timeout_ms,
            )
            .await;
            let mut inner = state.inner.lock().await;
            if let Some(job) = inner.jobs.get_mut(&job_id) {
                if matches!(job.status, JobStatus::Cancelled) {
                    return;
                }
                match result {
                    Ok(output) => {
                        job.stdout = output.stdout;
                        job.stderr = output.stderr;
                        job.exit_code = output.exit_code;
                        job.files = output
                            .files
                            .into_iter()
                            .map(|file| GeneratedArtifact {
                                path: file.path,
                                size_bytes: file.bytes.len(),
                                content_base64: STANDARD.encode(file.bytes),
                            })
                            .collect();
                        job.status = if output.timed_out || output.exit_code != Some(0) {
                            JobStatus::Failed
                        } else {
                            JobStatus::Completed
                        };
                    }
                    Err(error) => {
                        job.stderr = error;
                        job.status = JobStatus::IsolationUnavailable;
                    }
                }
            }
        });
        Ok(())
    }
    pub async fn deny_from_desktop(&self, id: &str) -> Result<(), SecurityError> {
        let mut inner = self.inner.lock().await;
        let job = inner
            .jobs
            .get_mut(id)
            .ok_or(SecurityError::InvalidRequest)?;
        job.code.clear();
        job.status = JobStatus::Denied;
        Ok(())
    }
    async fn issue_session(&self, origin: &HeaderValue) -> Result<String, SecurityError> {
        if !self.origins.iter().any(|allowed| allowed == origin) {
            return Err(SecurityError::Unauthorized);
        }
        let mut inner = self.inner.lock().await;
        let now = Instant::now();
        inner.sessions.retain(|_, until| *until > now);
        if inner.sessions.len() >= MAX_SESSIONS {
            return Err(SecurityError::CapacityExceeded);
        }
        let token = random_token(32);
        inner
            .sessions
            .insert(token.clone(), Instant::now() + SESSION_TTL);
        Ok(token)
    }
    async fn require_session(&self, token: &str) -> Result<(), SecurityError> {
        let mut inner = self.inner.lock().await;
        let now = Instant::now();
        inner.sessions.retain(|_, until| *until > now);
        if inner.sessions.contains_key(token) {
            Ok(())
        } else {
            Err(SecurityError::Unauthorized)
        }
    }
    async fn disconnect(&self, token: &str) -> Result<(), SecurityError> {
        self.require_session(token).await?;
        let jobs = {
            let mut inner = self.inner.lock().await;
            inner.sessions.remove(token);
            let jobs = inner
                .jobs
                .iter()
                .filter_map(|(id, job)| (job.owner == token).then_some(id.clone()))
                .collect::<Vec<_>>();
            for job in inner.ai_jobs.values().filter(|job| job.owner == token) {
                if let Some(abort) = &job.abort {
                    abort.abort();
                }
            }
            inner.jobs.retain(|_, job| job.owner != token);
            inner.ai_jobs.retain(|_, job| job.owner != token);
            jobs
        };
        for id in jobs {
            docker::cancel(&id).await;
        }
        Ok(())
    }
    async fn cancel(&self, token: &str, id: &str) -> Result<(), SecurityError> {
        self.require_session(token).await?;
        {
            let mut inner = self.inner.lock().await;
            let job = inner
                .jobs
                .get_mut(id)
                .ok_or(SecurityError::InvalidRequest)?;
            if job.owner != token
                || !matches!(job.status, JobStatus::PendingApproval | JobStatus::Running)
            {
                return Err(SecurityError::InvalidRequest);
            }
            job.code.clear();
            job.status = JobStatus::Cancelled;
        }
        docker::cancel(id).await;
        Ok(())
    }
}

pub fn router(state: Arc<RunnerState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(state.origins.clone())
        .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            axum::http::HeaderName::from_static("x-hub-client-id"),
        ])
        .expose_headers([axum::http::HeaderName::from_static("x-run-version")]);
    // Tests inspect this complete builder expression: every HTTP capability
    // must remain reviewable as one closed list, separate from Tauri-only commands.
    Router::new()
        .route("/health", get(health))
        .route("/show", post(http_show_running))
        .route("/pending", get(http_pending))
        .route("/local-window/show", post(http_show_local))
        .route("/game-window/show", post(http_show_games))
        .route("/browser-window/show", post(http_show_browser))
        .route("/pair", post(pair))
        .route("/disconnect", post(disconnect))
        .route("/local-ai/models", get(local_models))
        .route("/local-ai/chat", post(local_chat))
        .route("/local-cli/agents", get(local_cli_agents))
        .route("/local-cli/run", post(local_cli_run))
        .route("/dev/harnesses", get(http_dev_agents))
        .route("/dev/agents", get(http_dev_agents))
        .route("/dev/usage/:agent", get(http_dev_usage))
        .route("/dev/harnesses/:agent/auth", get(http_dev_auth))
        .route("/dev/history", get(http_dev_history))
        .route("/dev/workspace", get(http_dev_workspace))
        .route("/dev/workspace/pick", post(http_pick_dev_workspace))
        .route(
            "/dev/runs",
            post(http_start_dev_run).get(http_active_dev_run),
        )
        .route("/dev/runs/:id", get(http_get_dev_run))
        .route("/dev/runs/:id/cancel", post(http_cancel_dev_run))
        .route("/dev/runs/:id/revert", post(http_revert_dev_run))
        // Approvals used to be native-window only; the Hub surface is now
        // the harness, so a paired session decides — same human, different
        // screen. Every handler still requires a live pairing token.
        .route("/dev/runs/:id/approve", post(http_approve_dev_run))
        .route("/dev/runs/:id/deny", post(http_deny_dev_run))
        .route("/dev/runs/:id/verification", post(http_decide_dev_verification))
        .route(
            "/pi-work/runs",
            get(http_pi_work_list).post(http_pi_work_start),
        )
        .route("/pi-work/models", get(http_pi_work_models))
        .route("/pi-work/runs/:id", get(http_pi_work_status))
        .route("/pi-work/runs/:id/decide", post(http_pi_work_decide))
        .route("/pi-work/runs/:id/cancel", post(http_pi_work_cancel))
        .route("/runs/:id/approve", post(http_approve_run))
        .route("/runs/:id/deny", post(http_deny_run))
        .route("/files/write/:id/approve", post(http_approve_file_write))
        .route("/files/write/:id/deny", post(http_deny_file_write))
        .route("/node/status", get(node_status))
        .route("/node/sign", post(http_sign_node))
        .route("/node/events", get(http_pending_events))
        .route(
            "/node/events/:sequence/delivered",
            post(http_mark_delivered),
        )
        .route("/node/content/preview", post(http_preview_public_content))
        .route(
            "/node/content/private/preview",
            post(http_preview_private_content),
        )
        .route("/node/content/publish", post(http_publish_public_content))
        .route("/node/artifacts/begin", post(http_begin_artifact_upload))
        .route(
            "/node/artifacts/:artifact_id/chunks/:index",
            post(http_put_artifact_chunk).get(http_artifact_chunk),
        )
        .route(
            "/node/artifacts/:upload_id/finalize",
            post(http_finalize_artifact_upload),
        )
        .route(
            "/node/artifacts/:upload_id/finalize-private",
            post(http_finalize_private_artifact_upload),
        )
        .route(
            "/node/artifacts/:digest/manifest",
            get(http_artifact_manifest),
        )
        .route("/node/peers", get(http_list_peers))
        .route("/node/inbox", get(http_peer_inbox_list))
        .route(
            "/node/inbox/:delivery_id/decrypt",
            post(http_decrypt_peer_content),
        )
        .route("/node/peers/preview", post(http_preview_peer))
        .route("/node/peers/confirm", post(http_confirm_peer))
        .route(
            "/node/peers/:peer_id/events/:sequence",
            post(http_deliver_peer_event),
        )
        .route("/p2p/v1/identity", get(http_peer_identity))
        .route("/p2p/v1/inbox", post(http_peer_inbox))
        .route(
            "/p2p/v1/blobs/:digest/manifest",
            get(http_peer_blob_manifest),
        )
        .route(
            "/p2p/v1/blobs/:digest/chunks/:index",
            get(http_peer_blob_chunk),
        )
        .route("/node/settings", post(update_node_settings))
        .route("/node/sync", post(sync_node))
        .route("/local-ai/orchestrate", post(local_orchestrate))
        .route("/local-ai/jobs", post(create_local_ai_job))
        .route("/local-ai/jobs/:id", get(get_local_ai_job))
        .route("/local-ai/jobs/:id/cancel", post(cancel_local_ai_job))
        .route("/files/read", post(file_read))
        .route("/files/search", post(file_search))
        .route("/files/diff", post(file_diff))
        .route("/files/write", post(file_write))
        .route("/files/write/:id", get(get_file_write))
        .route("/files/revisions", post(file_revisions))
        .route("/files/restore", post(file_restore))
        .route("/runs", post(create_run))
        .route("/runs/:id", get(get_run))
        .route("/runs/:id/cancel", post(cancel_run))
        .layer(RequestBodyLimitLayer::new(1100 * 1024))
        .layer(cors)
        .with_state(state)
}
async fn health(State(state): State<Arc<RunnerState>>) -> Json<Health> {
    Json(Health {
        status: "ok",
        isolation: if docker::isolation_available().await {
            "docker"
        } else {
            "unavailable"
        },
        checkpoint: if state.checkpoint.is_some() {
            "encrypted"
        } else {
            "unavailable"
        },
    })
}
async fn pair(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<PairResponse>, AppError> {
    let origin = headers
        .get(header::ORIGIN)
        .ok_or_else(AppError::unauthorized)?;
    let session_token = state.issue_session(origin).await.map_err(AppError::from)?;
    Ok(Json(PairResponse {
        session_token,
        expires_in_seconds: SESSION_TTL.as_secs(),
    }))
}
async fn disconnect(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<StatusCode, AppError> {
    let token = bearer(&headers)?;
    state.disconnect(&token).await.map_err(AppError::from)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn local_models(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<local_ai::LocalModel>>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    Ok(Json(local_ai::models().await))
}
async fn local_chat(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<local_ai::LocalChatRequest>,
) -> Result<Json<local_ai::LocalChatResponse>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    local_ai::chat(input)
        .await
        .map(Json)
        .map_err(|error| AppError(StatusCode::BAD_GATEWAY, error))
}
// Where the Personal Node file lives. Kept beside the app's own data rather
// than in the workspace, so a repository checkout never carries device identity.
fn personal_node_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("APPDATA").or_else(|| std::env::var_os("HOME"))?;
    Some(std::path::PathBuf::from(base).join("jkamma-hub"))
}
async fn node_status(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<personal_node::NodeState>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state
        .node
        .as_ref()
        .ok_or_else(|| AppError(StatusCode::SERVICE_UNAVAILABLE, "node_storage_unavailable"))?;
    Ok(Json(node.status().await))
}
async fn update_node_settings(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<personal_node::UpdateNodeSettings>,
) -> Result<Json<personal_node::NodeState>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state
        .node
        .as_ref()
        .ok_or_else(|| AppError(StatusCode::SERVICE_UNAVAILABLE, "node_storage_unavailable"))?;
    node.update(input)
        .await
        .map(Json)
        .map_err(|error| AppError(StatusCode::BAD_REQUEST, error))
}
async fn sync_node(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<personal_node::NodeState>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state
        .node
        .as_ref()
        .ok_or_else(|| AppError(StatusCode::SERVICE_UNAVAILABLE, "node_storage_unavailable"))?;
    node.mark_sync()
        .await
        .map(Json)
        .map_err(|error| AppError(StatusCode::BAD_REQUEST, error))
}
async fn local_cli_agents(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<local_cli::CliAgent>>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    Ok(Json(local_cli::agents()))
}
async fn local_cli_run(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<local_cli::CliRequest>,
) -> Result<Json<local_cli::CliResponse>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    local_cli::run(input)
        .await
        .map(Json)
        .map_err(|error| AppError(cli_status(error), error))
}

// Development runs edit files and execute commands, so they are refused
// outright unless a workspace is configured. That check is what makes the
// feature off by default rather than on with a warning.
async fn http_dev_agents(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<dev_cli::DevAgent>>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    Ok(Json(dev_cli::agents()))
}

async fn http_dev_auth(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(agent): Path<String>,
) -> Result<Json<cli_auth::AuthStatus>, AppError> {
    let token = bearer(&headers)?;
    state.require_session(&token).await.map_err(AppError::from)?;
    dev_cli::authentication(&agent).await.map(Json).map_err(|_| AppError::not_found())
}

async fn http_dev_usage(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(agent): Path<String>,
) -> Result<Json<agent_usage::AgentUsage>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    agent_usage::read(&agent)
        .await
        .map(Json)
        .map_err(|error| AppError(cli_status(error), error))
}

async fn http_dev_history(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<dev_cli::DevRunView>>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let owner = dev_owner(&headers)?;
    Ok(Json(state.dev_runs.lock().await.history_for(&owner)))
}

async fn http_dev_workspace(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    Ok(Json(match dev_cli::workspace() {
        Some(path) => serde_json::json!({ "enabled": true, "workspace": pi_work::non_verbatim(path).to_string_lossy() }),
        None => serde_json::json!({ "enabled": false, "workspace": null }),
    }))
}

async fn http_pick_dev_workspace(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let app = hub_window::app_handle().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "desktop window unavailable",
    ))?;
    let workspace = pick_dev_workspace(app).await;
    Ok(Json(match workspace {
        Some(path) => serde_json::json!({ "enabled": true, "workspace": path }),
        None => serde_json::json!({ "enabled": false, "workspace": null }),
    }))
}

async fn http_start_dev_run(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<dev_cli::DevRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let owner = dev_owner(&headers)?;
    let workspace = dev_cli::workspace().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "dev workspace not configured",
    ))?;
    let id = dev_cli::DevRuns::request_approval(&state.dev_runs, input, workspace, owner)
        .await
        .map_err(|error| AppError(cli_status(error), error))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({ "runId": id, "status": "awaiting_confirmation" })),
    ))
}

/// The run still going, so a screen that was closed and opened again can pick
/// the same one back up instead of showing an empty form.
async fn http_active_dev_run(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Option<serde_json::Value>>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let owner = dev_owner(&headers)?;
    Ok(Json(
        dev_cli::DevRuns::active_or_pending_for(&state.dev_runs, &owner).await,
    ))
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevPollQuery {
    after: Option<usize>,
}
async fn http_get_dev_run(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<DevPollQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let owner = dev_owner(&headers)?;
    dev_cli::DevRuns::poll_for(
        &state.dev_runs,
        &id,
        query.after.unwrap_or_default(),
        &owner,
    )
    .await
    .map(Json)
    .ok_or(AppError(StatusCode::NOT_FOUND, "unknown run"))
}

async fn http_cancel_dev_run(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let owner = dev_owner(&headers)?;
    dev_cli::DevRuns::cancel_for(&state.dev_runs, &id, &owner)
        .await
        .map_err(|error| AppError(StatusCode::NOT_FOUND, error))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn http_revert_dev_run(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Vec<String>>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let owner = dev_owner(&headers)?;
    dev_cli::DevRuns::revert_for(&state.dev_runs, &id, &owner)
        .await
        .map(Json)
        .map_err(|error| AppError(cli_status(error), error))
}

/// Decide one queued development request. The same owner partition the rest
/// of the dev routes enforce applies here too: the approving client must be
/// the one the request was made for.
async fn http_approve_dev_run(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let owner = dev_owner(&headers)?;
    dev_cli::DevRuns::approve_for(&state.dev_runs, &id, &owner)
        .await
        .map_err(|error| AppError(approval_status(error), error))?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DevVerificationDecision { action_id: String, approve: bool }

async fn http_decide_dev_verification(
    State(state): State<Arc<RunnerState>>, headers: axum::http::HeaderMap,
    Path(id): Path<String>, Json(input): Json<DevVerificationDecision>,
) -> Result<StatusCode, AppError> {
    let token = bearer(&headers)?;
    state.require_session(&token).await.map_err(AppError::from)?;
    let owner = dev_owner(&headers)?;
    dev_cli::DevRuns::decide_verification_for(&state.dev_runs, &id, &input.action_id, &owner, input.approve)
        .await.map_err(|error| AppError(approval_status(error), error))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn http_deny_dev_run(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let owner = dev_owner(&headers)?;
    dev_cli::DevRuns::deny_for(&state.dev_runs, &id, &owner)
        .await
        .map_err(|error| AppError(approval_status(error), error))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Docker code jobs and workspace file writes park in `PendingApproval` /
/// `PendingFileWrite`. Any live session may decide them: the pairing token is
/// the operator's credential and `/pending` already lists every queued item
/// to every session, so hiding the decision behind a per-item owner would
/// strand approvals whenever a token expires mid-queue.
async fn http_approve_run(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    state
        .approve_from_desktop(&id)
        .await
        .map_err(|_| AppError(StatusCode::CONFLICT, "not_pending"))?;
    Ok(StatusCode::NO_CONTENT)
}
async fn http_deny_run(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    state
        .deny_from_desktop(&id)
        .await
        .map_err(|_| AppError(StatusCode::CONFLICT, "not_pending"))?;
    Ok(StatusCode::NO_CONTENT)
}
async fn http_approve_file_write(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    state
        .approve_file_write(&id)
        .await
        .map_err(|_| AppError(StatusCode::CONFLICT, "not_pending"))?;
    Ok(StatusCode::NO_CONTENT)
}
async fn http_deny_file_write(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    state
        .deny_file_write(&id)
        .await
        .map_err(|_| AppError(StatusCode::CONFLICT, "not_pending"))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Pi Work over the paired Hub surface. Neither `script` nor `workspace` is
/// a request field: a token could otherwise turn the start into
/// `node <any file>` or point confinement at any directory on disk. The run
/// always uses the vendored sidecar and the workspace chosen at the machine.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PiWorkStart {
    prompt: String,
    verification: Option<verification::VerificationCommand>,
    model: Option<String>,
    resume_run_id: Option<String>,
    #[serde(default)]
    engine: Option<pi_work::WorkEngine>,
    #[serde(default)]
    allow_write: bool,
    /// Opt-ins for the operator-only tools. Each hub_exec/hub_http call
    /// still parks on an individual operator decision — the flags only
    /// decide whether the sidecar advertises them at all.
    #[serde(default)]
    allow_exec: bool,
    #[serde(default)]
    allow_http: bool,
    /// Fast type/lint checker argv the operator allowed for this run.
    #[serde(default)]
    checkers: Vec<verification::VerificationCommand>,
    /// Opt-in best-of-N; must echo the estimate the operator was shown.
    best_of: Option<pi_work::best_of::BestOfRequest>,
}
async fn http_pi_work_list(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<pi_work::PiRunState>>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    Ok(Json(state.pi_work.list()))
}
/// The pi model registry flattened for the panel's picker. It answers 200
/// even when the machine has no registry — `models` is then empty and the
/// panel falls back to a text field rather than an error.
async fn http_pi_work_models(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    Ok(Json(
        state
            .pi_work
            .models_with_refresh(query.get("refresh").is_some_and(|value| value == "1"))
            .await,
    ))
}
async fn http_pi_work_start(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<PiWorkStart>,
) -> Result<Json<pi_work::PiRunState>, WorkError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let workspace = dev_cli::workspace().ok_or(WorkError(
        StatusCode::SERVICE_UNAVAILABLE,
        "dev workspace not configured".into(),
    ))?;
    pi_work::launch(
        &state.pi_work,
        &state.dev_runs,
        workspace,
        &input.prompt,
        input.model.as_deref(),
        None,
        input.allow_write,
        input.allow_exec,
        input.allow_http,
        input.resume_run_id.as_deref(),
        pi_work::WorkEngine::for_start(input.engine, state.pi_work.saved_engine(input.resume_run_id.as_deref())),
        input.verification,
        input.checkers,
        input.best_of,
    )
    .await
    .map(Json)
    .map_err(|error| work_error(error))
}
#[derive(Deserialize)]
struct PiWorkStatusQuery {
    /// Client-held version: equal means "wait for the next change" — the
    /// long-poll that replaces status spinning. Missing answers at once.
    since: Option<u64>,
}

/// One in-flight request resolves the moment the run's version moves (the
/// run bumps it on every state mutation), so token deltas and transitions
/// arrive without a poll cadence. The deadline caps a silent wait; the
/// response then carries the unchanged body — same shape, just older.
async fn http_pi_work_status(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<PiWorkStatusQuery>,
) -> Result<(axum::response::AppendHeaders<[(axum::http::HeaderName, String); 1]>, Json<pi_work::PiRunState>), AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let (version, run) = state
        .pi_work
        .watch(&id, query.since, std::time::Duration::from_secs(25))
        .await
        .ok_or_else(AppError::not_found)?;
    Ok((
        axum::response::AppendHeaders([(
            axum::http::HeaderName::from_static("x-run-version"),
            version.to_string(),
        )]),
        Json(run),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PiWorkDecision {
    action_id: String,
    approve: bool,
    /// For approvals that execute outside the desktop (`hub_pay`): the
    /// paired panel runs the Hub-side order, then resolves the action with
    /// the result, which becomes the tool's answer. Untrusted model data
    /// never reaches this field — it is written by the paired session.
    #[serde(default)]
    outcome: Option<serde_json::Value>,
}
async fn http_pi_work_decide(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<PiWorkDecision>,
) -> Result<Json<pi_work::PiRunState>, WorkError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    state
        .pi_work
        .decide_from_window(&id, &input.action_id, input.approve, input.outcome)
        .map(Json)
        .map_err(|error| work_error(error))
}
async fn http_pi_work_cancel(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<pi_work::PiRunState>, WorkError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    state
        .pi_work
        .cancel(&id, &state.dev_runs)
        .await
        .map(Json)
        .map_err(|error| work_error(error))
}

// A rejected request and a failed one are not the same thing, and the caller
// has to be able to tell them apart: a bad agent name is the caller's to fix,
// a missing binary is the operator's, a timeout is worth retrying. Collapsing
// all three into 502 made the guards look like upstream faults.
fn cli_status(error: &'static str) -> StatusCode {
    match error {
        "invalid prompt"
        | "unknown agent"
        | "invalid session"
        | "agent cannot resume"
        | "run still going"
        | "not a git workspace"
        | "git workspace required"
        | "idempotency key required"
        | "invalid idempotency key"
        | "agent workspace boundary unavailable" => StatusCode::BAD_REQUEST,
        "claude not installed" | "codex not installed" => StatusCode::SERVICE_UNAVAILABLE,
        "timed out" | "usage timed out" => StatusCode::GATEWAY_TIMEOUT,
        // Not the caller's mistake and not a fault: the workspace is busy.
        "run already in progress" | "idempotency conflict" | "workspace changed since run" => {
            StatusCode::CONFLICT
        }
        "approval capacity exceeded" => StatusCode::TOO_MANY_REQUESTS,
        _ => StatusCode::BAD_GATEWAY,
    }
}
/// Dev-run decide errors are the item's own status strings: an id nobody
/// queued is 404, anything already decided is 409, and launch failures keep
/// the caller-facing mapping `cli_status` already gives them.
fn approval_status(error: &'static str) -> StatusCode {
    match cli_status(error) {
        StatusCode::BAD_GATEWAY => match error {
            "unknown approval" | "unknown run" => StatusCode::NOT_FOUND,
            _ => StatusCode::CONFLICT,
        },
        known => known,
    }
}
async fn local_orchestrate(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<local_ai::LocalOrchestrationRequest>,
) -> Result<Json<local_ai::LocalOrchestrationResponse>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    local_ai::orchestrate(input)
        .await
        .map(Json)
        .map_err(|error| AppError(StatusCode::BAD_GATEWAY, error))
}
async fn create_local_ai_job(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<local_ai::LocalOrchestrationRequest>,
) -> Result<(StatusCode, Json<LocalAiJobView>), AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let id = Uuid::new_v4().to_string();
    {
        let mut inner = state.inner.lock().await;
        // An expired job leaves memory and its encrypted output leaves the disk too;
        // before this, every finished job's output was kept and reloaded forever.
        let expired = take_expired_ai_jobs(&mut inner.ai_jobs, JOB_TTL);
        if let Some(store) = &state.checkpoint {
            for id in &expired { store.remove(id); }
        }
        if inner.ai_jobs.len() >= MAX_TOTAL_JOBS
            || inner
                .ai_jobs
                .values()
                .filter(|job| job.owner == token)
                .count()
                >= MAX_JOBS_PER_SESSION
        {
            return Err(AppError::capacity());
        }
        let job = LocalAiJob {
            owner: token,
            status: LocalAiJobStatus::Queued,
            output: None,
            error: None,
            created: Instant::now(),
            abort: None,
        };
        inner.ai_jobs.insert(id.clone(), job);
    }
    let task_state = state.clone();
    let task_id = id.clone();
    let handle = tokio::spawn(async move {
        {
            let mut inner = task_state.inner.lock().await;
            if let Some(job) = inner.ai_jobs.get_mut(&task_id) {
                job.status = LocalAiJobStatus::Running;
            }
        }
        let result = local_ai::orchestrate(input).await;
        let mut inner = task_state.inner.lock().await;
        if let Some(job) = inner.ai_jobs.get_mut(&task_id) {
            if matches!(job.status, LocalAiJobStatus::Cancelled) {
                return;
            }
            match result {
                Ok(output) => {
                    job.output = Some(output);
                    job.status = LocalAiJobStatus::Completed
                }
                Err(error) => {
                    job.error = Some(error.into());
                    job.status = LocalAiJobStatus::Failed
                }
            }
            task_state.save_ai_checkpoint(&task_id, job);
        }
    });
    if let Some(job) = state.inner.lock().await.ai_jobs.get_mut(&id) {
        job.abort = Some(handle.abort_handle());
    }
    Ok((
        StatusCode::ACCEPTED,
        Json(LocalAiJobView {
            id,
            status: LocalAiJobStatus::Queued,
            output: None,
            error: None,
        }),
    ))
}
async fn get_local_ai_job(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<LocalAiJobView>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let mut inner = state.inner.lock().await;
    let job = inner.ai_jobs.get_mut(&id).ok_or_else(AppError::not_found)?;
    if job.owner.is_empty() {
        job.owner = token.clone();
    }
    if job.owner != token {
        return Err(AppError::unauthorized());
    }
    Ok(Json(LocalAiJobView {
        id,
        status: job.status.clone(),
        output: job.output.clone(),
        error: job.error.clone(),
    }))
}
async fn cancel_local_ai_job(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let mut inner = state.inner.lock().await;
    let job = inner.ai_jobs.get_mut(&id).ok_or_else(AppError::not_found)?;
    if job.owner != token {
        return Err(AppError::unauthorized());
    }
    if !matches!(
        job.status,
        LocalAiJobStatus::Queued | LocalAiJobStatus::Running
    ) {
        return Err(AppError(StatusCode::CONFLICT, "job_not_cancellable"));
    }
    if let Some(abort) = &job.abort {
        abort.abort();
    }
    job.status = LocalAiJobStatus::Cancelled;
    state.save_ai_checkpoint(&id, job);
    Ok(StatusCode::NO_CONTENT)
}
/// File endpoints do canonicalize/stat/read work — synchronous, up to the
/// file-size cap. Keep it off the async worker; a join failure is a plain
/// 500, and the operation's own error stays the 400 it always was.
async fn file_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
) -> Result<T, AppError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| AppError(StatusCode::INTERNAL_SERVER_ERROR, "file_internal"))?
        .map_err(|error| AppError(StatusCode::BAD_REQUEST, error))
}

async fn file_read(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<FileRequest>,
) -> Result<Json<workspace_files::FileReadResult>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    if !input.policy.allow_file_read {
        return Err(AppError(StatusCode::FORBIDDEN, "policy_denied"));
    }
    let root = canonical_workspace_root(&input.workspace_root).map_err(AppError::from)?;
    let path = input.relative_path.clone();
    file_blocking(move || workspace_files::read(&root, &path))
        .await
        .map(Json)
}
async fn file_search(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<FileSearchRequest>,
) -> Result<Json<Vec<workspace_files::FileSearchResult>>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    if !input.policy.allow_file_read {
        return Err(AppError(StatusCode::FORBIDDEN, "policy_denied"));
    }
    let root = canonical_workspace_root(&input.workspace_root).map_err(AppError::from)?;
    let query = input.query.clone();
    file_blocking(move || workspace_files::search(&root, &query))
        .await
        .map(Json)
}
async fn file_diff(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<FileDiffRequest>,
) -> Result<Json<workspace_files::FileDiffPreview>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    if !input.policy.allow_file_read {
        return Err(AppError(StatusCode::FORBIDDEN, "policy_denied"));
    }
    let root = canonical_workspace_root(&input.workspace_root).map_err(AppError::from)?;
    let path = input.relative_path.clone();
    let next = input.next_content.clone();
    file_blocking(move || workspace_files::preview(&root, &path, &next))
        .await
        .map(Json)
}
async fn file_write(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<FileWriteRequest>,
) -> Result<(StatusCode, Json<FileWriteView>), AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    if !input.policy.allow_file_read || !input.policy.allow_file_write {
        return Err(AppError(StatusCode::FORBIDDEN, "policy_denied"));
    }
    let root = canonical_workspace_root(&input.workspace_root).map_err(AppError::from)?;
    let preview = {
        let path = input.relative_path.clone();
        let next = input.next_content.clone();
        file_blocking(move || workspace_files::preview(&root, &path, &next)).await?
    };
    if preview.previous_sha256 != input.expected_previous_sha256
        || preview.next_sha256 != input.expected_next_sha256
    {
        return Err(AppError(StatusCode::CONFLICT, "file_changed_since_preview"));
    }
    let id = Uuid::new_v4().to_string();
    state.inner.lock().await.file_writes.insert(
        id.clone(),
        PendingFileWrite {
            owner: token,
            workspace_root: input.workspace_root,
            relative_path: input.relative_path,
            next_content: input.next_content,
            expected_previous: input.expected_previous_sha256,
            expected_next: input.expected_next_sha256,
            created: Instant::now(),
            status: FileWriteStatus::PendingApproval,
            result: None,
        },
    );
    Ok((
        StatusCode::ACCEPTED,
        Json(FileWriteView {
            id,
            status: FileWriteStatus::PendingApproval,
            result: None,
        }),
    ))
}
async fn get_file_write(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<FileWriteView>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let inner = state.inner.lock().await;
    let item = inner.file_writes.get(&id).ok_or_else(AppError::not_found)?;
    if item.owner != token {
        return Err(AppError::unauthorized());
    }
    Ok(Json(FileWriteView {
        id,
        status: item.status.clone(),
        result: item
            .result
            .as_ref()
            .map(|result| workspace_files::FileWriteResult {
                relative_path: result.relative_path.clone(),
                sha256: result.sha256.clone(),
                revision: result.revision.clone(),
            }),
    }))
}
async fn file_revisions(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<FileRevisionRequest>,
) -> Result<Json<Vec<workspace_files::FileRevision>>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    if !input.policy.allow_file_read {
        return Err(AppError(StatusCode::FORBIDDEN, "policy_denied"));
    }
    let root = canonical_workspace_root(&input.workspace_root).map_err(AppError::from)?;
    let path = input.relative_path.clone();
    file_blocking(move || workspace_files::revisions(&root, &path))
        .await
        .map(Json)
}
async fn file_restore(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<FileRestoreRequest>,
) -> Result<(StatusCode, Json<FileWriteView>), AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    if !input.policy.allow_file_read || !input.policy.allow_file_write {
        return Err(AppError(StatusCode::FORBIDDEN, "policy_denied"));
    }
    let root = canonical_workspace_root(&input.workspace_root).map_err(AppError::from)?;
    let current = {
        let root = root.clone();
        let path = input.relative_path.clone();
        file_blocking(move || workspace_files::preview(&root, &path, "")).await?
    }
    .previous_sha256;
    if current != input.expected_current_sha256 {
        return Err(AppError(StatusCode::CONFLICT, "file_changed_since_preview"));
    }
    let content = {
        let root = root.clone();
        let path = input.relative_path.clone();
        let revision = input.revision_id.clone();
        file_blocking(move || workspace_files::revision_content(&root, &path, &revision)).await?
    };
    let preview = {
        let path = input.relative_path.clone();
        let value = content.clone();
        file_blocking(move || workspace_files::preview(&root, &path, &value)).await?
    };
    let id = Uuid::new_v4().to_string();
    state.inner.lock().await.file_writes.insert(
        id.clone(),
        PendingFileWrite {
            owner: token,
            workspace_root: input.workspace_root,
            relative_path: input.relative_path,
            next_content: content,
            expected_previous: current,
            expected_next: preview.next_sha256,
            created: Instant::now(),
            status: FileWriteStatus::PendingApproval,
            result: None,
        },
    );
    Ok((
        StatusCode::ACCEPTED,
        Json(FileWriteView {
            id,
            status: FileWriteStatus::PendingApproval,
            result: None,
        }),
    ))
}
async fn cancel_run(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let token = bearer(&headers)?;
    state.cancel(&token, &id).await.map_err(AppError::from)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn create_run(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(request): Json<RunRequest>,
) -> Result<(StatusCode, Json<RunResponse>), AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    if !request.policy.allow_code_execution
        || request.policy.allow_file_write
        || request.policy.allow_web
        || request.policy.allow_purchase
    {
        return Err(AppError(StatusCode::FORBIDDEN, "policy_denied"));
    }
    validate_run(
        &request.language,
        &request.code,
        request.network,
        request.timeout_ms,
    )
    .map_err(AppError::from)?;
    let workspace = canonical_workspace_root(&request.workspace_root).map_err(AppError::from)?;
    let id = Uuid::new_v4().to_string();
    let job = Job {
        owner: token.clone(),
        language: request.language,
        code: request.code,
        workspace: workspace.to_string_lossy().into_owned(),
        timeout_ms: request.timeout_ms,
        status: JobStatus::PendingApproval,
        stdout: String::new(),
        stderr: String::new(),
        exit_code: None,
        files: Vec::new(),
        created: Instant::now(),
    };
    let mut inner = state.inner.lock().await;
    inner.jobs.retain(|_, job| job.created.elapsed() < JOB_TTL);
    if inner.jobs.len() >= MAX_TOTAL_JOBS
        || inner.jobs.values().filter(|job| job.owner == token).count() >= MAX_JOBS_PER_SESSION
    {
        return Err(AppError::capacity());
    }
    inner.jobs.insert(id.clone(), job);
    Ok((
        StatusCode::ACCEPTED,
        Json(RunResponse {
            id,
            status: JobStatus::PendingApproval,
        }),
    ))
}
async fn get_run(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<RunStatus>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let inner = state.inner.lock().await;
    let job = inner.jobs.get(&id).ok_or(AppError::not_found())?;
    if job.owner != token {
        return Err(AppError::unauthorized());
    }
    Ok(Json(RunStatus {
        id,
        status: job.status.clone(),
        stdout: job.stdout.clone(),
        stderr: job.stderr.clone(),
        exit_code: job.exit_code,
        files: job.files.clone(),
    }))
}
fn bearer(headers: &axum::http::HeaderMap) -> Result<String, AppError> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .ok_or_else(AppError::unauthorized)
}
fn dev_owner(headers: &axum::http::HeaderMap) -> Result<String, AppError> {
    let id = headers
        .get("x-hub-client-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .ok_or(AppError(StatusCode::BAD_REQUEST, "invalid_client_id"))?;
    Ok(format!("{:x}", Sha256::digest(id.as_bytes())))
}
fn random_token(bytes_len: usize) -> String {
    let mut bytes = vec![0u8; bytes_len];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
#[derive(Debug)]
struct AppError(StatusCode, &'static str);
impl AppError {
    fn unauthorized() -> Self {
        Self(StatusCode::UNAUTHORIZED, "unauthorized")
    }
    fn not_found() -> Self {
        Self(StatusCode::NOT_FOUND, "not_found")
    }
    fn capacity() -> Self {
        Self(StatusCode::TOO_MANY_REQUESTS, "capacity_exceeded")
    }
}
impl From<SecurityError> for AppError {
    fn from(value: SecurityError) -> Self {
        match value {
            SecurityError::Unauthorized => Self::unauthorized(),
            SecurityError::InvalidRequest => Self(StatusCode::BAD_REQUEST, "invalid_request"),
            SecurityError::InvalidWorkspace => Self(StatusCode::BAD_REQUEST, "invalid_workspace"),
            SecurityError::CapacityExceeded => Self::capacity(),
        }
    }
}
impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        (self.0, Json(serde_json::json!({"error": self.1}))).into_response()
    }
}
/// The work services report owned `String` errors; carrying them unchanged
/// keeps the exact reason (`prompt_too_long`, `approval_denied`…) instead of
/// leaking or collapsing to one static label.
struct WorkError(StatusCode, String);
impl From<AppError> for WorkError {
    fn from(error: AppError) -> Self {
        Self(error.0, error.1.to_string())
    }
}
impl IntoResponse for WorkError {
    fn into_response(self) -> axum::response::Response {
        (self.0, Json(serde_json::json!({"error": self.1}))).into_response()
    }
}
/// Maps a work-service error id to a status: unknown runs are 404, a busy or
/// already-decided target is 409, missing local prerequisites are 503, and
/// the rest are the caller's request.
fn work_error(error: String) -> WorkError {
    let status = match error.as_str() {
        "pi_work_not_found" | "work_unavailable" => StatusCode::NOT_FOUND,
        "work_already_running" | "run already in progress" | "pi_action_not_found"
        | "approval_expired_or_changed" | "approval_already_consumed" | "cancelled" => {
            StatusCode::CONFLICT
        }
        "encrypted_store_unavailable" | "sidecar_script_missing" | "workspace_required" => {
            StatusCode::SERVICE_UNAVAILABLE
        }
        _ => StatusCode::BAD_REQUEST,
    };
    WorkError(status, error)
}

#[tauri::command]
async fn pending_runs(
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<Vec<ApprovalView>, String> {
    Ok(state.pending_runs().await)
}
#[tauri::command]
async fn isolation_status() -> &'static str {
    if docker::isolation_available().await {
        "docker"
    } else {
        "unavailable"
    }
}
#[tauri::command]
async fn approve_run(id: String, state: tauri::State<'_, Arc<RunnerState>>) -> Result<(), String> {
    state
        .approve_from_desktop(&id)
        .await
        .map_err(|_| "invalid_request".into())
}
#[tauri::command]
async fn deny_run(id: String, state: tauri::State<'_, Arc<RunnerState>>) -> Result<(), String> {
    state
        .deny_from_desktop(&id)
        .await
        .map_err(|_| "invalid_request".into())
}
#[tauri::command]
async fn pending_file_writes(
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<Vec<FileApprovalView>, String> {
    Ok(state.pending_file_writes().await)
}
#[tauri::command]
async fn approve_file_write(
    id: String,
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<(), String> {
    state
        .approve_file_write(&id)
        .await
        .map_err(|_| "invalid_request".into())
}
#[tauri::command]
async fn deny_file_write(
    id: String,
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<(), String> {
    state
        .deny_file_write(&id)
        .await
        .map_err(|_| "invalid_request".into())
}
#[tauri::command]
async fn pending_dev_runs(
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<Vec<dev_cli::DevApprovalView>, String> {
    Ok(dev_cli::DevRuns::pending_approvals(&state.dev_runs).await)
}
#[tauri::command]
async fn approve_dev_run(
    id: String,
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<(), String> {
    dev_cli::DevRuns::approve(&state.dev_runs, &id)
        .await
        .map_err(str::to_owned)
}
#[tauri::command]
async fn deny_dev_run(id: String, state: tauri::State<'_, Arc<RunnerState>>) -> Result<(), String> {
    dev_cli::DevRuns::deny(&state.dev_runs, &id)
        .await
        .map_err(str::to_owned)
}
// Development from the desktop window. These are Tauri commands rather than
// HTTP routes on purpose: the window is on this machine, so choosing the
// workspace and starting a run that edits files stay out of reach of anything
// holding a pairing token.
#[tauri::command]
async fn dev_history(
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<Vec<dev_cli::DevRunView>, String> {
    if !desktop_metrics::enabled() {
        return Ok(state.dev_runs.lock().await.history());
    }
    let waiting = Instant::now();
    let guard = state.dev_runs.lock().await;
    let mut probe = desktop_metrics::NativeHistoryCall {
        lock_wait_ms: waiting.elapsed().as_secs_f64() * 1000.0,
        ..Default::default()
    };
    let started = Instant::now();
    let history = guard.history_with_probe(Some(&mut probe));
    probe.history_ms = started.elapsed().as_secs_f64() * 1000.0;
    drop(guard);
    desktop_metrics::record_native_history(probe);
    Ok(history)
}
/// Choose the folder with the system's own picker.
///
/// Kept as a command rather than a frontend permission: the window never gets
/// the right to open file dialogs of its own, and the boundary stays "the
/// directory is chosen at the machine". Returns None when the picker is closed
/// without choosing, which is not an error.
#[tauri::command]
async fn pick_dev_workspace(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |chosen| {
        let _ = tx.send(chosen);
    });
    let chosen = rx.await.ok().flatten()?;
    dev_cli::set_workspace(&chosen.to_string())
        .ok()
        .map(|path| pi_work::non_verbatim(path).to_string_lossy().into_owned())
}
/// ハブに出すための、承認待ちの要約。
///
/// **中身のコードは返さない。** 誰が出した要求かは持ち番号で分かれているが、
/// 一覧は端末の状態を見るためのもので、他のセッションが出したコードを
/// 読めるようにする理由がない。何がどれだけ待っているかが分かればよい。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingSummary {
    runs: Vec<PendingRun>,
    file_writes: Vec<PendingWrite>,
    development_runs: Vec<PendingDevelopmentRun>,
    /// Pi Work parks one entry per gated mutation across all live runs.
    pi_actions: Vec<PendingPiAction>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingRun {
    id: String,
    language: String,
    workspace_root: String,
    expires_in_seconds: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingWrite {
    id: String,
    relative_path: String,
    workspace_root: String,
    expires_in_seconds: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingDevelopmentRun {
    id: String,
    agent: String,
    workspace: String,
    expires_in_seconds: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingPiAction {
    run_id: String,
    action_id: String,
    tool: String,
    summary: String,
}

/// 何が承認を待っているか。
///
/// ハブがハーネス面になった今、押す口もペアリング済みセッションにある。
/// ここは一覧だけを返し、決定は各 decide 経路が持つ。
async fn http_pending(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<PendingSummary>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    Ok(Json(PendingSummary {
        runs: state
            .pending_runs()
            .await
            .into_iter()
            .map(|view| PendingRun {
                id: view.id,
                language: view.language,
                workspace_root: view.workspace_root,
                expires_in_seconds: view.expires_in_seconds,
            })
            .collect(),
        file_writes: state
            .pending_file_writes()
            .await
            .into_iter()
            .map(|view| PendingWrite {
                id: view.id,
                relative_path: view.relative_path,
                workspace_root: view.workspace_root,
                expires_in_seconds: view.expires_in_seconds,
            })
            .collect(),
        development_runs: dev_cli::DevRuns::pending_approvals(&state.dev_runs)
            .await
            .into_iter()
            .map(|view| PendingDevelopmentRun {
                id: view.id,
                agent: view.agent,
                workspace: view.workspace,
                expires_in_seconds: view.expires_in_seconds,
            })
            .collect(),
        pi_actions: state
            .pi_work
            .list()
            .into_iter()
            .flat_map(|run| {
                run.pending_actions.into_iter().map(move |action| {
                    PendingPiAction {
                        run_id: run.id.clone(),
                        action_id: action.id,
                        tool: action.tool,
                        summary: action.summary,
                    }
                })
            })
            .collect(),
    }))
}

/// 承認のためにHub本体のAI画面を前に出す。
///
/// これだけは外から呼んでよい。窓を前に出すのは、人の目に触れさせる方向の
/// 動作でしかなく、勝手に何かが実行されることはない。むしろ承認待ちに
/// 気付かせるために要る。
async fn http_show_local(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<StatusCode, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let _ = state;
    hub_window::show_local();
    Ok(StatusCode::NO_CONTENT)
}

/// まだ送れていない出来事。**古い順に返す。**
///
/// 連鎖なので順番を崩せない。呼ぶ側は先頭から1つずつ送り、失敗したらそこで
/// 止める。飛ばして次を送ると、ゲートウェイは番号が合わないと言って拒み、
/// 以後すべてが詰まる。
async fn http_pending_events(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<node_store::StoredEvent>>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    Ok(Json(node.pending_events(20).await))
}

async fn http_show_games(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<StatusCode, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    hub_window::show_games();
    Ok(StatusCode::NO_CONTENT)
}

/// ブラウザ窓を前に出す合図だけを受ける。URLは任意（開く最初のページ）。
/// 窓そのものは利用者の操作面であり、HTTPから内容の読み書きは受けない。
async fn http_show_browser(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<StatusCode, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let url = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|body| body.get("url")?.as_str().map(str::to_owned));
    browser_window::show_browser(url);
    Ok(StatusCode::NO_CONTENT)
}

/// 受け取られたことを記録する。**受け取られてから呼ぶ。**
async fn http_mark_delivered(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(sequence): Path<u64>,
) -> Result<StatusCode, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    node.mark_delivered(sequence)
        .await
        .map_err(|_| AppError(StatusCode::BAD_REQUEST, "unknown_event"))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn http_preview_public_content(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<content_protocol::PublicContentDraft>,
) -> Result<Json<content_protocol::PublicContentPreview>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    node.preview_public_content(input)
        .await
        .map(Json)
        .map_err(|_| AppError(StatusCode::BAD_REQUEST, "content_preview_invalid"))
}

async fn http_preview_private_content(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<content_protocol::PrivateContentDraft>,
) -> Result<Json<content_protocol::PublicContentPreview>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    node.preview_private_content(input)
        .await
        .map(Json)
        .map_err(|_| AppError(StatusCode::BAD_REQUEST, "private_content_preview_invalid"))
}

async fn http_publish_public_content(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<content_protocol::ConfirmPublicContent>,
) -> Result<Json<content_protocol::PublicContentReceipt>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    node.publish_public_content(input)
        .await
        .map(Json)
        .map_err(|_| AppError(StatusCode::CONFLICT, "content_publish_rejected"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeerPreviewRequest {
    node_url: String,
}

async fn http_list_peers(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<peer_node::PinnedPeer>>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    Ok(Json(node.peers().await))
}

async fn http_peer_inbox_list(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<personal_node::PeerInboxItem>>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    Ok(Json(node.peer_inbox().await))
}

async fn http_decrypt_peer_content(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(delivery_id): Path<String>,
) -> Result<Json<personal_node::DecryptedPeerContent>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    node.decrypt_peer_content(&delivery_id)
        .await
        .map(Json)
        .map_err(|_| AppError(StatusCode::FORBIDDEN, "peer_content_decrypt_rejected"))
}

async fn http_preview_peer(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<PeerPreviewRequest>,
) -> Result<Json<peer_node::PeerPreview>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    node.preview_peer(&input.node_url)
        .await
        .map(Json)
        .map_err(|_| AppError(StatusCode::BAD_REQUEST, "peer_preview_rejected"))
}

async fn http_confirm_peer(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<peer_node::ConfirmPeer>,
) -> Result<Json<peer_node::PinnedPeer>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    node.confirm_peer(input)
        .await
        .map(Json)
        .map_err(|_| AppError(StatusCode::CONFLICT, "peer_confirmation_rejected"))
}

async fn http_deliver_peer_event(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path((peer_id, sequence)): Path<(String, u64)>,
) -> Result<Json<peer_node::PeerDeliveryReceipt>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    node.deliver_event_to_peer(&peer_id, sequence)
        .await
        .map(Json)
        .map_err(|_| AppError(StatusCode::BAD_GATEWAY, "peer_delivery_failed"))
}

async fn http_peer_identity(
    State(state): State<Arc<RunnerState>>,
) -> Result<Json<peer_node::PeerIdentity>, AppError> {
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    node.peer_identity()
        .await
        .map(Json)
        .map_err(|_| AppError(StatusCode::SERVICE_UNAVAILABLE, "peer_identity_unavailable"))
}

async fn http_peer_inbox(
    State(state): State<Arc<RunnerState>>,
    Json(delivery): Json<peer_node::PeerDelivery>,
) -> Result<Json<peer_node::PeerDeliveryReceipt>, AppError> {
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    node.receive_peer_delivery(delivery)
        .await
        .map(Json)
        .map_err(|_| AppError(StatusCode::FORBIDDEN, "peer_delivery_rejected"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PeerBlobManifest {
    version: u8,
    blob_uri: String,
    byte_length: u64,
    digest: String,
    chunk_size: usize,
    chunks: Vec<artifact_store::ArtifactChunkManifest>,
    visibility: String,
}

async fn http_peer_blob_manifest(
    State(state): State<Arc<RunnerState>>,
    Path(digest): Path<String>,
) -> Result<Json<PeerBlobManifest>, AppError> {
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    let (published, manifest) = node
        .published_artifact_manifest(&digest)
        .await
        .ok_or(AppError(StatusCode::NOT_FOUND, "artifact_not_published"))?;
    Ok(Json(PeerBlobManifest {
        version: manifest.version,
        blob_uri: manifest.blob_uri,
        byte_length: manifest.byte_length,
        digest: manifest.digest,
        chunk_size: manifest.chunk_size,
        chunks: manifest.chunks,
        visibility: published.visibility,
    }))
}

async fn http_peer_blob_chunk(
    State(state): State<Arc<RunnerState>>,
    Path((digest, index)): Path<(String, u32)>,
) -> Result<Json<ArtifactChunkBody>, AppError> {
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    let bytes = node
        .published_artifact_chunk(&digest, index)
        .await
        .ok_or(AppError(StatusCode::NOT_FOUND, "artifact_not_published"))?;
    Ok(Json(ArtifactChunkBody {
        index,
        byte_length: bytes.len(),
        digest: Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        data: URL_SAFE_NO_PAD.encode(bytes),
    }))
}

async fn http_begin_artifact_upload(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<artifact_store::BeginArtifactUpload>,
) -> Result<Json<artifact_store::ArtifactUpload>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    node.begin_artifact_upload(input)
        .await
        .map(Json)
        .map_err(|_| AppError(StatusCode::BAD_REQUEST, "artifact_upload_invalid"))
}

async fn http_put_artifact_chunk(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path((upload_id, index)): Path<(String, u32)>,
    Json(input): Json<artifact_store::ArtifactChunkInput>,
) -> Result<Json<artifact_store::ArtifactChunkReceipt>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    node.put_artifact_chunk(&upload_id, index, input)
        .await
        .map(Json)
        .map_err(|_| AppError(StatusCode::CONFLICT, "artifact_chunk_rejected"))
}

async fn http_finalize_artifact_upload(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(upload_id): Path<String>,
) -> Result<Json<content_protocol::PublicContentPreview>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    node.finalize_artifact_upload(&upload_id)
        .await
        .map(Json)
        .map_err(|_| AppError(StatusCode::CONFLICT, "artifact_finalize_rejected"))
}

async fn http_finalize_private_artifact_upload(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(upload_id): Path<String>,
    Json(input): Json<content_protocol::PrivateArtifactFinalize>,
) -> Result<Json<content_protocol::PublicContentPreview>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    node.finalize_private_artifact_upload(&upload_id, input)
        .await
        .map(Json)
        .map_err(|_| AppError(StatusCode::CONFLICT, "private_artifact_finalize_rejected"))
}

async fn http_artifact_manifest(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path(digest): Path<String>,
) -> Result<Json<artifact_store::ArtifactManifest>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    node.artifact_manifest(&digest)
        .await
        .map(Json)
        .ok_or(AppError(StatusCode::NOT_FOUND, "artifact_not_found"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactChunkBody {
    index: u32,
    byte_length: usize,
    digest: String,
    data: String,
}

async fn http_artifact_chunk(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    Path((digest, index)): Path<(String, u32)>,
) -> Result<Json<ArtifactChunkBody>, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    let bytes = node
        .artifact_chunk(&digest, index)
        .await
        .ok_or(AppError(StatusCode::NOT_FOUND, "artifact_not_found"))?;
    Ok(Json(ArtifactChunkBody {
        index,
        byte_length: bytes.len(),
        digest: Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        data: URL_SAFE_NO_PAD.encode(bytes),
    }))
}

/// 署名してよい文字列か。
///
/// 中身は相手が決める不透明な文字列なので、意味は見られない。**見られないから
/// こそ、形で絞る。** 何でも署名できる口を開けると、この鍵が別の意味を持つ
/// 文書に署名させられうる。長さと文字種を、組み合わせ確認に足るだけへ狭める。
fn is_a_challenge(challenge: &str) -> bool {
    let length = challenge.len();
    (16..=512).contains(&length)
        && challenge
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

async fn node_signature(
    node: &personal_node::PersonalNodeService,
    challenge: &str,
) -> Result<String, String> {
    if !is_a_challenge(challenge) {
        return Err("この文字列には署名しません".into());
    }
    node.sign(challenge)
        .ok_or_else(|| "身元鍵がありません".to_owned())
}

/// ハブのページから署名を頼む口。組み合わせ確認を通った相手だけ。
async fn http_sign_node(
    State(state): State<Arc<RunnerState>>,
    headers: axum::http::HeaderMap,
    body: String,
) -> Result<String, AppError> {
    let token = bearer(&headers)?;
    state
        .require_session(&token)
        .await
        .map_err(AppError::from)?;
    let node = state.node.as_ref().ok_or(AppError(
        StatusCode::SERVICE_UNAVAILABLE,
        "node_storage_unavailable",
    ))?;
    node_signature(node, body.trim())
        .await
        .map_err(|_| AppError(StatusCode::BAD_REQUEST, "invalid_challenge"))
}

/// 2つ目の起動が「先客はこちらです」と知らせてくる入口。
///
/// ここでできるのは窓を前に出すことだけで、何も実行しないし、何も読めない。
async fn http_show_running() -> StatusCode {
    single::show_running();
    StatusCode::NO_CONTENT
}

#[tauri::command]
async fn dev_active_run(
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<Option<dev_cli::DevRun>, String> {
    Ok(dev_cli::DevRuns::active(&state.dev_runs).await)
}
/// この端末の身元。**窓から見えるようにするために要る。**
///
/// ここまで機能はHTTPにしか出ておらず、窓には開発と承認しか無かった。
/// 中身にあるものが画面に無いと、無いのと同じになる。
#[tauri::command]
async fn node_state(
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<Option<personal_node::NodeState>, String> {
    Ok(match state.node.as_ref() {
        Some(node) => Some(node.status().await),
        None => None,
    })
}
#[tauri::command]
async fn save_node_settings(
    window: tauri::Webview,
    settings: personal_node::UpdateNodeSettings,
    startup: Option<bool>,
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<personal_node::NodeState, String> {
    let url=window.url().map_err(|_|"native_window_required")?;
    if !local_pairing_address(window.label(),&url) { return Err("native_window_required".into()); }
    let node=state.node.as_ref().ok_or("この端末の保管先が使えません")?;
    let result=if startup==Some(true) { node.update_native(settings).await } else { node.update(settings).await };
    result.map_err(str::to_owned)
}
#[tauri::command]
fn node_startup_status(window: tauri::Webview)->Result<windows_startup::StartupStatus,String> {
    let url=window.url().map_err(|_|"native_window_required")?;
    if !local_pairing_address(window.label(),&url) { return Err("native_window_required".into()); }
    Ok(windows_startup::status())
}
#[tauri::command]
fn pi_work_open_workspace(window: tauri::Webview,cwd:String)->Result<workspace_open::Opened,String> {
    let url=window.url().map_err(|_|"native_window_required")?;
    if !local_pairing_address(window.label(),&url) { return Err("native_window_required".into()); }
    workspace_open::open(&cwd)
}
#[tauri::command]
async fn sync_node_now(
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<personal_node::NodeState, String> {
    state
        .node
        .as_ref()
        .ok_or("この端末の保管先が使えません")?
        .mark_sync()
        .await
        .map_err(str::to_owned)
}
#[tauri::command]
async fn node_sync_control(window: tauri::Webview, state: tauri::State<'_, Arc<RunnerState>>,
    action: String, cursor: Option<u64>, input: Option<personal_node::NodeSyncDelivery>)
    -> Result<serde_json::Value, String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if window.label() != "main" || !local_pairing_address(window.label(), &url) {
        return Err("native_window_required".into());
    }
    let node = state.node.as_ref().ok_or("node_sync_unavailable")?;
    match (action.as_str(), cursor, input) {
        ("preview", Some(cursor), None) => serde_json::to_value(node.sync_preview(cursor).await?).map_err(|_| "node_sync_unavailable".into()),
        ("deliver", None, Some(input)) => serde_json::to_value(node.sync_delivery(input).await?).map_err(|_| "node_sync_unavailable".into()),
        ("receipt", None, Some(input)) => serde_json::to_value(node.sync_receipt(input).await?).map_err(|_| "node_sync_unavailable".into()),
        _ => Err("node_sync_invalid_request".into()),
    }
}
#[tauri::command]
async fn node_public_posts(window: tauri::Webview, state: tauri::State<'_, Arc<RunnerState>>, limit: usize) -> Result<Vec<serde_json::Value>, String> {
    native_pi(&window)?;
    state.node.as_ref().ok_or("この端末の保管先が使えません")?.public_posts(limit).await
}

#[tauri::command]
async fn node_public_post_control(
    window: tauri::Webview, state: tauri::State<'_, Arc<RunnerState>>, action: String,
    sequence: u64, peer_ids: Option<Vec<String>>, peer_id: Option<String>, confirmed: Option<bool>,
) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    let node = state.node.as_ref().ok_or("この端末の保管先が使えません")?;
    match action.as_str() {
        "detail" => node.public_post_detail(sequence).await,
        "plan" if confirmed == Some(true) => {
            node.plan_public_post(sequence, peer_ids.ok_or("配信先がありません")?).await?;
            node.public_post_detail(sequence).await
        },
        "retry" if confirmed == Some(true) => node.retry_public_post(sequence, peer_id.as_deref().ok_or("配信先がありません")?).await,
        "plan" | "retry" => Err("本文と配信先の確認が必要です".into()),
        _ => Err("操作が不正です".into()),
    }
}

#[tauri::command]
async fn preview_public_content(
    input: content_protocol::PublicContentDraft,
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<content_protocol::PublicContentPreview, String> {
    state
        .node
        .as_ref()
        .ok_or("この端末の保管先が使えません")?
        .preview_public_content(input)
        .await
}

#[tauri::command]
async fn publish_public_content(
    input: content_protocol::ConfirmPublicContent,
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<content_protocol::PublicContentReceipt, String> {
    state
        .node
        .as_ref()
        .ok_or("この端末の保管先が使えません")?
        .publish_public_content(input)
        .await
}
/// ハブのフィードを読む。
///
/// 取りに行くのは Rust。窓の CSP は外へ出られないままにしておく。緩めると、
/// この窓で動くものが任意の宛先へ出られるようになる。
#[tauri::command]
async fn hub_peer_control(
    window: tauri::Webview, state: tauri::State<'_, Arc<RunnerState>>, action:String,
    node_url:Option<String>, preview_id:Option<String>, confirmed:Option<bool>, peer_id:Option<String>, sequence:Option<u64>,
    delivery_id:Option<String>, expected_context:Option<String>,
) -> Result<serde_json::Value,String> {
    native_pi(&window)?;
    let node=state.node.as_ref().ok_or("この端末の保管先が使えません")?;
    if action == "read" {
        let url=window.url().map_err(|_|"native_window_required")?;
        if !local_pairing_address(window.label(),&url) { return Err("native_window_required".into()); }
        if node_url.is_some() || preview_id.is_some() || confirmed.is_some() || peer_id.is_some() || sequence.is_some() {
            return Err("node_peer_read_invalid_request".into());
        }
        return node.read_received_content(delivery_id.as_deref().ok_or("node_peer_read_invalid_request")?,
            expected_context.as_deref().ok_or("node_peer_read_invalid_request")?).await;
    }
    if delivery_id.is_some() || expected_context.is_some() { return Err("node_peer_read_invalid_request".into()); }
    match action.as_str() {
        "list" => {
            let events=node.pending_events(100).await.into_iter().filter(|e|e.event["payload"]["envelope"]["visibility"]["mode"]=="public")
                .map(|e|serde_json::json!({"sequence":e.sequence,"title":e.event["payload"]["envelope"]["title"]})).collect::<Vec<_>>();
            Ok(serde_json::json!({"peers":node.peers().await,"inbox":node.peer_inbox().await,"events":events,"context":node.peer_read_context().await.ok()}))
        },
        "preview" => serde_json::to_value(node.preview_peer(node_url.as_deref().ok_or("URLがありません")?).await?).map_err(|_|"形式が不正です".into()),
        "confirm" => serde_json::to_value(node.confirm_peer(peer_node::ConfirmPeer{preview_id:preview_id.ok_or("確認対象がありません")?,confirmed_fingerprints:confirmed==Some(true)}).await?).map_err(|_|"形式が不正です".into()),
        "deliver" => {
            if confirmed!=Some(true) {return Err("送信内容を確認してください".into());}
            let sequence=sequence.ok_or("原本が選ばれていません")?;
            let public=node.is_pending_public_event(sequence).await;
            if !public {return Err("この画面から送れるのは配信待ちの公開原本だけです".into());}
            serde_json::to_value(node.deliver_event_to_peer(peer_id.as_deref().ok_or("送信先がありません")?,sequence).await?).map_err(|_|"形式が不正です".into())
        },
        _=>Err("操作が不正です".into()),
    }
}
#[tauri::command]
async fn hub_post_manifest(window: tauri::Webview, origin: String) -> Result<serde_json::Value,String> {
    native_pi(&window)?;
    hub_network::post_manifest(&origin).await
}
#[tauri::command]
async fn hub_post_peer_control(window: tauri::Webview, expected_device_id: String, input: serde_json::Value) -> Result<serde_json::Value,String> {
    native_pi(&window)?;
    let base=hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    hub_network::peer_control(&base,&expected_device_id,&input).await
}
#[tauri::command]
async fn hub_network_sources(window: tauri::Webview, expected_device_id: String, action: String, origin: Option<String>) -> Result<hub_network::Sources,String> {
    native_pi(&window)?;
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    hub_network::account_sources(&base, &expected_device_id, &action, origin.as_deref()).await
}
#[tauri::command]
async fn hub_network_read(window: tauri::Webview, origin: String, kind: String, query: Option<String>) -> Result<hub_network::Catalog,String> {
    native_pi(&window)?;
    hub_network::read_query(&origin, &kind, query.as_deref().unwrap_or("")).await
}
/// 接続先Hubの公開トラック音声。生バイトを IPC で返す（窓は blob: の <audio> に載せる）。
/// 直前に読んだ音楽一覧が名指しした (origin, path) だけを通す。
#[tauri::command]
async fn hub_network_audio(window: tauri::Webview, origin: String, path: String) -> Result<tauri::ipc::Response,String> {
    native_pi(&window)?;
    Ok(tauri::ipc::Response::new(hub_network::audio(&origin,&path).await?))
}
#[tauri::command]
async fn hub_social_stream(window: tauri::Webview, filter: String, scope: String, limit: u32, cursor: Option<String>) -> Result<serde_json::Value, String> {
    if window.label() != "main" { return Err("native_window_required".into()); }
    native_pi(&window)?;
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    hub_client::fetch_social_stream(&base, &filter, &scope, limit, cursor.as_deref()).await
}

#[tauri::command]
async fn hub_feed(
    scope: String,
    limit: u32,
    offset: Option<u32>,
    cursor: Option<String>,
) -> Result<hub_client::Feed, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    hub_client::fetch_feed(&base, &scope, limit, offset.unwrap_or(0), cursor.as_deref()).await
}
#[tauri::command]
async fn hub_resource(
    resource: String,
    query: String,
    cursor: Option<String>,
    board_key: Option<String>,
    offset: Option<u32>,
    category: Option<String>,
    order: Option<String>,
    search_filters: Option<hub_client::DesktopSearchFilters>,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    hub_client::fetch_resource(&base, &resource, &query, cursor.as_deref(), board_key.as_deref(), offset, category.as_deref(), order.as_deref(), search_filters.as_ref()).await
}
/// 本人専用の読み取り。公開面と違って assertion を必ず付けるので、
/// 未接続なら `desktop_not_connected` で窓へ返る。
#[tauri::command]
async fn hub_client(
    name: String,
    conversation: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    hub_client::fetch_client(&base, &name, conversation.as_deref()).await
}
/// 本人専用の操作（既読化・DM送信）。行えることは hub_client::post_client の
/// 固定表に閉じている。options は各操作が必要とする決まったキーだけを
/// Rust側で取り出す——窓のJSONをそのまま本文に流さない。
#[tauri::command]
async fn hub_client_action(
    window: tauri::Webview,
    action: String,
    target: Option<String>,
    text: Option<String>,
    request_id: Option<String>,
    options: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    if matches!(action.as_str(), "create_article" | "thread_post_relationship" | "tip_settings" | "cancel_event_listing" | "read_notification" | "read_all_notifications" | "community_post" | "read_conversation" | "send_message") { if window.label() != "main" { return Err("article_publication_rejected".into()); } native_pi(&window).map_err(|_| "article_publication_rejected")?; }
    if action=="create_post" && options.as_ref().is_some_and(|value|["expectedDeviceId","expectedOrigin","expectedViewerId"].iter().any(|key|value.get(key).is_some())) {
        if window.label()!="main" { return Err("feed_operation_scope_conflict".into()); }
        native_pi(&window).map_err(|_|"feed_operation_scope_conflict")?;
    }
    hub_client::post_client(
        &base,
        &action,
        target.as_deref(),
        text.as_deref(),
        request_id.as_deref(),
        options.as_ref(),
    )
    .await
}
#[tauri::command]
async fn hub_video_metadata(
    window: tauri::Webview,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !local_pairing_address(window.label(), &url) {
        return Err("native_window_required".to_owned());
    }
    hub_client::external_video_metadata(&hub_origin(), &input).await
}
#[tauri::command]
async fn hub_video_register(
    window: tauri::Webview,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !local_pairing_address(window.label(), &url) {
        return Err("native_window_required".to_owned());
    }
    hub_client::external_video_register(&hub_origin(), &input).await
}
#[tauri::command]
async fn hub_music_metadata(
    window: tauri::Webview,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !local_pairing_address(window.label(), &url) {
        return Err("native_window_required".to_owned());
    }
    hub_client::external_music_metadata(&hub_origin(), &input).await
}
#[tauri::command]
async fn hub_music_register(
    window: tauri::Webview,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !local_pairing_address(window.label(), &url) {
        return Err("native_window_required".to_owned());
    }
    hub_client::external_music_register(&hub_origin(), &input).await
}
#[tauri::command]
async fn hub_music_report(
    window: tauri::Webview,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !local_pairing_address(window.label(), &url) {
        return Err("native_window_required".to_owned());
    }
    hub_client::external_music_report(&hub_origin(), &input).await
}

/// 投稿画像のアップロード。窓からは canvas で作り直した WebP バイト列だけを
/// 受ける（ファイルパスは渡さない）。宛先・認証・上限は post_image に固定。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn hub_upload_image(
    window:tauri::Webview,
    image: Vec<u8>,
    thumbnail: Vec<u8>,
    width: u32,
    height: u32,
    thumbnail_width: u32,
    thumbnail_height: u32,
    alt_text: Option<String>,
    expected_device_id: Option<String>,
    expected_origin: Option<String>,
    expected_viewer_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let scoped=expected_device_id.is_some()||expected_origin.is_some()||expected_viewer_id.is_some();
    let scope=if scoped {
        if window.label()!="main" { return Err("image_scope_conflict".into()); }
        native_pi(&window).map_err(|_|"image_scope_conflict")?;
        Some(serde_json::json!({"expectedDeviceId":expected_device_id.ok_or("image_scope_conflict")?,
            "expectedOrigin":expected_origin.ok_or("image_scope_conflict")?,"expectedViewerId":expected_viewer_id.ok_or("image_scope_conflict")?}))
    }else{None};
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    hub_client::post_image(
        &base,
        image,
        thumbnail,
        width,
        height,
        thumbnail_width,
        thumbnail_height,
        alt_text,
        scope.as_ref(),
    )
    .await
}
/// DM 添付画像のアップロード。投稿画像と同じ形だが、ハブ側では DM 専用の
/// pending 表へ入る（/api/client/dm-images）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn hub_upload_dm_image(
    window: tauri::Webview,
    image: Vec<u8>,
    thumbnail: Vec<u8>,
    width: u32,
    height: u32,
    thumbnail_width: u32,
    thumbnail_height: u32,
    alt_text: Option<String>,
    expected_device_id: Option<String>,
    expected_origin: Option<String>,
    expected_viewer_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let scoped=expected_device_id.is_some()||expected_origin.is_some()||expected_viewer_id.is_some();
    let scope=if scoped {
      if window.label()!="main" {return Err("dm_scope_conflict".into());}native_pi(&window).map_err(|_|"dm_scope_conflict")?;
      Some(serde_json::json!({"expectedDeviceId":expected_device_id.ok_or("dm_scope_conflict")?,"expectedOrigin":expected_origin.ok_or("dm_scope_conflict")?,"expectedViewerId":expected_viewer_id.ok_or("dm_scope_conflict")?}))
    }else{None};
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    hub_client::post_dm_image(
        &base,
        image,
        thumbnail,
        width,
        height,
        thumbnail_width,
        thumbnail_height,
        alt_text,
        scope.as_ref(),
    )
    .await
}
/// DM 添付画像のバイト取得。窓の <img> には Bearer を付けられないので、
/// Rust が取ってきたバイト列から窓が blob を作る。参加者以外はハブが 404。
#[tauri::command]
async fn hub_dm_image(
    image_id: String,
    variant: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    let (bytes, mime) =
        hub_client::fetch_dm_image(&base, &image_id, variant.as_deref().unwrap_or("thumbnail")).await?;
    Ok(serde_json::json!({ "bytes": bytes, "mimeType": mime }))
}
/// 詳細面を1件読む。識別子は区切りごとに検証され、固定テンプレートにだけ
/// 入る。viewerで変わる面には接続済みならassertionが添えられる。
#[tauri::command]
async fn hub_detail(
    window: tauri::Webview,
    name: String,
    ids: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    if matches!(name.as_str(), "article_publication" | "thread_post_relationship" | "thread_post_history" | "wallet_tip_settings" | "owned_event_listings" | "owned_event_listing" | "research_change_context" | "notification_snapshot" | "dm_snapshot" | "feed_post_request") { if window.label() != "main" { return Err("article_publication_rejected".into()); } native_pi(&window).map_err(|_| "article_publication_rejected")?; }
    hub_client::fetch_detail(&base, &name, &ids.unwrap_or_default()).await
}

#[tauri::command]
async fn research_change_save(window:tauri::Webview,app:tauri::AppHandle,
    project_id:String,document_id:String,version:u64,expected_viewer_id:String,
    expected_device_id:String,expected_origin:String,packet:research_change_file::Packet)->Result<serde_json::Value,String>{
    if window.label()!="main" { return Err("research_change_rejected:403".into()); }
    native_pi(&window).map_err(|_|"research_change_rejected:403")?;
    research_change_file::save(app,research_change_file::ContextRefs{project_id,document_id,version,viewer_id:expected_viewer_id},
        packet,expected_device_id,expected_origin).await
}

/// Anonymous public project snapshot only; remote pages have no command access.
#[tauri::command]
async fn research_public_export_read(window:tauri::Webview,origin:String,project_id:String)->Result<serde_json::Value,String>{
    if window.label()!="main" { return Err("research_public_export_invalid_request".into()); }
    native_pi(&window).map_err(|_|"research_public_export_invalid_request")?;
    let value=research_public_export::read(&origin,&project_id).await?;
    serde_json::to_value(value).map_err(|_|"research_public_export_invalid_response".into())
}
#[tauri::command]
async fn research_public_export_save(window:tauri::Webview,app:tauri::AppHandle,origin:String,
    project_id:String,snapshot_hash:String,packet:serde_json::Value)->Result<serde_json::Value,String>{
    if window.label()!="main" { return Err("research_public_export_invalid_request".into()); }
    native_pi(&window).map_err(|_|"research_public_export_invalid_request")?;
    research_public_export::save(app,origin,project_id,snapshot_hash,packet).await
}
/// この端末のウォレット状態（アドレス・現在チェーン）。窓は読むだけ——
/// 署名や送信は必ず個別の確認を通す。
#[tauri::command]
fn wallet_status() -> Result<serde_json::Value, String> {
    desktop_wallet::status()
}
/// 選択中チェーンのネイティブ残高（wei の10進文字列）とチェーンID。読み取りのみ。
#[tauri::command]
async fn wallet_balance() -> Result<serde_json::Value, String> {
    let (chain_id, wei) = desktop_wallet::native_balance_wei().await?;
    Ok(serde_json::json!({ "chainId": chain_id, "balanceWei": wei }))
}
/// 選択中チェーンの既知トークン残高。読み取りのみ。
#[tauri::command]
async fn wallet_token_balances() -> Result<serde_json::Value, String> {
    desktop_wallet::token_balances().await
}
/// ネットワークの切り替え。ウォレット画面または切り替え確認からの明示操作だけ。
#[tauri::command]
fn wallet_select_chain(window: tauri::Webview, chain_id: u64) -> Result<serde_json::Value, String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !local_pairing_address(window.label(), &url) { return Err("native_window_required".into()); }
    desktop_wallet::select_chain(chain_id)
}
/// 開発者設定（テスト網を選べるようにする）。
#[tauri::command]
fn wallet_set_developer(window: tauri::Webview, enabled: bool) -> Result<serde_json::Value, String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !local_pairing_address(window.label(), &url) { return Err("native_window_required".into()); }
    desktop_wallet::set_developer(enabled)
}
/// typedData への署名（ウォレット連携用）。メイン窓の確認モーダルで
/// 明示承認を取ってから署名する。
#[tauri::command]
async fn wallet_sign_typed_data(
    app: tauri::AppHandle,
    typed_data: serde_json::Value,
) -> Result<String, String> {
    desktop_wallet::sign_typed_data_confirmed(&app, &typed_data).await
}
/// ネイティブトークンの送金（チップ）。数量はweiの10進文字列——
/// 窓がhexを組み立てることはしない。
#[tauri::command]
async fn wallet_send_native(
    app: tauri::AppHandle,
    chain_id: u64,
    to: String,
    amount_wei: String,
) -> Result<String, String> {
    let wei = amount_wei
        .trim()
        .parse::<u128>()
        .map_err(|_| "数量が正しくありません".to_owned())?;
    desktop_wallet::send_native_confirmed(&app, chain_id, &to, &format!("0x{wei:x}")).await
}
/// 確認モーダルの応答。承認も否決もここへ来る。
#[tauri::command]
fn wallet_confirm_respond(window: tauri::Webview, id: String, approved: bool) -> Result<(), String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !local_pairing_address(window.label(), &url) { return Err("native_window_required".into()); }
    desktop_wallet::resolve_confirmation(&id, approved);
    Ok(())
}
/// コントラクト呼出し（ECのエスクロー入金など）。確認モーダルを挟む。
/// 窓が渡せるのは宛先・数量・calldata・人間向け概要——calldataは
/// Commerceが組み立てたものをそのまま通す想定で、hexの形だけ検査する。
#[tauri::command]
async fn wallet_send_contract(
    window: tauri::Webview,
    app: tauri::AppHandle,
    chain_id: u64,
    to: String,
    value_wei: String,
    data: String,
    summary: String,
    recovery_order_id: Option<String>,
    recovery_phase: Option<String>,
) -> Result<String, String> {
    native_pi(&window)?;
    let wei = wallet_contract_value(&value_wei)?;
    if summary.trim().is_empty() || summary.chars().count() > 200 {
        return Err("wallet_params_invalid".to_owned());
    }
    match (recovery_order_id, recovery_phase) {
        (Some(order_id), Some(phase)) => {
            let scope = commerce::commerce_base()?;
            let (expected_sender, refund_expires_at) = if phase.starts_with("refund:") {
                let quote = commerce::seller_refund_active_quote(&order_id).await.map_err(|_| "wallet_fee_unavailable")?;
                if commerce::commerce_base()? != scope
                    || !refund_transfer_matches(&quote, &order_id, &phase, chain_id, &to, wei, &data) {
                    return Err("wallet_fee_stale".into());
                }
                let expiry = quote["refundQuote"]["expiresAt"].as_str()
                    .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok()).ok_or("wallet_fee_stale")?;
                (Some(quote["refundQuote"]["sellerAddress"].as_str().ok_or("wallet_fee_stale")?.to_owned()), Some(expiry.timestamp_millis()))
            } else { (None, None) };
            desktop_wallet::send_contract_confirmed_recoverable(
                &app, chain_id, &to, &format!("0x{wei:x}"), &data, summary.trim(),
                &scope, &order_id, &phase, expected_sender.as_deref(), refund_expires_at,
            ).await
        },
        (None, None) => desktop_wallet::send_contract_confirmed(
            &app, chain_id, &to, &format!("0x{wei:x}"), &data, summary.trim(),
        ).await,
        _ => Err("wallet_params_invalid".into()),
    }
}

#[allow(clippy::too_many_arguments)]
fn refund_transfer_matches(body: &serde_json::Value, order_id: &str, phase: &str, chain_id: u64, to: &str, value: u128, data: &str) -> bool {
    let quote = &body["refundQuote"];
    let Some(id) = quote["id"].as_str() else { return false; };
    let transfer = &quote["sellerTransfer"];
    quote["expiresAt"].as_str().and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .is_some_and(|at| at.timestamp_millis() > chrono::Utc::now().timestamp_millis())
        && quote["sellerAddress"].as_str().is_some()
        && quote["orderId"].as_str() == Some(order_id) && phase == format!("refund:{id}")
        && transfer["chainId"].as_u64() == Some(chain_id)
        && transfer["to"].as_str().is_some_and(|target| target.eq_ignore_ascii_case(to))
        && transfer["value"].as_str() == Some(format!("0x{value:x}").as_str())
        && transfer["data"].as_str().is_some_and(|input| input.eq_ignore_ascii_case(data))
}

fn wallet_contract_value(value: &str) -> Result<u128, String> {
    value.strip_prefix("0x")
        .filter(|value| !value.is_empty() && value.len() <= 32 && (*value == "0" || !value.starts_with('0')) && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .and_then(|value| u128::from_str_radix(value, 16).ok())
        .ok_or_else(|| "wallet_params_invalid".into())
}

/// Read the locally saved payment identifier; this cannot sign or broadcast.
#[tauri::command]
fn wallet_recover_contract(window: tauri::Webview, order_id: String, phase: String) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    desktop_wallet::recover_contract(&commerce::commerce_base()?, &order_id, &phase)
}

/// Inspect saved approval and current allowance without signing or sending.
#[tauri::command]
async fn wallet_check_approval(
    window: tauri::Webview,
    order_id: String,
    chain_id: u64,
    token_contract: String,
    spender: String,
    amount_atomic: String,
    approval_data: String,
) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    desktop_wallet::check_approval(
        &commerce::commerce_base()?, &order_id, chain_id, &token_contract,
        &spender, &amount_atomic, &approval_data,
    ).await
}

/// Initialize operation bookkeeping only after an explicit new escrow action.
#[tauri::command]
fn wallet_escrow_begin(window: tauri::Webview, order_id: String) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    desktop_wallet::escrow_begin(&commerce::commerce_base()?, &order_id)
}

/// Read saved escrow identifiers without preparing or broadcasting a transaction.
#[tauri::command]
fn wallet_escrow_pending(window: tauri::Webview, order_id: String) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    desktop_wallet::escrow_pending(&commerce::commerce_base()?, &order_id)
}

/// Initialize direct-refund bookkeeping only for an explicit refund action.
#[tauri::command]
fn wallet_refund_begin(window: tauri::Webview, order_id: String) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    desktop_wallet::refund_begin(&commerce::commerce_base()?, &order_id)
}

/// Read the original refund identity without preparing or sending money.
#[tauri::command]
fn wallet_refund_pending(window: tauri::Webview, order_id: String) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    desktop_wallet::refund_pending(&commerce::commerce_base()?, &order_id)
}

/// Confirm the original seller transfer against authenticated Commerce data.
#[tauri::command]
async fn wallet_finish_refund(window: tauri::Webview, order_id: String, phase: String) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    let scope = commerce::commerce_base()?;
    desktop_wallet::finish_refund(&scope, &order_id, &phase, || async {
        if commerce::commerce_base()? != scope { return Err("wallet_refund_mismatch".into()); }
        let detail = commerce::seller_order_detail(&order_id).await?;
        if commerce::commerce_base()? != scope { return Err("wallet_refund_mismatch".into()); }
        Ok(detail)
    }).await
}

/// Read only durable finalized-failure metadata for the existing wallet.
#[tauri::command]
fn wallet_escrow_history(window: tauri::Webview, order_id: String) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    desktop_wallet::escrow_history(&commerce::commerce_base()?, &order_id)
}

/// Inspect the original transaction; this command never signs or broadcasts.
#[tauri::command]
async fn wallet_check_escrow_failure(
    window: tauri::Webview,
    order_id: String,
    phase: String,
    access_token: Option<String>,
) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    let scope = commerce::commerce_base()?;
    let role = desktop_wallet::escrow_role(&phase)?;
    desktop_wallet::check_escrow_failure(&scope, &order_id, &phase, || async {
        if commerce::commerce_base()? != scope {
            return Err("wallet_escrow_mismatch".into());
        }
        let detail = match role {
            "buyer" => commerce::order_status(&order_id, access_token.as_deref().unwrap_or("")).await?,
            "seller" => commerce::seller_order_detail(&order_id).await?,
            _ => return Err("wallet_escrow_invalid".into()),
        };
        if commerce::commerce_base()? != scope {
            return Err("wallet_escrow_mismatch".into());
        }
        Ok(detail)
    }).await
}

/// Resolve local bookkeeping only against authenticated Commerce evidence.
#[tauri::command]
async fn wallet_finish_escrow(
    window: tauri::Webview,
    order_id: String,
    phase: String,
    access_token: Option<String>,
) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    let scope = commerce::commerce_base()?;
    let role = desktop_wallet::escrow_role(&phase)?;
    desktop_wallet::finish_escrow(&scope, &order_id, &phase, || async {
        if commerce::commerce_base()? != scope {
            return Err("wallet_escrow_mismatch".into());
        }
        let detail = match role {
            "buyer" => commerce::order_status(&order_id, access_token.as_deref().unwrap_or("")).await?,
            "seller" => commerce::seller_order_detail(&order_id).await?,
            _ => return Err("wallet_escrow_invalid".into()),
        };
        if commerce::commerce_base()? != scope {
            return Err("wallet_escrow_mismatch".into());
        }
        Ok(detail)
    }).await
}

/// EC（Commerce Worker）面。全て読みは公開、書きは署名済み
/// fulfillment assertion と access token が要る。鍵・配送先は
/// ここにも窓にも出ない。
#[tauri::command]
async fn commerce_catalog(
    query: Option<String>,
    seller_id: Option<String>,
    before: Option<String>,
    sort: Option<String>,
    kind: Option<String>,
    in_stock: Option<bool>,
    free_shipping: Option<bool>,
) -> Result<serde_json::Value, String> {
    commerce::catalog_filtered(
        query.as_deref(),
        seller_id.as_deref(),
        before.as_deref(),
        sort.as_deref(),
        kind.as_deref(),
        in_stock,
        free_shipping,
    )
    .await
}
#[tauri::command]
async fn commerce_public_product(product_id: String) -> Result<serde_json::Value,String> {
    commerce::public_product(&product_id).await
}
#[tauri::command]
async fn commerce_fulfillment_quote(
    product_id: String,
    fulfillment_mode: String,
) -> Result<serde_json::Value, String> {
    commerce::fulfillment_quote(&product_id, &fulfillment_mode).await
}
#[tauri::command]
async fn commerce_order_create(params: serde_json::Value) -> Result<serde_json::Value, String> {
    commerce::order_create(&params).await
}
#[tauri::command]
async fn commerce_checkout_pending() -> Result<serde_json::Value, String> {
    commerce::checkout_pending().await
}
#[tauri::command]
async fn commerce_checkout_finish(operation_id: String) -> Result<serde_json::Value, String> {
    commerce::checkout_finish(&operation_id).await
}
#[tauri::command]
async fn commerce_order_submit(
    order_id: String,
    access_token: String,
    transaction_hash: String,
) -> Result<serde_json::Value, String> {
    commerce::order_submit(&order_id, &access_token, &transaction_hash).await
}
#[tauri::command]
async fn commerce_order_status(
    order_id: String,
    access_token: String,
) -> Result<serde_json::Value, String> {
    commerce::order_status(&order_id, &access_token).await
}
#[tauri::command]
async fn commerce_order_cancel(
    order_id: String,
    access_token: String,
) -> Result<serde_json::Value, String> {
    commerce::order_cancel(&order_id, &access_token).await
}
/// エスクロー操作の準備（受取確認・未発送返金・異議・解決案）。
/// Commerce発行の領収書。
#[tauri::command]
async fn commerce_order_receipt(
    order_id: String,
    access_token: String,
) -> Result<serde_json::Value, String> {
    commerce::order_receipt(&order_id, &access_token).await
}
/// calldataはCommerceが組み立てる——送信は wallet_send_contract が担う。
#[tauri::command]
async fn commerce_escrow_prepare(
    order_id: String,
    access_token: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    commerce::escrow_action_prepare(&order_id, &access_token, &params).await
}
/// エスクロー操作txの照合。
#[tauri::command]
async fn commerce_escrow_submit(
    order_id: String,
    access_token: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    commerce::escrow_action_submit(&order_id, &access_token, &params).await
}
/// 返品申請。
#[tauri::command]
async fn commerce_return_request(
    order_id: String,
    access_token: String,
    reason_code: String,
    detail: String,
) -> Result<serde_json::Value, String> {
    commerce::return_request(&order_id, &access_token, &reason_code, &detail).await
}
/// 返品の発送登録（承認済み返品に限る）。
#[tauri::command]
async fn commerce_return_shipment(
    order_id: String,
    access_token: String,
    carrier: String,
    tracking_number: String,
) -> Result<serde_json::Value, String> {
    commerce::return_shipment(&order_id, &access_token, &carrier, &tracking_number).await
}
/// 出品者面。セッションは資格情報保管庫に留まり、窓には出ない。
#[tauri::command]
fn commerce_seller_state() -> Result<serde_json::Value, String> {
    commerce::seller_state()
}
#[tauri::command]
async fn commerce_seller_login() -> Result<serde_json::Value, String> {
    commerce::seller_login().await
}
#[tauri::command]
async fn commerce_seller_logout() -> Result<(), String> {
    commerce::seller_logout().await
}
#[tauri::command]
async fn commerce_seller_challenge(
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    commerce::seller_onboarding_challenge(&params).await
}
/// 出品者登録の完了——challenge messageを確認モーダル経由で署名する。
#[tauri::command]
async fn commerce_seller_complete(
    app: tauri::AppHandle,
    challenge_id: String,
    message: String,
) -> Result<serde_json::Value, String> {
    commerce::seller_onboarding_complete(&app, &challenge_id, &message).await
}
#[tauri::command]
async fn commerce_seller_products(
    before: Option<String>,
) -> Result<serde_json::Value, String> {
    commerce::seller_products(before.as_deref()).await
}
#[tauri::command]
async fn commerce_seller_attribution_proof(
    product_id: String,
    challenge: String,
) -> Result<serde_json::Value, String> {
    commerce::seller_attribution_proof(&product_id, &challenge).await
}
#[tauri::command]
async fn commerce_seller_product_save(
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    commerce::seller_product_save(&params).await
}
#[tauri::command]
async fn commerce_seller_orders(
    before: Option<String>,
    purpose: Option<String>,
) -> Result<serde_json::Value, String> {
    commerce::seller_orders(before.as_deref(), purpose.as_deref()).await
}

/// 受け取り注文の引き渡し済み記録。
#[tauri::command]
async fn commerce_seller_mark_delivered(order_id: String) -> Result<serde_json::Value, String> {
    commerce::seller_mark_delivered(&order_id).await
}
/// 注文CSVエクスポート。
#[tauri::command]
async fn commerce_seller_orders_csv() -> Result<String, String> {
    commerce::seller_orders_csv().await
}
/// 注文詳細（異議中の解決期限・配分案・イベント）。
#[tauri::command]
async fn commerce_seller_order_detail(
    order_id: String,
) -> Result<serde_json::Value, String> {
    commerce::seller_order_detail(&order_id).await
}
/// 発送登録（配送業者と追跡番号）。
#[tauri::command]
async fn commerce_seller_ship(
    order_id: String,
    carrier: String,
    tracking_number: String,
) -> Result<serde_json::Value, String> {
    commerce::seller_ship(&order_id, &carrier, &tracking_number).await
}
/// 返品申請の裁定（approved/rejected/received）。
#[tauri::command]
async fn commerce_seller_return_review(
    order_id: String,
    decision: String,
) -> Result<serde_json::Value, String> {
    commerce::seller_return_review(&order_id, &decision).await
}
/// 出品者側エスクロー操作の準備/提出。
#[tauri::command]
async fn commerce_seller_escrow(
    order_id: String,
    submit: bool,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    commerce::seller_escrow(&order_id, submit, &params).await
}
/// Read an existing refund quote without creating another quote.
#[tauri::command]
async fn commerce_seller_refund_active_quote(window: tauri::Webview, order_id: String) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    commerce::seller_refund_active_quote(&order_id).await
}
#[tauri::command]
async fn commerce_seller_refund_quote(
    order_id: String,
    amount_atomic: String,
) -> Result<serde_json::Value, String> {
    commerce::seller_refund_quote(&order_id, &amount_atomic).await
}
/// 返金txの照合。
#[tauri::command]
async fn commerce_seller_refund_submit(
    order_id: String,
    refund_quote_id: String,
    transaction_hash: String,
) -> Result<serde_json::Value, String> {
    commerce::seller_refund_submit(&order_id, &refund_quote_id, &transaction_hash).await
}
/// 商品画像のアップロード——ファイルはOSのダイアログで選ばせ、
/// バイト列は窓に出さずRust側で読んで送る。
#[tauri::command]
async fn commerce_seller_media_upload(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("画像", &["jpg", "jpeg", "png", "webp"])
        .pick_file(move |chosen| {
            let _ = tx.send(chosen);
        });
    let Some(chosen) = rx
        .await
        .map_err(|_| "画像の選択を完了できませんでした".to_owned())?
    else {
        return Err("cancelled".to_owned());
    };
    let path = chosen.as_path().ok_or("media_path_unavailable")?;
    commerce::seller_media_upload(path.as_ref()).await
}
/// 出品者メディア一覧（審査状態つき）。
#[tauri::command]
async fn commerce_seller_media(
    before: Option<String>,
) -> Result<serde_json::Value, String> {
    commerce::seller_media(before.as_deref()).await
}
/// 商品画像の削除。
#[tauri::command]
async fn commerce_seller_media_delete(
    media_id: String,
) -> Result<serde_json::Value, String> {
    commerce::seller_media_delete(&media_id).await
}
/// 支払い例外の一覧。
#[tauri::command]
async fn commerce_seller_payment_exceptions() -> Result<serde_json::Value, String> {
    commerce::seller_payment_exceptions().await
}
/// 支払い例外の解決照合（返送txのtxHashを渡す）。
#[tauri::command]
async fn commerce_seller_payment_exception_resolve(
    exception_id: String,
    transaction_hash: String,
) -> Result<serde_json::Value, String> {
    commerce::seller_payment_exception_resolve(&exception_id, &transaction_hash).await
}
/// 購入者側の支払い例外解決（追加入金txのtxHashを渡す）。
#[tauri::command]
async fn commerce_order_payment_exception_resolve(
    order_id: String,
    access_token: String,
    transaction_hash: String,
) -> Result<serde_json::Value, String> {
    commerce::order_payment_exception_resolve(&order_id, &access_token, &transaction_hash).await
}
/// 加盟店ウォレットの状態（読み取り専用）。
#[tauri::command]
async fn commerce_seller_wallet() -> Result<serde_json::Value, String> {
    commerce::seller_wallet().await
}
/// 公開のチェーンカタログ。
#[tauri::command]
async fn commerce_payment_chain_catalog() -> Result<serde_json::Value, String> {
    commerce::payment_chain_catalog().await
}
/// チェーン別受取先の一覧。
#[tauri::command]
async fn commerce_seller_chain_destinations() -> Result<serde_json::Value, String> {
    commerce::seller_chain_destinations().await
}
/// チェーン別受取先の登録・更新。
#[tauri::command]
async fn commerce_seller_chain_destination_put(
    network_key: String,
    address: String,
    address_tag: Option<String>,
) -> Result<serde_json::Value, String> {
    commerce::seller_chain_destination_put(&network_key, &address, address_tag.as_deref()).await
}
/// チェーン別受取先の無効化。
#[tauri::command]
async fn commerce_seller_chain_destination_disable(
    network_key: String,
) -> Result<serde_json::Value, String> {
    commerce::seller_chain_destination_disable(&network_key).await
}
/// 売上概要。
#[tauri::command]
async fn commerce_seller_analytics() -> Result<serde_json::Value, String> {
    commerce::seller_analytics().await
}
/// メッセージ署名（販売者登録のウォレット所有確認など）。
/// 確認モーダルを挟む。
#[tauri::command]
async fn wallet_sign_message(
    app: tauri::AppHandle,
    summary: String,
    message: String,
) -> Result<String, String> {
    desktop_wallet::sign_message_confirmed(&app, summary.trim(), &message).await
}
/// URLをOSの既定ブラウザで開く。アプリ内ブラウザは外部サイト専用で
/// Web版Hubは開かないので、端末連携の承認など Web版が必要な場面は
/// ここで本体ブラウザへ手渡す。http/https 以外は拒否。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|_| "invalid_url".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("invalid_url".to_owned());
    }
    let target = parsed.as_str();
    #[cfg(windows)]
    let spawn = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", target])
        .spawn();
    #[cfg(target_os = "macos")]
    let spawn = std::process::Command::new("open").arg(target).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawn = std::process::Command::new("xdg-open").arg(target).spawn();
    spawn.map(|_| ()).map_err(|_| "open_failed".to_owned())
}
/// Compute面: 公開情報＋本人の予約をまとめて返す。
#[tauri::command]
async fn compute_status() -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    compute_client::status(&base).await
}
/// 無料デモのテキスト変換。
#[tauri::command]
async fn compute_demo(text: String, operation: String) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    compute_client::demo(&base, &text, &operation).await
}
/// 予約作成。資金枠の確保まで畳む——料率・資産はオファーから引く。
#[tauri::command]
async fn compute_reserve(
    offer_id: String,
    starts_at_ms: u64,
    duration_hours: u64,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    compute_client::reserve(&base, &offer_id, starts_at_ms, duration_hours).await
}
/// 予約へのテキストジョブ投入。
#[tauri::command]
async fn compute_submit_text(
    reservation_id: String,
    text: String,
    operation: String,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    compute_client::submit_text(&base, &reservation_id, &text, &operation).await
}
/// 予約に紐づくジョブの状態・結果。
#[tauri::command]
async fn compute_reservation_job(reservation_id: String) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    compute_client::reservation_job(&base, &reservation_id).await
}
/// 予約のキャンセル。
#[tauri::command]
async fn compute_cancel_reservation(reservation_id: String) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    compute_client::cancel_reservation(&base, &reservation_id).await
}
/// ジョブ単体の状態・結果。
#[tauri::command]
async fn compute_job(job_id: String) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    compute_client::job(&base, &job_id).await
}
/// 公開トラック一覧。公開・クリーン・再生可能なものだけがワーカーから来る。
#[tauri::command]
async fn music_tracks(query: Option<String>, offset: Option<u32>) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    music_player::tracks(&base, query.as_deref().unwrap_or(""), offset.unwrap_or(0)).await
}
/// トラック音声。生バイトを IPC で返し、窓は blob: の <audio> に乗せる。
#[tauri::command]
async fn music_audio(track_id: String) -> Result<tauri::ipc::Response, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    Ok(tauri::ipc::Response::new(
        music_player::audio(&base, &track_id).await?,
    ))
}
/// P2P 配布の手元キャッシュ（docs/hub-distributed-media/DESIGN.md §6）。置き場は Personal Node の保管先の下の media-cache/。
async fn media_storage(state: &tauri::State<'_, Arc<RunnerState>>) -> Result<String, String> {
    let node = state.node.as_ref().ok_or("media_unavailable:node_storage")?;
    let path = node.status().await.storage_path;
    if path.is_empty() { return Err("media_unavailable:node_storage".into()); }
    Ok(path)
}
/// 署名済み manifest で照合した Hub 公開曲の音声。失敗が "media_unavailable:" で始まるときは窓が直の URL へ戻る。
#[tauri::command]
async fn media_audio(origin: String, track_id: String, state: tauri::State<'_, Arc<RunnerState>>) -> Result<tauri::ipc::Response, String> {
    let storage = media_storage(&state).await?;
    let own = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    media_cache::command_audio(&storage, &own, &origin, &track_id).await.map(tauri::ipc::Response::new)
}
#[tauri::command]
async fn media_p2p_settings_get(state: tauri::State<'_, Arc<RunnerState>>) -> Result<media_cache::MediaP2pSettings, String> {
    media_cache::command_settings_get(&media_storage(&state).await?)
}
#[tauri::command]
async fn media_p2p_settings_set(webview: tauri::Webview, settings: media_cache::MediaP2pSettings, state: tauri::State<'_, Arc<RunnerState>>) -> Result<media_cache::MediaP2pSettings, String> {
    crate::native_pi(&webview)?;
    media_cache::command_settings_set(&media_storage(&state).await?, settings)
}
#[tauri::command]
async fn media_cache_clear(webview: tauri::Webview, state: tauri::State<'_, Arc<RunnerState>>) -> Result<(), String> {
    crate::native_pi(&webview)?;
    media_cache::command_clear(&media_storage(&state).await?)
}
#[tauri::command]
async fn media_cache_usage(state: tauri::State<'_, Arc<RunnerState>>) -> Result<(u64, usize), String> {
    media_cache::command_usage(&media_storage(&state).await?)
}
#[tauri::command]
async fn media_cache_maintain(state: tauri::State<'_, Arc<RunnerState>>) -> Result<media_cache::MaintainReport, String> {
    media_cache::command_maintain(&media_storage(&state).await?).await
}
/// トラックのアートワーク。クリーンなものだけワーカーが返す。
#[tauri::command]
async fn music_artwork(track_id: String) -> Result<tauri::ipc::Response, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    Ok(tauri::ipc::Response::new(
        music_player::artwork(&base, &track_id).await?,
    ))
}
/// 自分の Music トラックのうち、プロフィールに表示できる候補のID（{ids}）。管理用 assertion は Rust の中だけで使う。
/// 失敗語は {error} コード——music_link_required は「Web版で Music を有効化」の合図。
#[tauri::command]
async fn music_own_attribution_candidates() -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    music_attribution::own_eligible_ids(&base).await
}
/// プロフィールに表示する証明を Music から直接取る（Hub は中継しない）。トラックID（UUID）と Hub の問いかけだけを受ける。
#[tauri::command]
async fn music_attribution_proof(
    track_id: String,
    challenge: String,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    music_attribution::attribution_proof(&base, &track_id, &challenge).await
}
/// Mail面: このアカウントのメールボックス（無ければ null）。
/// 失敗語は mail_client が拾う {error} コード——mail_link_required は
/// 「Web版で有効化が要る」、mailbox_required は「先にアドレス作成」の合図。
#[tauri::command]
async fn mail_mailbox() -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    mail_client::mailbox(&base).await
}
/// メールボックスの作成。localPart は mail_client 側で形を検証してから送る。
#[tauri::command]
async fn mail_mailbox_create(local_part: String) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    mail_client::create_mailbox(&base, &local_part).await
}
/// フォルダ内のメール一覧。folder は閉じた5種だけを通す。
#[tauri::command]
async fn mail_messages(
    folder: String,
    cursor: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    mail_client::messages(&base, &folder, cursor.as_deref()).await
}
/// メール1件の本文と添付一覧。
#[tauri::command]
async fn mail_message(message_id: String) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    mail_client::message(&base, &message_id).await
}
/// 既読化・フォルダ移動。action は閉じた6動詞だけ。
#[tauri::command]
async fn mail_message_action(
    message_id: String,
    action: String,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    mail_client::message_action(&base, &message_id, &action).await
}
/// 新規メールの送信前確認（preview 発行。まだ送らない）。
#[tauri::command]
async fn mail_compose_preview(
    to: String,
    subject: String,
    text: String,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    mail_client::compose_preview(&base, &to, &subject, &text).await
}
/// 確認済み preview の送信確定。
#[tauri::command]
async fn mail_compose_send(
    preview_id: String,
    idempotency_key: String,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    mail_client::compose_send(&base, &preview_id, &idempotency_key).await
}
/// 返信の送信前確認。宛先・件名はワーカーが元メールから組み立てる。
#[tauri::command]
async fn mail_reply_preview(
    message_id: String,
    text: String,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    mail_client::reply_preview(&base, &message_id, &text).await
}
/// 返信の送信確定。
#[tauri::command]
async fn mail_reply_send(
    message_id: String,
    preview_id: String,
    idempotency_key: String,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    mail_client::reply_send(&base, &message_id, &preview_id, &idempotency_key).await
}
/// 送信結果の確かめ直し。届いたか不明なときだけ窓が呼ぶ。
#[tauri::command]
async fn mail_send_status(intent_id: String) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    mail_client::send_status(&base, &intent_id).await
}
/// 下書き一覧。mailboxId はアカウント紐付けなので窓に渡さない。
#[tauri::command]
async fn mail_drafts() -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    mail_client::drafts(&base).await
}
/// 下書きの保存。宛先・件名・本文は空でもよい（未確定の入力を置く場所）。
/// 同じUUIDへのPUTが更新になるので、窓はドラフトidを保持して送る。
#[tauri::command]
async fn mail_draft_save(
    draft_id: String,
    to: String,
    subject: String,
    text: String,
    in_reply_to: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    mail_client::draft_save(&base, &draft_id, &to, &subject, &text, in_reply_to.as_deref()).await
}
/// 下書きの削除。送信が受理された下書きの後始末にも使う。
#[tauri::command]
async fn mail_draft_delete(draft_id: String) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    mail_client::draft_delete(&base, &draft_id).await
}
/// AI面: 公開カタログ（プロバイダ・ツール・支払いオプション）。
#[tauri::command]
async fn ai_catalog() -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    ai_client::catalog(&base).await
}
/// AI面: 実行。kind は tool|image|video|payment_test。402 なら
/// {status:"payment_required", required} が返り、窓は支払い選択を出す。
#[tauri::command]
async fn ai_call(
    kind: String,
    provider_id: Option<String>,
    tool_id: Option<String>,
    prompt: String,
    aspect_ratio: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    ai_client::call(
        &base,
        &kind,
        provider_id.as_deref(),
        tool_id.as_deref(),
        &prompt,
        aspect_ratio.as_deref(),
    )
    .await
}
/// AI面: 支払い付き実行。accepted は 402 で返った要件1件、display は
/// 窓が組んだ人間向けの金額表示。確認モーダル→EIP-3009署名→再送。
#[tauri::command]
async fn ai_pay_and_call(
    app: tauri::AppHandle,
    kind: String,
    provider_id: Option<String>,
    tool_id: Option<String>,
    prompt: String,
    aspect_ratio: Option<String>,
    accepted: serde_json::Value,
    display: String,
    description: String,
) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    ai_client::pay_and_call(
        &app,
        &base,
        &kind,
        provider_id.as_deref(),
        tool_id.as_deref(),
        &prompt,
        aspect_ratio.as_deref(),
        &accepted,
        &display,
        &description,
    )
    .await
}
/// AI面: 動画の進行確認と完成品の取得。トークンは支払い済み実行の結果。
#[tauri::command]
async fn ai_video_status(token: String) -> Result<serde_json::Value, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    ai_client::video_status(&base, &token).await
}
#[tauri::command]
async fn ai_video_content(token: String) -> Result<tauri::ipc::Response, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    Ok(tauri::ipc::Response::new(
        ai_client::video_content(&base, &token).await?,
    ))
}
/// 添付の保存。バイト列は窓へ渡さず、OSの保存ダイアログで本人が選んだ
/// 場所へだけ書き出す——それ以外にメールの中身をディスクへ置かない。
#[tauri::command]
async fn mail_attachment_download(
    app: tauri::AppHandle,
    message_id: String,
    attachment_id: String,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_dialog::DialogExt;
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    let item = mail_client::attachment(&base, &message_id, &attachment_id).await?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(item.filename.clone())
        .save_file(move |chosen| {
            let _ = tx.send(chosen);
        });
    let Some(chosen) = rx.await.map_err(|_| "保存先を決められませんでした".to_owned())?
    else {
        return Ok(serde_json::json!({ "saved": false }));
    };
    let path = chosen.as_path().ok_or("保存先が使えません")?;
    tokio::fs::write(path, &item.bytes)
        .await
        .map_err(|_| "添付を書き出せませんでした".to_owned())?;
    Ok(serde_json::json!({ "saved": true, "filename": item.filename }))
}
#[tauri::command]
fn desktop_account_status() -> Result<desktop_account::DesktopAccountStatus, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    desktop_account::status(&base)
}
#[tauri::command]
async fn begin_desktop_account(
    label: String,
) -> Result<desktop_account::DesktopAccountStatus, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    desktop_account::begin(&base, &label).await
}
#[tauri::command]
async fn poll_desktop_account() -> Result<desktop_account::DesktopAccountStatus, String> {
    let base = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    desktop_account::poll(&base).await
}
#[tauri::command]
async fn logout_desktop_account(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message("この端末に保存したDesktop認証鍵を削除します。Account側の端末登録と監査、端末内データは削除されません。")
        .title("Hub Desktopからログアウト")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("ログアウト".into(), "キャンセル".into()))
        .show(move |confirmed| { let _ = sender.send(confirmed); });
    if !receiver
        .await
        .map_err(|_| "desktop_account_logout_cancelled")?
    {
        return Err("desktop_account_logout_cancelled".into());
    }
    desktop_account::logout()
}
#[tauri::command]
async fn desktop_agent_usage(
    window: tauri::Webview,
    agent: String,
) -> Result<agent_usage::AgentUsage, String> {
    native(&window)?;
    agent_usage::read(&agent).await.map_err(str::to_owned)
}

/// Work のローカル窓だけが、アプリの主窓を前面に戻せる。
#[tauri::command]
fn return_to_hub(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    if window.label() != "harness" {
        return Err("native_harness_required".into());
    }
    native(window.as_ref())?;
    hub_window::return_to_hub(&app, &window)
}

/// 旧コマンド名との互換口。別窓は作らず、Hub本体のAI画面へ案内する。
/// 非同期にしてメインスレッドからの再入を避ける。
#[tauri::command]
async fn open_harness_window() {
    hub_window::show_local();
}

/// ブラウザ面が最初に開く宛先。窓側に URL を選ばせず、Rust 側の
/// 絞り込み（https かループバック）だけを通る。
#[tauri::command]
fn hub_origin() -> String {
    hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref())
}

/// ゲーム一覧と起動はこの端末の窓だけに出す。HTTPのペアリング権限には含めない。
#[tauri::command]
async fn games(
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<Vec<game_launcher::GameEntry>, String> {
    state
        .games
        .as_ref()
        .ok_or("ゲーム一覧の保管先が使えません")?
        .list()
        .await
        .map_err(game_error)
}
#[tauri::command]
async fn pick_game_executable(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<Option<game_launcher::GameEntry>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_file(move |chosen| {
        let _ = tx.send(chosen);
    });
    let Some(chosen) = rx.await.map_err(|_| "ゲーム選択を完了できませんでした")?
    else {
        return Ok(None);
    };
    state
        .games
        .as_ref()
        .ok_or("ゲーム一覧の保管先が使えません")?
        .add(&chosen.to_string())
        .await
        .map(Some)
        .map_err(game_error)
}
#[tauri::command]
async fn rename_game(
    id: String,
    title: String,
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<game_launcher::GameEntry, String> {
    state
        .games
        .as_ref()
        .ok_or("ゲーム一覧の保管先が使えません")?
        .rename(&id, &title)
        .await
        .map_err(game_error)
}
#[tauri::command]
async fn remove_game(id: String, state: tauri::State<'_, Arc<RunnerState>>) -> Result<(), String> {
    state
        .games
        .as_ref()
        .ok_or("ゲーム一覧の保管先が使えません")?
        .remove(&id)
        .await
        .map_err(game_error)
}
#[tauri::command]
async fn launch_game(
    id: String,
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<game_launcher::GameEntry, String> {
    state
        .games
        .as_ref()
        .ok_or("ゲーム一覧の保管先が使えません")?
        .launch(&id)
        .await
        .map_err(game_error)
}
fn game_error(error: &'static str) -> String {
    match error {
        "game_executable_missing" => "ゲームの実行ファイルが見つかりません".into(),
        "game_executable_must_be_exe" => {
            "Windowsのゲーム実行ファイル（.exe）を選んでください".into()
        }
        "invalid_game_title" => "ゲーム名は1〜80文字で入力してください".into(),
        "game_not_found" => "このゲームは一覧にありません".into(),
        "game_launch_failed" => "ゲームを起動できませんでした".into(),
        "game_library_invalid" => "ゲーム一覧のデータが壊れています".into(),
        _ => "ゲーム一覧の保管先が使えません".into(),
    }
}
#[tauri::command]
async fn dev_agents() -> Vec<dev_cli::DevAgent> {
    dev_cli::agents()
}
#[tauri::command]
async fn dev_workspace() -> Option<String> {
    dev_cli::workspace()
        .map(|path| pi_work::non_verbatim(path).to_string_lossy().into_owned())
}
#[tauri::command]
async fn set_dev_workspace(path: String) -> Result<String, String> {
    dev_cli::set_workspace(&path)
        .map(|path| pi_work::non_verbatim(path).to_string_lossy().into_owned())
        .map_err(str::to_owned)
}
#[tauri::command]
async fn clear_dev_workspace() -> Result<(), String> {
    dev_cli::clear_workspace().map_err(str::to_owned)
}
#[tauri::command]
async fn start_dev_run(
    request: dev_cli::DevRequest,
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<String, String> {
    let workspace = dev_cli::workspace().ok_or("作業フォルダが設定されていません")?;
    dev_cli::DevRuns::start(state.dev_runs.clone(), request, workspace)
        .await
        .map_err(str::to_owned)
}
#[tauri::command]
async fn dev_run(
    id: String,
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<Option<dev_cli::DevRun>, String> {
    Ok(dev_cli::DevRuns::get(&state.dev_runs, &id).await)
}
#[tauri::command]
async fn revert_dev_run(
    id: String,
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<Vec<String>, String> {
    dev_cli::DevRuns::revert(&state.dev_runs, &id)
        .await
        .map_err(str::to_owned)
}
#[tauri::command]
async fn cancel_dev_run(
    id: String,
    state: tauri::State<'_, Arc<RunnerState>>,
) -> Result<(), String> {
    dev_cli::DevRuns::cancel(&state.dev_runs, &id)
        .await
        .map_err(str::to_owned)
}

#[tauri::command]
fn desktop_build_mode() -> &'static str {
    if cfg!(debug_assertions) {
        "development"
    } else {
        "release"
    }
}

/// Set after a close request whose session save failed. A second close request
/// (a user retry, or the installer's periodic normal-exit retry) then exits
/// anyway, so a persistent save problem can never make the app unquittable.
static CLOSE_SAVE_FAILED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const CLOSE_SAVE_BUDGET: Duration = Duration::from_secs(5);
const EXIT_WATCHDOG: Duration = Duration::from_secs(10);

/// Run the session save, but never wait on it longer than `budget`. A save that is
/// stuck (for example on a held lock) counts as a failure.
fn bounded_save(budget: Duration, save: impl FnOnce() -> Result<(), String> + Send + 'static) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || { let _ = tx.send(save()); });
    rx.recv_timeout(budget).unwrap_or_else(|_| Err("session_save_timed_out".into()))
}

fn close_main_window(
    label: &str,
    failed_before: &std::sync::atomic::AtomicBool,
    prevent_close: impl FnOnce(),
    save: impl FnOnce() -> Result<(), String>,
    exit: impl FnOnce(),
    notify_failure: impl FnOnce(),
) {
    use std::sync::atomic::Ordering;
    if label != "main" { return; }
    prevent_close();
    match save() {
        Ok(()) => exit(),
        Err(_) if failed_before.swap(true, Ordering::SeqCst) => exit(),
        Err(_) => notify_failure(),
    }
}

/// Exit the application, with a watchdog: if cleanup after the exit request hangs,
/// the process ends itself instead of lingering and blocking an update.
fn exit_with_watchdog(app: &tauri::AppHandle, grace: Duration) {
    std::thread::spawn(move || { std::thread::sleep(grace); std::process::exit(0); });
    app.exit(0);
}
pub fn run() {
    let native_started = std::time::Instant::now();
    // 港を先に取る。取れなければ、既にこのアプリが動いている。窓を作る前に
    // 決めるのは、2つ目が窓だけ出してサーバの無いまま立つのを防ぐため。
    const PORT: u16 = 43127;
    let Some(bound) = single::claim(PORT) else {
        single::ask_the_running_one_to_show(PORT);
        return;
    };
    if browser_window::initialize_protection().is_err() { eprintln!("browser_protection_initialization_unavailable"); }
    // Before any store is opened: move browser files to Local, run a requested wipe.
    local_data::startup();
    let state_started = std::time::Instant::now();
    let state = Arc::new(RunnerState::new_persistent().expect("valid local runner configuration"));
    let state_load_ms = state_started.elapsed().as_secs_f64() * 1000.0;
    let server_state = state.clone();
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                close_main_window(window.label(), &CLOSE_SAVE_FAILED, || api.prevent_close(),
                    || bounded_save(CLOSE_SAVE_BUDGET, browser_window::save_session_on_close),
                    || exit_with_watchdog(window.app_handle(), EXIT_WATCHDOG),
                    || { let _ = window.app_handle().emit_to("main", "hub-exit-save-failed", ()); });
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .manage(state.clone())
        .manage(personal_node_registration::RegistrationState::default())
        .manage(personal_node_reactivation::ReactivationState::default())
        // The managed services are clones of the state's fields, so Tauri
        // commands and the loopback HTTP routes share one run registry.
        .manage(state.pi_work.clone())
        .manage(Arc::new(pi_images::PiImageStore::default()))
        .setup(move |app| {
            desktop_metrics::set_native_startup(state_load_ms, native_started.elapsed().as_secs_f64() * 1000.0);
            // メイン窓は同梱アプリ（ui/index.html）そのもの。アプリ内ブラウザは
            // 外部サイト専用で、Web版Hubのページは開かない（既定ブラウザへ）。
            hub_window::remember(app.handle().clone());
            single::remember(app.handle().clone());
            browser_window::start_browser_background(&app.handle());
            // AI work records older than 90 days also go while the app stays open.
            let pruning = server_state.pi_work.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(6 * 60 * 60));
                pruning.prune_expired();
            });
            if std::env::args().any(|arg| arg == "--control-stdio") {
                desktop_control::start(app.handle().clone());
            }
            if let Some(window) = app.get_webview_window("main") {
                // 起動のたびに前面は奪わない。窓が出ていることだけ保証し、
                // どこへ出すかはOSと利用者に任せる。
                window_fit::fit_main_window(&window);
                window_fit::watch_main_window(&window);
                let _ = no_activate::show(&window);
            }
            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(bound).expect("loopback listener");
                axum::serve(listener, router(server_state))
                    .await
                    .expect("serve loopback");
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_build_mode,
            window_material::window_material,
            desktop_metrics::desktop_control_metrics_report,
            desktop_control::browser_control_select_ack,
            desktop_control::browser_control_refresh_ack,
            desktop_control::browser_probe_profile_ack,
            browser_ai_control::browser_ai_control_ack,
            p2p_pairing_request,
            research_git_bundle::research_git_bundle,
            research_git_bundle::research_git_bundle_import,
            research_git_bundle::research_git_bundle_check,
            byok::byok_list,
            byok::pi_work_connections,
            byok::byok_save,
            byok::byok_remove,
            byok::byok_set_enabled,
            byok::byok_cli_set,
            byok::byok_test,
            byok::byok_models,
            byok::byok_chat_start,
            web_search::web_search_chat,
            web_search::web_search_brave_status,
            web_search::web_search_brave_set,
            web_search::web_search_brave_clear,
            byok::byok_chat_cancel,
            byok::byok_remote_set,
            byok::byok_remote_session,
            byok::byok_remote_sources,
            byok::byok_remote_run,
            byok::byok_remote_cancel,
            byok::byok_remote_stop_all,
            byok::byok_remote_active,
            pi_work::pi_work_start,
            pi_work::pi_work_compare_start,
            pi_work::pi_work_detect_checkers,
            pi_work::pi_work_best_of_estimate,
            pi_work::pi_work_steer,
            pi_work::queue_runtime::pi_work_queue_context,
            pi_work::queue_runtime::pi_work_queue_snapshot,
            pi_work::queue_runtime::pi_work_queue_action,
            pi_work::queue_runtime::pi_work_queue_release,
            pi_work::pi_work_status,
            pi_work::pi_work_list,
            pi_work::pi_work_delete,
            pi_work::pi_work_delete_all,
            local_data::local_data_schedule_wipe,
            local_data::local_data_restart,
            local_data::wallet_delete_key,
            node_key_backup::node_key_backup_export,
            node_key_backup::node_key_backup_import,
            pi_work::pi_work_diff,
            pi_work::pi_work_cancel,
            pi_work::pi_work_decide,
            pi_work_paths,
            browser_reader_read,
            browser_reader_open,
            browser_reader_close,
            pi_work::pi_work_models,
            pi_work::pi_work_engines,
            pi_work::pi_work_image_capability,
            pi_work::pi_work_prepare_image,
            pi_work::pi_work_release_image,
            pi_work::pi_work_image_preview,
            pending_runs,
            isolation_status,
            approve_run,
            deny_run,
            pending_file_writes,
            approve_file_write,
            deny_file_write,
            pending_dev_runs,
            approve_dev_run,
            deny_dev_run,
            node_state,
            save_node_settings,
            node_startup_status,
            pi_work_open_workspace,
            sync_node_now,
            node_sync_control,
            node_public_posts,
            node_public_post_control,
            preview_public_content,
            publish_public_content,
            hub_feed,
            hub_social_stream,
            hub_post_manifest,
            hub_post_peer_control,
            hub_network_sources,
            hub_network_read,
            hub_network_audio,
            hub_peer_control,
            hub_resource,
            hub_client,
            hub_client_action,
            native_video::native_video_request,
            native_video::native_video_pick_file,
            native_video::native_video_upload,
            native_video::native_video_play,
            hub_video_metadata,
            hub_video_register,
            hub_music_metadata,
            hub_music_register,
            hub_music_report,
            hub_upload_image,
            hub_upload_dm_image,
            hub_dm_image,
            hub_detail,
            wallet_status,
            wallet_balance,
            wallet_token_balances,
            wallet_select_chain,
            wallet_set_developer,
            wallet_sign_typed_data,
            wallet_send_native,
            wallet_send_contract,
            wallet_recover_contract,
            wallet_check_approval,
            wallet_escrow_begin,
            wallet_escrow_pending,
            wallet_refund_begin,
            wallet_refund_pending,
            wallet_finish_refund,
            wallet_escrow_history,
            wallet_check_escrow_failure,
            wallet_finish_escrow,
            wallet_confirm_respond,
            commerce_catalog,
            commerce_public_product,
            commerce_fulfillment_quote,
            commerce_order_create,
            commerce_checkout_pending,
            commerce_checkout_finish,
            commerce_order_submit,
            commerce_order_status,
            commerce_order_cancel,
            commerce_order_receipt,
            commerce_escrow_prepare,
            commerce_escrow_submit,
            commerce_return_request,
            commerce_return_shipment,
            commerce_seller_state,
            commerce_seller_login,
            commerce_seller_logout,
            commerce_seller_challenge,
            commerce_seller_complete,
            commerce_seller_products,
            commerce_seller_product_save,
            commerce_seller_attribution_proof,
            commerce_seller_mark_delivered,
            commerce_seller_orders,
            commerce_seller_orders_csv,
            commerce_seller_order_detail,
            commerce_seller_ship,
            commerce_seller_return_review,
            commerce_seller_escrow,
            commerce_seller_refund_active_quote,
            commerce_seller_refund_quote,
            commerce_seller_refund_submit,
            commerce_seller_media_upload,
            commerce_seller_media,
            commerce_seller_media_delete,
            commerce_seller_analytics,
            commerce_seller_payment_exceptions,
            commerce_seller_payment_exception_resolve,
            commerce_order_payment_exception_resolve,
            commerce_seller_wallet,
            commerce_payment_chain_catalog,
            commerce_seller_chain_destinations,
            commerce_seller_chain_destination_put,
            commerce_seller_chain_destination_disable,
            wallet_sign_message,
            open_external,
            compute_status,
            compute_demo,
            compute_reserve,
            compute_submit_text,
            compute_reservation_job,
            compute_cancel_reservation,
            compute_job,
            research_pdf_client::research_pdf_upload,
            research_pdf_client::research_pdf_download,
            research_change_save,
            research_public_export_read,
            research_public_export_save,
            personal_node_registration::personal_node_registration_prepare,
            personal_node_registration::personal_node_registration_complete,
            personal_node_reactivation::personal_node_reactivation_prepare,
            personal_node_reactivation::personal_node_reactivation_complete,
            music_tracks,
            music_audio,
            media_audio,
            media_p2p_settings_get,
            media_p2p_settings_set,
            media_cache_clear,
            media_cache_usage,
            media_cache_maintain,
            portable_identity::portable_identity_public,
            portable_identity::portable_identity_sign_registration,
            portable_identity::portable_identity_sign_move,
            music_artwork,
            music_own_attribution_candidates,
            music_attribution_proof,
            mail_mailbox,
            mail_mailbox_create,
            mail_messages,
            mail_message,
            mail_message_action,
            mail_compose_preview,
            mail_compose_send,
            mail_reply_preview,
            mail_reply_send,
            mail_send_status,
            mail_attachment_download,
            mail_drafts,
            mail_draft_save,
            mail_draft_delete,
            ai_catalog,
            ai_call,
            ai_pay_and_call,
            ai_video_status,
            ai_video_content,
            desktop_account_status,
            begin_desktop_account,
            poll_desktop_account,
            logout_desktop_account,
            desktop_agent_usage,
            return_to_hub,
            open_harness_window,
            hub_origin,
            browser_window::browser_enter,
            browser_window::browser_exit,
            browser_window::browser_layout,
            browser_window::rail_browser_layout,
            browser_window::rail_browser_open,
            browser_window::rail_browser_back,
            browser_window::rail_browser_forward,
            browser_window::rail_browser_reload,
            browser_window::rail_browser_stop,
            browser_window::rail_browser_pause_media,
            browser_window::rail_browser_scheme,
            browser_window::rail_browser_state,
            browser_window::browser_tab_overlay,
            browser_window::browser_page_holes,
            browser_window::browser_mini_overlay,
            browser_window::browser_navigate,
            browser_window::browser_navigate_from_address,
            browser_window::browser_back,
            browser_window::browser_forward,
            browser_window::browser_reload,
            browser_window::browser_tabs,
            browser_window::browser_workspace_snapshot,
            browser_window::browser_set_muted,
            browser_window::browser_show_print,
            browser_window::browser_new_tab,
            browser_window::browser_open_tab,
            browser_window::browser_new_private_tab,
            browser_window::browser_set_tab_group,
            browser_window::browser_clear_history,
            browser_window::browser_clear_site_data,
            browser_window::browser_close_tab,
            browser_window::browser_close_other_tabs,
            browser_window::browser_close_tabs_to_right,
            browser_window::browser_activate_tab,
            browser_window::browser_history,
            browser_window::browser_newtab_stats,
            browser_protection_status,
            browser_set_protection,
            browser_autoplay_status,
            browser_set_autoplay,
            browser_window::browser_favorites,
            browser_window::browser_add_favorite,
            browser_window::browser_remove_favorite,
            browser_window::browser_update_favorite,
            browser_window::browser_move_favorite,
            browser_window::browser_import_favorites,
            browser_window::browser_export_favorites,
            browser_window::browser_send_to_ai,
            browser_window::browser_pin_tab,
            browser_window::browser_move_tab,
            browser_window::browser_duplicate_tab,
            browser_window::browser_sleep_tab,
            browser_window::browser_sleep_background_tabs,
            browser_window::browser_restore_tab,
            browser_window::browser_zoom,
            browser_window::browser_find,
            browser_window::browser_stop,
            browser_window::browser_hard_reload,
            browser_window::browser_focus_controls,
            native_browser_tabs::native_browser_chrome_layout,
            browser_window::browser_focus_address,
            native_shell_resize::native_shell_resize_sync,
            native_sidebar::native_sidebar_sync,
            native_sidebar::native_sidebar_reset,
            shell_control::shell_control_ack,
            browser_window::browser_session_status,
            browser_window::browser_restore_session,
            browser_window::browser_site_requests,
            browser_window::browser_downloads,
            browser_window::browser_download_history,
            browser_window::browser_download_history_close,
            browser_window::browser_permission_reply,
            browser_window::browser_site_permissions,
            browser_window::browser_forget_site_permission,
            browser_window::browser_delete_history_entry,
            browser_window::browser_clear_browsing_data,
            browser_window::browser_open_download,
            browser_window::browser_toggle_fullscreen,
            browser_window::browser_save_download,
            browser_window::browser_cancel_download,
            browser_window::browser_pause_download,
            browser_window::browser_resume_download,
            browser_window::browser_reveal_download,

            games,
            pick_game_executable,
            rename_game,
            remove_game,
            launch_game,
            dev_agents,
            dev_history,
            dev_workspace,
            set_dev_workspace,
            clear_dev_workspace,
            start_dev_run,
            dev_active_run,
            pick_dev_workspace,
            dev_run,
            cancel_dev_run,
            revert_dev_run
        ])
        .run(tauri::generate_context!())
        .expect("run desktop");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::IntoFuture;

    #[test]
    fn wallet_refund_quote_binding_refuses_stale_payment_parameters() {
        let id = "11111111-1111-4111-8111-111111111111";
        let phase = format!("refund:{id}");
        let to = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let quote = serde_json::json!({"refundQuote":{"id":id,"orderId":"order_1","expiresAt":"2999-01-01T00:00:00.000Z","sellerAddress":to,"sellerTransfer":{"chainId":1,"to":to,"value":"0x64","data":"0x"}}});
        assert!(refund_transfer_matches(&quote, "order_1", &phase, 1, to, 100, "0x"));
        assert!(!refund_transfer_matches(&quote, "order_2", &phase, 1, to, 100, "0x"));
        assert!(!refund_transfer_matches(&quote, "order_1", "refund:22222222-2222-4222-8222-222222222222", 1, to, 100, "0x"));
        assert!(!refund_transfer_matches(&quote, "order_1", &phase, 2, to, 100, "0x"));
        assert!(!refund_transfer_matches(&quote, "order_1", &phase, 1, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 100, "0x"));
        assert!(!refund_transfer_matches(&quote, "order_1", &phase, 1, to, 99, "0x"));
        assert!(!refund_transfer_matches(&quote, "order_1", &phase, 1, to, 100, "0x00"));
        for value in [serde_json::json!(null),serde_json::json!(100),serde_json::json!("100"),serde_json::json!("0x064")] {
            let mut wrong=quote.clone(); wrong["refundQuote"]["sellerTransfer"]["value"]=value;
            assert!(!refund_transfer_matches(&wrong, "order_1", &phase, 1, to, 100, "0x"));
        }
        for value in [serde_json::json!(null),serde_json::json!("2000-01-01T00:00:00Z"),serde_json::json!("not a date")] {
            let mut wrong=quote.clone();wrong["refundQuote"]["expiresAt"]=value;
            assert!(!refund_transfer_matches(&wrong, "order_1", &phase, 1, to, 100, "0x"));
        }
        assert!(!refund_transfer_matches(&serde_json::json!({"refundQuote":null}), "order_1", &phase, 1, to, 100, "0x"));
    }

    #[test]
    fn wallet_contract_value_preserves_helper_quantities() {
        for (text, expected) in [("0x0", 0), ("0x64", 100), ("0xF", 15), ("0xffffffffffffffffffffffffffffffff", u128::MAX)] {
            assert_eq!(wallet_contract_value(text), Ok(expected));
        }
    }

    #[test]
    fn wallet_contract_value_rejects_ambiguous_or_oversized_input() {
        for text in ["", "100", " 0x64", "0x64 ", "0X64", "0x", "0x00", "0x064", "0x+1", "0x-1", "0x６４", "0x100000000000000000000000000000000"] {
            assert_eq!(wallet_contract_value(text), Err("wallet_params_invalid".into()));
        }
    }

    fn http_router_source(source: &str) -> &str {
        let start = source.find("pub fn router(").expect("router start");
        let router = &source[start..];
        let end = router.find("\nasync fn health").expect("router end");
        &router[..end]
    }

    #[test]
    fn pairing_accepts_only_the_bundled_main_page() {
        for address in ["tauri://localhost/index.html", "http://tauri.localhost/", "https://tauri.localhost/index.html"] {
            let url = tauri::Url::parse(address).unwrap();
            assert!(local_pairing_address("main", &url));
            for label in ["harness", "browser", "games", "external"] { assert!(!local_pairing_address(label, &url)); }
        }
        for address in ["https://hub.jkamma.com/", "http://tauri.localhost/other", "http://tauri.localhost/index.html?tool=harness", "http://tauri.localhost/#pair=x", "http://user@tauri.localhost/", "http://tauri.localhost:1431/"] {
            assert!(!local_pairing_address("main", &tauri::Url::parse(address).unwrap()));
        }
        assert_eq!(local_pairing_address("main", &tauri::Url::parse("http://localhost:1430/").unwrap()), cfg!(debug_assertions));
    }

    #[test]
    fn only_the_bundled_harness_window_is_native() {
        assert!(local_address(
            "harness",
            "http",
            "tauri.localhost",
            "/index.html"
        ));
        assert!(!local_address(
            "main",
            "http",
            "tauri.localhost",
            "/index.html"
        ));
        assert!(!local_address(
            "harness",
            "https",
            "hub.jkamma.com",
            "/index.html"
        ));
        assert!(!local_address(
            "harness",
            "http",
            "localhost",
            "/index.html"
        ));
    }

    #[test]
    fn pi_work_accepts_only_bundled_main_or_harness_pages() {
        for label in ["main", "harness"] {
            assert!(local_pi_address(label, "http", "tauri.localhost", None, "/index.html"));
            assert!(local_pi_address(label, "tauri", "localhost", None, "/index.html"));
            assert!(!local_pi_address(label, "https", "hub.jkamma.com", None, "/index.html"));
            assert!(!local_pi_address(label, "http", "tauri.localhost", None, "/other"));
        }
        assert!(local_pi_address("main", "http", "tauri.localhost", None, "/"));
        assert!(!local_pi_address("harness", "http", "tauri.localhost", None, "/"));
        assert!(!local_pi_address("browser", "http", "tauri.localhost", None, "/index.html"));
        if cfg!(debug_assertions) {
            assert!(local_pi_address("main", "http", "127.0.0.1", Some(1430), "/"));
            assert!(!local_pi_address("main", "http", "127.0.0.1", Some(1431), "/"));
            assert!(!local_pi_address("main", "https", "127.0.0.1", Some(1430), "/"));
            assert!(!local_pi_address("browser", "http", "127.0.0.1", Some(1430), "/"));
        }
    }

    #[tokio::test]
    async fn sessions_require_an_allowlisted_origin() {
        let state = RunnerState::new().unwrap();
        assert!(state
            .issue_session(&HeaderValue::from_static("https://evil.example"))
            .await
            .is_err());
        assert!(state
            .issue_session(&HeaderValue::from_static("http://localhost:3020"))
            .await
            .is_ok());
    }
    #[tokio::test]
    async fn cli_relay_requires_a_paired_session() {
        // The CLI routes reach the operator's own subscriptions, so an unpaired
        // or forged token must be refused before local_cli::run is ever called.
        let state = RunnerState::new().unwrap();
        assert!(state.require_session("").await.is_err());
        assert!(state.require_session("not-a-real-token").await.is_err());
        let token = state
            .issue_session(&HeaderValue::from_static("http://localhost:3020"))
            .await
            .unwrap();
        assert!(state.require_session(&token).await.is_ok());
    }
    #[tokio::test]
    async fn hub_browser_can_read_the_progress_version_header() {
        let state = Arc::new(RunnerState::new().unwrap());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(axum::serve(listener, router(state)).into_future());
        let client = reqwest::Client::new();
        for origin in ["http://localhost:3020", "http://127.0.0.1:3020"] {
            let response = client.get(format!("http://{address}/health"))
                .header(header::ORIGIN, origin).send().await.unwrap();
            assert_eq!(response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(), origin);
            assert_eq!(response.headers().get(header::ACCESS_CONTROL_EXPOSE_HEADERS)
                .and_then(|value| value.to_str().ok()), Some("x-run-version"),
                "the browser must retain the version rather than repeatedly requesting since=0");
        }
        let denied = client.get(format!("http://{address}/health"))
            .header(header::ORIGIN, "https://evil.example").send().await.unwrap();
        assert!(denied.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
        server.abort();
    }
    #[test]
    fn cli_errors_separate_the_caller_from_the_upstream() {
        // Observed end to end: a rejected agent name came back as 502, which
        // reads as "the CLI broke" when nothing had been run at all.
        assert_eq!(cli_status("unknown agent"), StatusCode::BAD_REQUEST);
        assert_eq!(cli_status("invalid prompt"), StatusCode::BAD_REQUEST);
        // A forged resume handle is the caller's mistake, and came back as 502
        // until this arm existed.
        assert_eq!(cli_status("invalid session"), StatusCode::BAD_REQUEST);
        // Asking an agent that has no resume flags to continue is the caller's
        // mistake too, and came back as 502 until this arm existed.
        assert_eq!(cli_status("agent cannot resume"), StatusCode::BAD_REQUEST);
        assert_eq!(
            cli_status("claude not installed"),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(cli_status("timed out"), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(cli_status("usage timed out"), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(cli_status("run already in progress"), StatusCode::CONFLICT);
        assert_eq!(
            cli_status("agent returned nothing"),
            StatusCode::BAD_GATEWAY
        );
    }
    #[tokio::test]
    async fn approval_discards_source_before_execution() {
        let state = RunnerState::new().unwrap();
        let token = state
            .issue_session(&HeaderValue::from_static("http://localhost:3020"))
            .await
            .unwrap();
        state.inner.lock().await.jobs.insert(
            "a".into(),
            Job {
                owner: token,
                language: "python".into(),
                code: "never retain".into(),
                workspace: "x".into(),
                timeout_ms: 1,
                status: JobStatus::PendingApproval,
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                files: Vec::new(),
                created: Instant::now(),
            },
        );
        state.approve_from_desktop("a").await.unwrap();
        assert!(state.inner.lock().await.jobs["a"].code.is_empty());
    }
    /// 承認は、ペアリング済みセッションにだけ届く。
    ///
    /// ハブ自身がハーネス面になったので、押す口はHTTPに出る。出てよいのは
    /// 「allowlist 済みの origin が発行した生きたトークンを持つ呼び出し」
    /// だけで、ルートとハンドラの両方が `require_session` を通ることを
    /// ここで固定する。一覧（/pending）は引き続き見えるだけ。
    #[test]
    fn approvals_require_a_paired_session() {
        let source = include_str!("lib.rs");
        let router = http_router_source(source);
        for route in [
            "\"/dev/runs/:id/approve\"",
            "\"/dev/runs/:id/deny\"",
            "\"/pi-work/runs\"",
            "\"/pi-work/models\"",
            "\"/pi-work/runs/:id\"",
            "\"/pi-work/runs/:id/decide\"",
            "\"/pi-work/runs/:id/cancel\"",
            "\"/runs/:id/approve\"",
            "\"/runs/:id/deny\"",
            "\"/files/write/:id/approve\"",
            "\"/files/write/:id/deny\"",
        ] {
            assert!(router.contains(route), "{route} がHTTPに無い");
        }
        for handler in [
            "http_approve_dev_run",
            "http_deny_dev_run",
            "http_pi_work_list",
            "http_pi_work_models",
            "http_pi_work_start",
            "http_pi_work_status",
            "http_pi_work_decide",
            "http_pi_work_cancel",
            "http_approve_run",
            "http_deny_run",
            "http_approve_file_write",
            "http_deny_file_write",
        ] {
            let body = source
                .split(&format!("async fn {handler}"))
                .nth(1)
                .unwrap_or_else(|| panic!("{handler} が見つからない"))
                .split("async fn ")
                .next()
                .unwrap_or_default();
            assert!(
                body.contains("require_session"),
                "{handler} が require_session を通らない"
            );
        }
        assert!(router.contains("\"/pending\""));
        assert!(router.contains("\"/local-window/show\""));
    }

    /// The boundary end to end: no token answers 401 everywhere; a live
    /// session reaches the service, which then fails closed on unknown ids.
    #[tokio::test]
    async fn work_routes_require_pairing_then_fail_closed() {
        // dev_cli::workspace() reads the machine's stored choice; point APPDATA
        // at an empty directory so this test answers for "not configured" and
        // cannot start a real run against the operator's workspace. The env is
        // process-global: serialise with the other tests that redirect it.
        let _env = crate::local_cli::ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let previous_appdata = std::env::var_os("APPDATA");
        let isolated = std::env::temp_dir().join(format!(
            "hub-http-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&isolated).unwrap();
        std::env::set_var("APPDATA", &isolated);
        let state = Arc::new(RunnerState::new().unwrap());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(axum::serve(listener, router(state.clone())).into_future());
        let client = reqwest::Client::new();
        let url = |path: &str| format!("http://127.0.0.1:{port}{path}");
        for path in [
            "/pi-work/runs",
            "/pi-work/models",
            "/dev/harnesses/codex/auth",
            "/pi-work/runs/x",
            "/pending",
        ] {
            let response = client.get(url(path)).send().await.unwrap();
            assert_eq!(response.status().as_u16(), 401, "GET {path}");
        }
        for (path, body) in [
            ("/pi-work/runs", serde_json::json!({"prompt":"x"})),
            ("/pi-work/runs/x/decide", serde_json::json!({"actionId":"a","approve":true})),
            ("/pi-work/runs/x/cancel", serde_json::json!({})),
            ("/dev/runs/x/approve", serde_json::json!({})),
            ("/dev/runs/x/deny", serde_json::json!({})),
            ("/dev/runs/x/verification", serde_json::json!({"actionId":"a","approve":true})),
            ("/runs/x/approve", serde_json::json!({})),
            ("/runs/x/deny", serde_json::json!({})),
            ("/files/write/x/approve", serde_json::json!({})),
            ("/files/write/x/deny", serde_json::json!({})),
        ] {
            let response = client.post(url(path)).json(&body).send().await.unwrap();
            assert_eq!(response.status().as_u16(), 401, "POST {path}");
        }
        let token = state
            .issue_session(&HeaderValue::from_static("http://localhost:3020"))
            .await
            .unwrap();
        let listed = client
            .get(url("/pi-work/runs"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(listed.status().as_u16(), 200);
        let unknown_auth = client
            .get(url("/dev/harnesses/not-a-configured-agent/auth"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(unknown_auth.status().as_u16(), 404);
        // The picker endpoint always answers: a missing registry is an empty
        // list, and `default` is the model a bare start would run.
        let models = client
            .get(url("/pi-work/models"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(models.status().as_u16(), 200);
        let body: serde_json::Value = models.json().await.unwrap();
        assert!(body["models"].is_array(), "{body}");
        assert!(body["default"].as_str().is_some_and(|s| !s.is_empty()), "{body}");
        // Decision routes reach the service and fail closed on unknown ids.
        let decide = client
            .post(url("/pi-work/runs/nope/decide"))
            .bearer_auth(&token)
            .json(&serde_json::json!({"actionId":"nope","approve":true}))
            .send()
            .await
            .unwrap();
        assert_eq!(decide.status().as_u16(), 404);
        let job_approve = client
            .post(url("/runs/nope/approve"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(job_approve.status().as_u16(), 409);
        // Dev approval keeps the client-owner partition: no client id, no run.
        let dev_no_owner = client
            .post(url("/dev/runs/nope/approve"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(dev_no_owner.status().as_u16(), 400);
        let dev_unknown = client
            .post(url("/dev/runs/nope/approve"))
            .bearer_auth(&token)
            .header("x-hub-client-id", uuid::Uuid::new_v4().to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(dev_unknown.status().as_u16(), 404);
        for (owner, expected) in [(None,400), (Some(uuid::Uuid::new_v4().to_string()),404)] {
            let mut request = client.post(url("/dev/runs/nope/verification")).bearer_auth(&token)
                .json(&serde_json::json!({"actionId":"fresh-action","approve":true}));
            if let Some(owner) = owner { request = request.header("x-hub-client-id",owner); }
            assert_eq!(request.send().await.unwrap().status().as_u16(),expected);
        }
        // Starts fail closed without the machine-configured workspace, not
        // with any caller-supplied path or script — those fields are rejected
        // outright rather than honoured.
        let rejected = client
            .post(url("/pi-work/runs"))
            .bearer_auth(&token)
            .json(&serde_json::json!({"prompt":"hi","workspace":"C:/evil","script":"x.mjs"}))
            .send()
            .await
            .unwrap();
        assert_eq!(rejected.status().as_u16(), 422);
        let pi_start = client
            .post(url("/pi-work/runs"))
            .bearer_auth(&token)
            .json(&serde_json::json!({"prompt":"hi"}))
            .send()
            .await
            .unwrap();
        assert_eq!(pi_start.status().as_u16(), 503);
        if let Some(value) = previous_appdata {
            std::env::set_var("APPDATA", value);
        } else {
            std::env::remove_var("APPDATA");
        }
        let _ = std::fs::remove_dir_all(&isolated);
    }

    #[test]
    fn game_launch_is_not_reachable_over_http() {
        let routes = include_str!("lib.rs");
        let router = http_router_source(routes);
        for forbidden in ["launch_game", "remove_game", "pick_game_executable"] {
            assert!(
                !router.contains(forbidden),
                "ゲーム操作はデスクトップ窓だけ"
            );
        }
        assert!(
            router.contains("\"/game-window/show\""),
            "購入済みからランチャーを前に出せること"
        );
    }

    #[test]
    fn only_the_native_work_window_can_return_to_hub() {
        let source = include_str!("lib.rs");
        let command = source
            .split("fn return_to_hub")
            .nth(1)
            .expect("return command")
            .split("/// ゲーム一覧")
            .next()
            .expect("return command body");
        assert!(command.contains("window.label() != \"harness\""));
        assert!(command.contains("native(window.as_ref())"));
        assert!(command.contains("hub_window::return_to_hub(&app, &window)"));
        let setup = source
            .split(".setup(move |app| {")
            .nth(1)
            .expect("setup")
            .split("tauri::async_runtime::spawn")
            .next()
            .expect("setup body");
        // 起動で前面は奪わない。奪ってよいのは「Hubへ戻る」の明示操作だけ。
        assert!(!setup.contains("set_focus"), "起動時に窓の焦点を奪わないこと");
        assert!(!setup.contains("hub_window::show_local"));
        assert!(source.contains("            return_to_hub,"));
    }

    #[test]
    fn artifact_storage_routes_are_pairing_gated_and_separate_from_publish() {
        let source = include_str!("lib.rs");
        let router = http_router_source(source);
        for route in [
            "\"/node/artifacts/begin\"",
            "\"/node/artifacts/:artifact_id/chunks/:index\"",
            "\"/node/artifacts/:upload_id/finalize\"",
            "\"/node/artifacts/:digest/manifest\"",
        ] {
            assert!(router.contains(route), "artifact route {route}");
        }
        for handler in [
            "http_begin_artifact_upload",
            "http_put_artifact_chunk",
            "http_finalize_artifact_upload",
            "http_artifact_manifest",
            "http_artifact_chunk",
        ] {
            let body = source
                .split(&format!("async fn {handler}"))
                .nth(1)
                .expect("artifact handler")
                .split("async fn ")
                .next()
                .unwrap_or_default();
            assert!(
                body.contains("require_session"),
                "{handler} must require pairing"
            );
        }
        let finalize = source
            .split("async fn http_finalize_artifact_upload")
            .nth(1)
            .unwrap_or_default()
            .split("async fn ")
            .next()
            .unwrap_or_default();
        assert!(!finalize.contains("publish_public_content"));
    }

    #[test]
    fn peer_control_is_paired_but_signed_transport_and_published_blobs_are_public() {
        let source = include_str!("lib.rs");
        for handler in [
            "http_list_peers",
            "http_peer_inbox_list",
            "http_decrypt_peer_content",
            "http_preview_peer",
            "http_confirm_peer",
            "http_deliver_peer_event",
        ] {
            let body = source
                .split(&format!("async fn {handler}"))
                .nth(1)
                .expect("peer control handler")
                .split("async fn ")
                .next()
                .unwrap_or_default();
            assert!(
                body.contains("require_session"),
                "{handler} must require pairing"
            );
        }
        let public_inbox = source
            .split("async fn http_peer_inbox(")
            .nth(1)
            .unwrap()
            .split("async fn ")
            .next()
            .unwrap_or_default();
        assert!(!public_inbox.contains("require_session"));
        assert!(
            public_inbox.contains("receive_peer_delivery"),
            "signed delivery is the authorization"
        );

        let public_manifest = source
            .split("async fn http_peer_blob_manifest")
            .nth(1)
            .unwrap()
            .split("async fn ")
            .next()
            .unwrap_or_default();
        let public_chunk = source
            .split("async fn http_peer_blob_chunk")
            .nth(1)
            .unwrap()
            .split("async fn ")
            .next()
            .unwrap_or_default();
        assert!(public_manifest.contains("published_artifact_manifest"));
        assert!(public_chunk.contains("published_artifact_chunk"));
    }

    #[test]
    fn agent_usage_is_read_only_and_pairing_gated() {
        let routes = include_str!("lib.rs");
        let router = http_router_source(routes);
        assert!(router.contains("\"/dev/usage/:agent\""));
        assert!(router.contains("get(http_dev_usage)"));
        let handler = routes
            .split("async fn http_dev_usage")
            .nth(1)
            .expect("usage handler");
        assert!(handler.contains("require_session"));
        assert!(
            !handler.contains("account/rateLimitResetCredit/consume"),
            "表示から利用枠を変更しないこと"
        );
    }

    /// 何でも署名できる口を開けない。
    ///
    /// 中身は相手が決める不透明な文字列なので、意味は見られない。見られない
    /// からこそ形で絞る。開けたままだと、この鍵が別の意味を持つ文書に
    /// 署名させられうる。
    #[test]
    fn it_refuses_to_sign_things_that_are_not_challenges() {
        assert!(is_a_challenge("aBc123-_.:aBc123-_.:"));
        assert!(is_a_challenge(&"a".repeat(512)));

        assert!(!is_a_challenge(""), "空");
        assert!(!is_a_challenge("short"), "短すぎるもの");
        assert!(!is_a_challenge(&"a".repeat(513)), "長すぎるもの");
        // 別の意味を持ちうる形は通さない。
        assert!(!is_a_challenge(
            "{\"type\":\"Delete\",\"actor\":\"https://x\"}"
        ));
        assert!(!is_a_challenge("GET /inbox HTTP/1.1 host: example.com"));
        assert!(!is_a_challenge("challenge with spaces here"));
        assert!(!is_a_challenge("日本語の文章でも通らないこと"));
    }
}

#[tauri::command]
fn browser_protection_status(window: tauri::Webview) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    if !local_pairing_address(window.label(), &window.url().map_err(|_| "native_window_required")?) { return Err("native_window_required".into()); }
    browser_window::protection_status()
}
#[tauri::command]
fn browser_set_protection(window: tauri::Webview, enabled: bool) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    if !local_pairing_address(window.label(), &window.url().map_err(|_| "native_window_required")?) { return Err("native_window_required".into()); }
    browser_window::set_protection(enabled)
}
#[tauri::command]
fn browser_autoplay_status(window: tauri::Webview) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    if !local_pairing_address(window.label(), &window.url().map_err(|_| "native_window_required")?) { return Err("native_window_required".into()); }
    browser_window::autoplay_status()
}
/// `block` turns waiting-for-interaction on or off; `site` with `allowed` adds or removes one allowed site.
#[tauri::command]
fn browser_set_autoplay(app: tauri::AppHandle, window: tauri::Webview, block: Option<bool>, site: Option<String>, allowed: Option<bool>) -> Result<serde_json::Value, String> {
    native_pi(&window)?;
    if !local_pairing_address(window.label(), &window.url().map_err(|_| "native_window_required")?) { return Err("native_window_required".into()); }
    let site = match (site, allowed) { (Some(site), Some(allowed)) => Some((site, allowed)), (None, None) => None, _ => return Err("browser_autoplay_site_invalid".into()) };
    if block.is_none() && site.is_none() { return Err("browser_autoplay_site_invalid".into()); }
    browser_window::set_autoplay(&app, block, site)
}

#[cfg(test)]
mod main_window_close_tests {
    use super::*;
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, Ordering};
    #[test]
    fn second_close_request_exits_after_a_failed_save() {
        let flag=AtomicBool::new(false);
        let calls=RefCell::new(Vec::new());
        for _ in 0..2 {
            close_main_window("main",&flag,|| calls.borrow_mut().push("prevent"),|| Err("session_write_failed".into()),|| calls.borrow_mut().push("exit"),|| calls.borrow_mut().push("failed"));
        }
        assert_eq!(*calls.borrow(),["prevent","failed","prevent","exit"]);
        assert!(flag.load(Ordering::SeqCst));
    }
    #[test]
    fn stuck_save_is_bounded_and_reported_as_failure() {
        let started=std::time::Instant::now();
        let result=bounded_save(Duration::from_millis(100),|| { std::thread::sleep(Duration::from_secs(5)); Ok(()) });
        assert_eq!(result,Err("session_save_timed_out".to_string()));
        assert!(started.elapsed()<Duration::from_secs(2));
        assert_eq!(bounded_save(Duration::from_secs(2),|| Ok(())),Ok(()));
    }
    #[test]
    fn main_close_prevents_window_destruction_until_save_then_requests_application_exit() {
        let calls=RefCell::new(Vec::new());
        close_main_window("main",&AtomicBool::new(false),|| calls.borrow_mut().push("prevent"),|| {calls.borrow_mut().push("save");Ok(())},|| calls.borrow_mut().push("exit"),|| calls.borrow_mut().push("failed"));
        assert_eq!(*calls.borrow(),["prevent","save","exit"]);
    }
    #[test]
    fn failed_persistence_keeps_the_application_open_and_emits_only_the_failure_signal() {
        for error in ["session_unavailable","session_write_failed"] {
            let calls=RefCell::new(Vec::new());
            close_main_window("main",&AtomicBool::new(false),|| calls.borrow_mut().push("prevent"),|| {calls.borrow_mut().push("save");Err(error.into())},|| calls.borrow_mut().push("exit"),|| calls.borrow_mut().push("failed"));
            assert_eq!(*calls.borrow(),["prevent","save","failed"]);
        }
    }
    #[test]
    fn auxiliary_window_closure_neither_persists_nor_exits_the_application() {
        for label in ["harness","games","browser-tab-1",""] {
            close_main_window(label,&AtomicBool::new(false),|| panic!("Auxiliary close must not be prevented"),|| panic!("Auxiliary close must not save"),|| panic!("Auxiliary close must not exit"),|| panic!("Auxiliary close must not report persistence failure"));
        }
    }
}

/// Remove jobs older than `ttl` and return their ids, so their checkpoints can go too.
fn take_expired_ai_jobs(jobs: &mut HashMap<String, LocalAiJob>, ttl: Duration) -> Vec<String> {
    let expired: Vec<String> = jobs
        .iter()
        .filter(|(_, job)| job.created.elapsed() >= ttl)
        .map(|(id, _)| id.clone())
        .collect();
    jobs.retain(|id, _| !expired.contains(id));
    expired
}

#[cfg(test)]
mod ai_job_retention_tests {
    use super::*;
    fn job(age: Duration) -> LocalAiJob {
        LocalAiJob {
            owner: String::new(),
            status: LocalAiJobStatus::Completed,
            output: None,
            error: None,
            created: Instant::now().checked_sub(age).unwrap(),
            abort: None,
        }
    }
    #[test]
    fn expired_jobs_are_removed_and_reported() {
        let mut jobs = HashMap::new();
        jobs.insert("old".to_owned(), job(JOB_TTL + Duration::from_secs(1)));
        jobs.insert("new".to_owned(), job(Duration::from_secs(1)));
        assert_eq!(take_expired_ai_jobs(&mut jobs, JOB_TTL), vec!["old".to_owned()]);
        assert_eq!(jobs.keys().collect::<Vec<_>>(), vec!["new"]);
        assert!(take_expired_ai_jobs(&mut jobs, JOB_TTL).is_empty());
    }
}
