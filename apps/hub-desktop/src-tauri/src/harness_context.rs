use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;

const DEFAULT_CONTEXT_BUDGET: usize = 32_000;
const HOT_BUDGET: usize = 10_000;
const WARM_BUDGET: usize = 16_000;
const COLD_BUDGET: usize = 6_000;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSummary {
    pub hot_chars: usize,
    pub warm_chars: usize,
    pub cold_chars: usize,
    pub source_count: usize,
    pub budget_chars: usize,
    pub compacted: bool,
}

pub struct ContextBundle {
    pub prompt_section: String,
    pub summary: ContextSummary,
}

fn truncate_chars(value: &str, limit: usize) -> (String, bool) {
    if value.chars().count() <= limit {
        return (value.to_owned(), false);
    }
    let mut output = value
        .chars()
        .take(limit.saturating_sub(24))
        .collect::<String>();
    output.push_str("\n[context compacted]");
    (output, true)
}

fn safe_instruction_file(root: &Path, candidate: PathBuf) -> Option<PathBuf> {
    let canonical = candidate.canonicalize().ok()?;
    (canonical.starts_with(root) && canonical.is_file()).then_some(canonical)
}

fn instruction_candidates(workspace: &Path, root: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut current = Some(workspace);
    while let Some(directory) = current {
        if !directory.starts_with(root) {
            break;
        }
        paths.push(directory.join("AGENTS.md"));
        if directory == root {
            break;
        }
        current = directory.parent();
    }
    paths.extend([
        workspace.join("README.md"),
        workspace.join("package.json"),
        workspace.join("Cargo.toml"),
    ]);
    paths
}

fn git_files(workspace: &Path) -> Vec<String> {
    let output = crate::local_cli::quiet_std_command("git")
        .args(["ls-files", "--cached", "--others", "--exclude-standard"])
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|path| {
            let lower = path.to_ascii_lowercase();
            !lower.contains(".env")
                && !lower.contains("secret")
                && !lower.contains("credential")
                && !lower.ends_with(".pem")
                && !lower.ends_with(".key")
        })
        .take(20_000)
        .map(str::to_owned)
        .collect()
}

fn objective_terms(objective: &str) -> Vec<String> {
    let mut terms = objective
        .split(|value: char| !value.is_alphanumeric() && value != '-' && value != '_')
        .map(|value| value.to_lowercase())
        .filter(|value| value.chars().count() >= 3)
        .collect::<Vec<_>>();
    terms.sort();
    terms.dedup();
    terms.truncate(32);
    terms
}

pub fn build(contract: &crate::harness_control::TaskContract, workspace: &Path) -> ContextBundle {
    let budget = DEFAULT_CONTEXT_BUDGET;
    let root = crate::dev_cli::git_root(workspace).unwrap_or_else(|| workspace.to_path_buf());
    let hot_raw = serde_json::to_string_pretty(contract).unwrap_or_else(|_| "{}".into());
    let (hot, hot_compacted) = truncate_chars(&hot_raw, HOT_BUDGET.min(budget));

    let mut source_count = 0;
    let mut warm_parts = Vec::new();
    for candidate in instruction_candidates(workspace, &root) {
        let Some(file) = safe_instruction_file(&root, candidate) else {
            continue;
        };
        let Ok(content) = std::fs::read_to_string(&file) else {
            continue;
        };
        let (content, _) = truncate_chars(&content, 6_000);
        let label = file.strip_prefix(&root).unwrap_or(&file).to_string_lossy();
        warm_parts.push(format!("### {label}\n{content}"));
        source_count += 1;
    }
    let (warm, warm_compacted) = truncate_chars(&warm_parts.join("\n\n"), WARM_BUDGET);

    let terms = objective_terms(&contract.objective);
    let files = git_files(workspace);
    let mut relevant = files
        .iter()
        .filter(|path| {
            let lower = path.to_lowercase();
            terms.iter().any(|term| lower.contains(term))
        })
        .take(80)
        .cloned()
        .collect::<Vec<_>>();
    if relevant.is_empty() {
        relevant.extend(files.into_iter().take(40));
    }
    let cold_raw = relevant.join("\n");
    let (cold, cold_compacted) = truncate_chars(&cold_raw, COLD_BUDGET);

    let summary = ContextSummary {
        hot_chars: hot.chars().count(),
        warm_chars: warm.chars().count(),
        cold_chars: cold.chars().count(),
        source_count,
        budget_chars: budget,
        compacted: hot_compacted || warm_compacted || cold_compacted,
    };
    ContextBundle {
        prompt_section: format!(
            "[Hot context: authoritative task state]\n{hot}\n\n[Warm context: repository instructions and manifests]\n{warm}\n\n[Cold context: relevant paths; inspect before using]\n{cold}"
        ),
        summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compaction_is_character_safe() {
        let value = "あ".repeat(100);
        let (cut, compacted) = truncate_chars(&value, 40);
        assert!(compacted);
        assert!(cut.contains("context compacted"));
        assert!(cut.is_char_boundary(cut.len()));
    }

    #[test]
    fn objective_terms_are_bounded_and_deduplicated() {
        assert_eq!(
            objective_terms("Harness harness rollback UI"),
            vec!["harness", "rollback"]
        );
    }
}
