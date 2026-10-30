use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    task::JoinHandle,
    time::timeout,
};

const MAX_OUTPUT_BYTES: u64 = 1_048_576;
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_FILES: usize = 20;
const DOCKER_CLI_TIMEOUT: Duration = Duration::from_secs(5);

pub struct GeneratedFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

pub struct ExecutionOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub files: Vec<GeneratedFile>,
}

pub async fn isolation_available() -> bool {
    docker_server_ready().await
        && configured_image("python").is_some()
        && configured_image("javascript").is_some()
}

pub async fn execute(
    job_id: &str,
    language: &str,
    code: String,
    workspace: &Path,
    timeout_ms: u64,
) -> Result<ExecutionOutput, String> {
    if !docker_server_ready().await {
        return Err("docker_unavailable".into());
    }
    let image = configured_image(language).ok_or_else(|| "pinned_image_unavailable".to_string())?;
    if !image_exists(&image).await {
        return Err("pinned_image_unavailable".into());
    }

    let interpreter = match language {
        "python" => vec!["python", "-I", "-B", "-"],
        "javascript" => vec!["node", "-"],
        _ => return Err("unsupported_language".into()),
    };
    let mount = format!("{}:/workspace:ro", workspace.display());
    let job = job_id.to_owned();
    let output_root = blocking("output_directory_failed", move || {
        prepare_output_directory(&job)
    })
    .await?;
    let output_mount = format!("{}:/output:rw", output_root.display());
    let mut command = crate::local_cli::quiet_command("docker");
    let container_name = container_name(job_id);
    command
        .args([
            "run",
            "--name",
            &container_name,
            "--interactive",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "64",
            "--memory",
            "512m",
            "--cpus",
            "1",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,size=64m",
            "--volume",
            &output_mount,
            "--volume",
            &mount,
            "--workdir",
            "/workspace",
            &image,
        ])
        .args(interpreter)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            blocking("output_cleanup_failed", move || cleanup_output(&output_root)).await?;
            return Err("docker_spawn_failed".into());
        }
    };
    let (stdin, stdout, stderr) =
        match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
            (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
            _ => {
                let _ = timeout(DOCKER_CLI_TIMEOUT, child.kill()).await;
                drop(child);
                let cleanup = remove_container(&container_name).await;
                let output =
                    blocking("output_cleanup_failed", move || cleanup_output(&output_root)).await;
                return Err(cleanup
                    .err()
                    .or(output.err())
                    .unwrap_or_else(|| "stdin_unavailable".into()));
            }
        };
    let finished = Arc::new(AtomicBool::new(false));
    let monitor_finished = finished.clone();
    let monitor_root = output_root.clone();
    let monitor_container = container_name.clone();
    let output_monitor = tokio::spawn(async move {
        while !monitor_finished.load(Ordering::Relaxed) {
            let root = monitor_root.clone();
            let within = tokio::task::spawn_blocking(move || {
                output_directory_within_limits(&root)
            })
            .await
            .map_err(|_| "monitor_failed".to_string())?;
            if !within {
                remove_container(&monitor_container).await?;
                return Ok(true);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok(false)
    });
    let stdout_task = tokio::spawn(read_bounded(stdout));
    let stderr_task = tokio::spawn(read_bounded(stderr));
    let deadline = Duration::from_millis(timeout_ms);
    let execution = timeout(deadline, async move {
        let mut stdin = stdin;
        stdin
            .write_all(code.as_bytes())
            .await
            .map_err(|_| "stdin_failed".to_string())?;
        drop(stdin);
        child
            .wait()
            .await
            .map_err(|_| "docker_wait_failed".to_string())
    })
    .await;
    let (exit_code, timed_out, execution_error) = match execution {
        Ok(Ok(status)) => (status.code(), false, None),
        Ok(Err(error)) => (None, false, Some(error)),
        Err(_) => (None, true, None),
    };
    finished.store(true, Ordering::Relaxed);
    let mut output_monitor = output_monitor;
    let monitor = join_task(&mut output_monitor, "monitor_failed").await;
    let output_limit_exceeded = monitor.as_ref().is_ok_and(|limited| *limited);
    let container_cleanup = if output_limit_exceeded {
        Ok(())
    } else {
        remove_container(&container_name).await
    };
    let files = {
        let root = output_root.clone();
        blocking("output_read_failed", move || read_generated_files(&root))
            .await
            .unwrap_or_default()
    };
    let output_cleanup =
        blocking("output_cleanup_failed", move || cleanup_output(&output_root)).await;
    let mut stdout_task = stdout_task;
    let mut stderr_task = stderr_task;
    let stdout = join_task(&mut stdout_task, "stdout_failed").await;
    let stderr = join_task(&mut stderr_task, "stderr_failed").await;
    monitor?;
    container_cleanup?;
    output_cleanup?;
    let stdout = stdout?;
    let mut stderr = stderr?;
    if let Some(error) = execution_error {
        return Err(error);
    }
    if timed_out {
        stderr.push_str(if stderr.is_empty() {
            "Execution timed out."
        } else {
            "\nExecution timed out."
        });
    }
    if output_limit_exceeded {
        stderr.push_str(if stderr.is_empty() {
            "Generated file limit exceeded."
        } else {
            "\nGenerated file limit exceeded."
        });
    }
    Ok(ExecutionOutput {
        stdout,
        stderr,
        exit_code,
        timed_out: timed_out || output_limit_exceeded,
        files,
    })
}

pub async fn cancel(job_id: &str) {
    let _ = remove_container(&container_name(job_id)).await;
}

fn container_name(job_id: &str) -> String {
    let safe: String = job_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(64)
        .collect();
    format!("hub-local-runner-{safe}")
}

async fn remove_container(name: &str) -> Result<(), String> {
    if docker_status(&["rm", "--force", name]).await? {
        Ok(())
    } else {
        Err("container_cleanup_failed".into())
    }
}

fn cleanup_output(root: &Path) -> Result<(), String> {
    fs::remove_dir_all(root).map_err(|_| "output_cleanup_failed".into())
}

async fn docker_status(arguments: &[&str]) -> Result<bool, String> {
    let mut command = crate::local_cli::quiet_command("docker");
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| "docker_cli_failed".to_string())?;
    match timeout(DOCKER_CLI_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => Ok(status.success()),
        Ok(Err(_)) => Err("docker_cli_failed".into()),
        Err(_) => {
            drop(child);
            Err("docker_cli_timeout".into())
        }
    }
}

async fn join_task<T>(
    task: &mut JoinHandle<Result<T, String>>,
    failure: &str,
) -> Result<T, String> {
    join_task_with_timeout(task, failure, DOCKER_CLI_TIMEOUT).await
}

async fn join_task_with_timeout<T>(
    task: &mut JoinHandle<Result<T, String>>,
    failure: &str,
    duration: Duration,
) -> Result<T, String> {
    match timeout(duration, &mut *task).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(failure.into()),
        Err(_) => {
            task.abort();
            let _ = task.await;
            Err(failure.into())
        }
    }
}

/// Directory walks and file IO are synchronous; keep them off the async
/// worker. A JoinError means the work never ran, which is the operation's
/// own failure.
async fn blocking<T: Send + 'static>(
    failure: &str,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| failure.to_string())?
}

fn prepare_output_directory(job_id: &str) -> Result<PathBuf, String> {
    let root = std::env::temp_dir().join(format!(
        "hub-local-runner-output-{}",
        container_name(job_id)
    ));
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|_| "output_cleanup_failed".to_string())?;
    }
    fs::create_dir(&root).map_err(|_| "output_directory_failed".to_string())?;
    Ok(root)
}

fn read_generated_files(root: &Path) -> Result<Vec<GeneratedFile>, String> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut total = 0u64;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|_| "output_read_failed".to_string())? {
            let entry = entry.map_err(|_| "output_read_failed".to_string())?;
            let path = entry.path();
            let metadata =
                fs::symlink_metadata(&path).map_err(|_| "output_read_failed".to_string())?;
            if metadata.file_type().is_symlink() {
                return Err("output_symlink_rejected".into());
            }
            if metadata.is_dir() {
                pending.push(path);
                continue;
            }
            if !metadata.is_file() {
                return Err("output_special_file_rejected".into());
            }
            if files.len() >= MAX_FILES || metadata.len() > MAX_FILE_BYTES {
                return Err("output_limit_exceeded".into());
            }
            total = total
                .checked_add(metadata.len())
                .ok_or_else(|| "output_limit_exceeded".to_string())?;
            if total > MAX_TOTAL_FILE_BYTES {
                return Err("output_limit_exceeded".into());
            }
            let relative: PathBuf = path
                .strip_prefix(root)
                .map_err(|_| "output_path_invalid".to_string())?
                .to_path_buf();
            let relative = relative.to_string_lossy().replace('\\', "/");
            if relative.is_empty()
                || relative.starts_with('/')
                || relative.split('/').any(|part| part == "..")
            {
                return Err("output_path_invalid".into());
            }
            files.push(GeneratedFile {
                path: relative,
                bytes: fs::read(path).map_err(|_| "output_read_failed".to_string())?,
            });
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn output_directory_within_limits(root: &Path) -> bool {
    let mut pending = vec![root.to_path_buf()];
    let mut files = 0usize;
    let mut total = 0u64;
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            return false;
        };
        for entry in entries {
            let Ok(entry) = entry else {
                return false;
            };
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                return false;
            };
            if metadata.file_type().is_symlink() {
                return false;
            }
            if metadata.is_dir() {
                pending.push(path);
                continue;
            }
            if !metadata.is_file() {
                return false;
            }
            files += 1;
            total = match total.checked_add(metadata.len()) {
                Some(value) => value,
                None => return false,
            };
            if files > MAX_FILES || metadata.len() > MAX_FILE_BYTES || total > MAX_TOTAL_FILE_BYTES
            {
                return false;
            }
        }
    }
    true
}

fn configured_image(language: &str) -> Option<String> {
    image_config(language).ok().flatten()
}

fn image_config(language: &str) -> Result<Option<String>, ()> {
    let name = match language {
        "python" => "HUB_LOCAL_RUNNER_PYTHON_IMAGE",
        "javascript" => "HUB_LOCAL_RUNNER_NODE_IMAGE",
        _ => return Err(()),
    };
    match std::env::var(name) {
        Ok(value) => parse_image(&value),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(_) => Err(()),
    }
}

fn parse_image(value: &str) -> Result<Option<String>, ()> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 512 || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(());
    }
    let digest = value
        .strip_prefix("sha256:")
        .or_else(|| {
            value
                .split_once("@sha256:")
                .filter(|(name, _)| !name.is_empty())
                .map(|(_, digest)| digest)
        })
        .ok_or(())?;
    if digest.len() != 64 || !digest.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(());
    }
    Ok(Some(value.into()))
}

async fn docker_server_ready() -> bool {
    docker_status(&["version", "--format", "{{.Server.Version}}"])
        .await
        .unwrap_or(false)
}

async fn image_exists(image: &str) -> bool {
    docker_status(&["image", "inspect", image])
        .await
        .unwrap_or(false)
}

/// Reads a child pipe to EOF while keeping at most `MAX_OUTPUT_BYTES` —
/// storage is capped, but draining continues so a verbose writer can still
/// exit instead of blocking on a full pipe until the timeout kills it.
async fn read_bounded<R: AsyncRead + Unpin>(mut reader: R) -> Result<String, String> {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut chunk = [0u8; 8 * 1024];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                let room = (MAX_OUTPUT_BYTES as usize).saturating_sub(bytes.len());
                truncated |= n > room;
                bytes.extend_from_slice(&chunk[..n.min(room)]);
            }
            Err(_) => return Err("output_read_failed".into()),
        }
    }
    let mut value = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        value.push_str("\n[output truncated]");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_configuration_distinguishes_missing_and_malformed_pins() {
        assert_eq!(parse_image("  "), Ok(None));
        let digest = "a".repeat(64);
        for valid in [
            format!("sha256:{digest}"),
            format!("registry.example/python@sha256:{digest}"),
        ] {
            assert_eq!(parse_image(&valid), Ok(Some(valid)));
        }
        for invalid in [
            "python:latest".into(),
            "sha256:".into(),
            format!("sha256:{}", "a".repeat(63)),
            format!("sha256:{}", "a".repeat(65)),
            format!("sha256:{}", "g".repeat(64)),
            format!("@sha256:{digest}"),
            format!("bad name@sha256:{digest}"),
            "x".repeat(513),
        ] {
            assert_eq!(
                parse_image(&invalid),
                Err(()),
                "invalid fixed image accepted"
            );
        }
    }

    #[tokio::test]
    async fn lifecycle_tasks_propagate_errors_and_abort_when_bounded() {
        let mut failed = tokio::spawn(async { Err::<(), _>("synthetic".into()) });
        assert_eq!(
            join_task_with_timeout(&mut failed, "join_failed", Duration::from_millis(1)).await,
            Err("synthetic".into())
        );
        let mut pending =
            tokio::spawn(async { std::future::pending::<Result<(), String>>().await });
        assert_eq!(
            join_task_with_timeout(&mut pending, "join_timed_out", Duration::from_millis(1)).await,
            Err("join_timed_out".into())
        );
        assert!(pending.is_finished());
    }

    #[tokio::test]
    async fn bounded_read_drains_to_eof_and_only_caps_storage() {
        let flooded = vec![b'x'; MAX_OUTPUT_BYTES as usize + 65_536];
        let output = read_bounded(flooded.as_slice()).await.unwrap();
        assert!(output.ends_with("\n[output truncated]"));
        assert_eq!(output.len(), MAX_OUTPUT_BYTES as usize + 19);
        let exact = vec![b'x'; MAX_OUTPUT_BYTES as usize];
        let output = read_bounded(exact.as_slice()).await.unwrap();
        assert_eq!(output.len(), MAX_OUTPUT_BYTES as usize);
    }

    #[test]
    fn container_names_are_bounded_and_shell_free() {
        let name = container_name("x;$(bad)".repeat(40).as_str());
        assert!(name.len() <= 81);
        assert!(!name.contains(';'));
        assert!(!name.contains('$'));
    }
}
