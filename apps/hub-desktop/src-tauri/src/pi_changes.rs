//! Private file-tool snapshots. Only summaries belong in plaintext run history.
use crate::agent_tools::{self, Change};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::Path};

const MAX_FILES: usize = 16;
const MAX_BODY: usize = 32_768;
const MAX_TOTAL: usize = 1_048_576;
const COVERAGE: &str = "hub_file_tools";
const BASELINE: &str = "before_first_write";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiChangeSummary {
    pub coverage: String,
    pub baseline: String,
    pub status: String,
    pub reason: Option<String>,
    pub untracked_commands: bool,
    pub items: Vec<PiChangeItem>,
}

impl Default for PiChangeSummary {
    fn default() -> Self {
        PiChangeArchive::default().summary()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiChangeItem {
    pub id: String,
    pub path: String,
    pub kind: String,
    pub before_sha256: Option<String>,
    pub after_sha256: String,
    pub status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiFileDiff {
    pub change_id: String,
    pub path: String,
    pub before: String,
    pub after: String,
    pub before_sha256: Option<String>,
    pub after_sha256: String,
    pub status: String,
    pub current_state: String,
    pub coverage: String,
    pub baseline: String,
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ArchiveStatus {
    Tracked,
    Incomplete,
    #[default]
    Unavailable,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    id: String,
    path: String,
    before: String,
    after: String,
    before_sha256: Option<String>,
    after_sha256: String,
    external_gap: bool,
}

/// Serialize only into the encrypted Pi checkpoint; fields intentionally stay private.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PiChangeArchive {
    status: ArchiveStatus,
    reason: Option<String>,
    untracked_commands: bool,
    items: Vec<Entry>,
}

fn reason_allowed(reason: &str) -> bool {
    matches!(
        reason,
        "invalid_record"
            | "body_limit"
            | "file_limit"
            | "total_limit"
            | "path_alias"
            | "archive_invalid"
            | "save_failed"
            | "incomplete"
    )
}

fn valid_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| {
        id.get_version_num() == 4
            && id.get_variant() == uuid::Variant::RFC4122
            && id.to_string() == value
    })
}

fn path_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_owned()
    }
}

fn valid_pair(
    path: &str,
    before: &str,
    after: &str,
    before_hash: Option<&str>,
    after_hash: &str,
) -> bool {
    agent_tools::relative(path).is_ok()
        && before.len() <= MAX_BODY
        && after.len() <= MAX_BODY
        && before_hash.map_or(before.is_empty(), |hash| {
            hash == agent_tools::digest(before.as_bytes())
        })
        && after_hash == agent_tools::digest(after.as_bytes())
}

impl PiChangeArchive {
    pub fn new() -> Self {
        Self {
            status: ArchiveStatus::Tracked,
            ..Self::default()
        }
    }

    /// Check restored archives before exposing metadata, bodies, or saving them again.
    pub fn validate(&self) -> bool {
        match self.status {
            ArchiveStatus::Unavailable => {
                return self.items.is_empty() && self.reason.is_none() && !self.untracked_commands
            }
            ArchiveStatus::Tracked if self.reason.is_some() => return false,
            ArchiveStatus::Incomplete if !self.reason.as_deref().is_some_and(reason_allowed) => {
                return false
            }
            _ => (),
        }
        let mut ids = HashSet::new();
        let mut paths = HashSet::new();
        self.items.len() <= MAX_FILES
            && self.items.iter().all(|item| {
                valid_id(&item.id)
                    && ids.insert(&item.id)
                    && paths.insert(path_key(&item.path))
                    && valid_pair(
                        &item.path,
                        &item.before,
                        &item.after,
                        item.before_sha256.as_deref(),
                        &item.after_sha256,
                    )
            })
            && self
                .items
                .iter()
                .try_fold(0usize, |size, item| {
                    size.checked_add(item.before.len())?
                        .checked_add(item.after.len())
                })
                .is_some_and(|size| size <= MAX_TOTAL)
    }

    pub fn mark_incomplete(&mut self, reason: &str) {
        self.status = ArchiveStatus::Incomplete;
        self.reason = Some(
            if reason_allowed(reason) {
                reason
            } else {
                "incomplete"
            }
            .into(),
        );
    }

    pub fn note_command(&mut self) {
        self.untracked_commands = true;
    }

    pub fn record(&mut self, change: Change) {
        if !self.validate() {
            self.items.clear();
            self.mark_incomplete("archive_invalid");
            return;
        }
        if self.status == ArchiveStatus::Unavailable {
            self.mark_incomplete("invalid_record");
            return;
        }
        if change.before.len() > MAX_BODY || change.after.len() > MAX_BODY {
            self.mark_incomplete("body_limit");
            return;
        }
        if !valid_pair(
            &change.path,
            &change.before,
            &change.after,
            change.previous_sha256.as_deref(),
            &change.sha256,
        ) {
            self.mark_incomplete("invalid_record");
            return;
        }
        let existing = self
            .items
            .iter()
            .position(|entry| path_key(&entry.path) == path_key(&change.path));
        if existing.is_some_and(|index| self.items[index].path != change.path) {
            self.mark_incomplete("path_alias");
            return;
        }
        if existing.is_none() && self.items.len() == MAX_FILES {
            self.mark_incomplete("file_limit");
            return;
        }
        let total: usize = self
            .items
            .iter()
            .map(|item| item.before.len() + item.after.len())
            .sum();
        let next_size = existing
            .map_or(total + change.before.len() + change.after.len(), |index| {
                total - self.items[index].after.len() + change.after.len()
            });
        if next_size > MAX_TOTAL {
            self.mark_incomplete("total_limit");
            return;
        }
        if let Some(index) = existing {
            let entry = &mut self.items[index];
            entry.external_gap |= change.previous_sha256.as_deref()
                != Some(entry.after_sha256.as_str())
                || change.before != entry.after;
            entry.after = change.after;
            entry.after_sha256 = change.sha256;
        } else {
            self.items.push(Entry {
                id: uuid::Uuid::new_v4().to_string(),
                path: change.path,
                before: change.before,
                after: change.after,
                before_sha256: change.previous_sha256,
                after_sha256: change.sha256,
                external_gap: false,
            });
        }
    }

    pub fn summary(&self) -> PiChangeSummary {
        let valid = self.validate();
        PiChangeSummary {
            coverage: COVERAGE.into(),
            baseline: BASELINE.into(),
            status: if !valid {
                "incomplete"
            } else {
                match self.status {
                    ArchiveStatus::Tracked => "tracked",
                    ArchiveStatus::Incomplete => "incomplete",
                    ArchiveStatus::Unavailable => "unavailable",
                }
            }
            .into(),
            reason: if valid {
                self.reason.clone()
            } else {
                Some("archive_invalid".into())
            },
            untracked_commands: valid && self.untracked_commands,
            items: if valid {
                self.items
                    .iter()
                    .map(|item| PiChangeItem {
                        id: item.id.clone(),
                        path: item.path.clone(),
                        kind: if item.before_sha256.is_some() {
                            "modified"
                        } else {
                            "created"
                        }
                        .into(),
                        before_sha256: item.before_sha256.clone(),
                        after_sha256: item.after_sha256.clone(),
                        status: if item.external_gap {
                            "external_gap"
                        } else {
                            "available"
                        }
                        .into(),
                    })
                    .collect()
            } else {
                Vec::new()
            },
        }
    }

    pub fn diff(&self, root: &Path, change_id: &str) -> Result<PiFileDiff, String> {
        if !self.validate() {
            return Err("pi_changes_invalid_archive".into());
        }
        if !valid_id(change_id) {
            return Err("pi_changes_invalid_id".into());
        }
        let entry = self
            .items
            .iter()
            .find(|item| item.id == change_id)
            .ok_or("pi_changes_not_found")?;
        let current_state = match agent_tools::read_text(root, &entry.path, MAX_BODY) {
            Ok(file) => {
                if agent_tools::digest(file.content.as_bytes()) == entry.after_sha256 {
                    "matches"
                } else {
                    "changed"
                }
            }
            Err(_) => {
                // checked forbids links/junctions and verifies the canonical workspace first.
                let missing = agent_tools::checked(root, Path::new(&entry.path), true)
                    .ok()
                    .is_some_and(|path| {
                        fs::symlink_metadata(path)
                            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                    });
                if missing {
                    "missing"
                } else {
                    "unavailable"
                }
            }
        };
        Ok(PiFileDiff {
            change_id: entry.id.clone(),
            path: entry.path.clone(),
            before: entry.before.clone(),
            after: entry.after.clone(),
            before_sha256: entry.before_sha256.clone(),
            after_sha256: entry.after_sha256.clone(),
            status: if entry.external_gap {
                "external_gap"
            } else {
                "available"
            }
            .into(),
            current_state: current_state.into(),
            coverage: COVERAGE.into(),
            baseline: BASELINE.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(path: &str, before: Option<&str>, after: &str) -> Change {
        Change {
            path: path.into(),
            before: before.unwrap_or("").into(),
            after: after.into(),
            previous_sha256: before.map(|value| agent_tools::digest(value.as_bytes())),
            sha256: agent_tools::digest(after.as_bytes()),
        }
    }

    #[test]
    fn old_records_unavailable_new_records_tracked_and_metadata_has_no_bodies() {
        assert_eq!(PiChangeArchive::default().summary().status, "unavailable");
        let legacy: PiChangeArchive = serde_json::from_str("{}").unwrap();
        assert!(legacy.validate());
        let mut archive = PiChangeArchive::new();
        archive.record(change("a.txt", None, "unique-private-body"));
        archive.note_command();
        let summary = archive.summary();
        assert_eq!(summary.status, "tracked");
        assert!(summary.untracked_commands);
        assert_eq!(summary.items[0].kind, "created");
        assert!(valid_id(&summary.items[0].id));
        assert!(!serde_json::to_string(&summary)
            .unwrap()
            .contains("unique-private-body"));
        let restored: PiChangeArchive =
            serde_json::from_str(&serde_json::to_string(&archive).unwrap()).unwrap();
        assert!(restored.validate());
        assert_eq!(restored.summary().items[0].id, summary.items[0].id);
    }

    #[test]
    fn first_before_final_after_empty_existing_and_external_gaps() {
        let mut archive = PiChangeArchive::new();
        archive.record(change("a.txt", Some(""), "one"));
        let id = archive.items[0].id.clone();
        archive.record(change("a.txt", Some("one"), "two"));
        assert_eq!(archive.items[0].before, "");
        assert_eq!(archive.items[0].after, "two");
        assert_eq!(archive.items[0].id, id);
        assert_eq!(archive.summary().items[0].kind, "modified");
        assert_eq!(archive.summary().items[0].status, "available");
        archive.record(change("a.txt", Some("external"), "three"));
        archive.record(change("a.txt", Some("three"), "four"));
        assert_eq!(archive.items[0].after, "four");
        assert_eq!(archive.summary().items[0].status, "external_gap");
        assert!(archive.validate());
        let mut created = PiChangeArchive::new();
        created.record(change("b.txt", None, ""));
        created.record(change("b.txt", None, "recreated"));
        assert_eq!(created.summary().items[0].status, "external_gap");
    }

    #[test]
    fn invalid_records_dropped_without_losing_previous_pair_or_exposing_reason() {
        for mut invalid in [
            change("../bad.txt", None, "x"),
            change(".secret", None, "x"),
            change("a.txt", None, "x"),
            change("a.txt", Some("before"), "x"),
        ] {
            if invalid.path == "a.txt" {
                invalid.sha256 = "invented".into();
            }
            let mut archive = PiChangeArchive::new();
            archive.record(change("safe.txt", None, "safe"));
            archive.record(invalid);
            assert_eq!(archive.summary().reason.as_deref(), Some("invalid_record"));
            assert_eq!(archive.items.len(), 1);
            assert!(archive.validate());
        }
        let mut invalid = change("a.txt", None, "after");
        invalid.before = "not empty".into();
        let mut archive = PiChangeArchive::new();
        archive.record(invalid);
        assert!(archive.items.is_empty());
        archive.mark_incomplete("private server payload");
        assert_eq!(archive.summary().reason.as_deref(), Some("incomplete"));
        archive.mark_incomplete("save_failed");
        assert_eq!(archive.summary().reason.as_deref(), Some("save_failed"));
    }

    #[test]
    fn utf8_body_and_file_count_limits_include_exact_maximum() {
        let body = "é".repeat(MAX_BODY / 2);
        let mut archive = PiChangeArchive::new();
        for index in 0..MAX_FILES {
            archive.record(change(&format!("file{index}.txt"), Some(&body), &body));
        }
        assert_eq!(archive.items.len(), MAX_FILES);
        assert_eq!(archive.summary().status, "tracked");
        assert!(archive.validate());
        archive.record(change("file0.txt", Some(&body), "small"));
        assert_eq!(archive.summary().status, "tracked");
        archive.record(change("extra.txt", None, "x"));
        assert_eq!(archive.summary().reason.as_deref(), Some("file_limit"));
        for before in [true, false] {
            let large = "é".repeat(MAX_BODY / 2 + 1);
            let mut archive = PiChangeArchive::new();
            archive.record(if before {
                change("large.txt", Some(&large), "")
            } else {
                change("large.txt", None, &large)
            });
            assert_eq!(archive.summary().reason.as_deref(), Some("body_limit"));
            assert!(archive.items.is_empty());
        }
    }

    #[test]
    fn restored_invalid_hash_path_id_duplicates_status_and_limits_fail_closed() {
        let mut source = PiChangeArchive::new();
        source.record(change("a.txt", Some("before"), "after"));
        let original = serde_json::to_value(source).unwrap();
        let invalids = [
            (
                "id",
                serde_json::json!("00000000-0000-0000-0000-000000000000"),
            ),
            ("path", serde_json::json!("../a.txt")),
            ("beforeSha256", serde_json::json!(null)),
            ("afterSha256", serde_json::json!("invalid")),
            ("after", serde_json::json!("a".repeat(MAX_BODY + 1))),
        ];
        for (key, value) in invalids {
            let mut raw = original.clone();
            raw["items"][0][key] = value;
            let archive: PiChangeArchive = serde_json::from_value(raw).unwrap();
            assert!(!archive.validate());
            assert!(archive.summary().items.is_empty());
            assert_eq!(archive.summary().reason.as_deref(), Some("archive_invalid"));
            assert!(archive
                .diff(
                    Path::new("unavailable"),
                    &original["items"][0]["id"].as_str().unwrap()
                )
                .is_err());
        }
        for count in [2, MAX_FILES + 1] {
            let mut raw = original.clone();
            raw["items"] = serde_json::json!(vec![raw["items"][0].clone(); count]);
            assert!(!serde_json::from_value::<PiChangeArchive>(raw)
                .unwrap()
                .validate());
        }
        for status in ["unavailable", "incomplete"] {
            let mut raw = original.clone();
            raw["status"] = serde_json::json!(status);
            assert!(!serde_json::from_value::<PiChangeArchive>(raw)
                .unwrap()
                .validate());
        }
        let mut raw = original.clone();
        raw["reason"] = serde_json::json!("secret");
        assert!(!serde_json::from_value::<PiChangeArchive>(raw)
            .unwrap()
            .validate());
        let mut raw = original;
        raw["unknown"] = serde_json::json!(true);
        assert!(serde_json::from_value::<PiChangeArchive>(raw).is_err());
    }

    #[test]
    fn windows_case_alias_never_mixes_stored_pairs() {
        let mut archive = PiChangeArchive::new();
        archive.record(change("A.txt", None, "first"));
        archive.record(change("a.txt", Some("first"), "second"));
        if cfg!(windows) {
            assert_eq!(archive.items.len(), 1);
            assert_eq!(archive.items[0].after, "first");
            assert_eq!(archive.summary().reason.as_deref(), Some("path_alias"));
            let mut raw = serde_json::to_value(&archive).unwrap();
            let mut alias = raw["items"][0].clone();
            alias["id"] = serde_json::json!(uuid::Uuid::new_v4().to_string());
            alias["path"] = serde_json::json!("a.txt");
            raw["items"].as_array_mut().unwrap().push(alias);
            assert!(!serde_json::from_value::<PiChangeArchive>(raw)
                .unwrap()
                .validate());
        } else {
            assert_eq!(archive.items.len(), 2);
        }
    }

    #[test]
    fn restored_identity_and_path_byte_boundaries_are_independent() {
        let path = format!("{}.txt", "é".repeat(118));
        assert_eq!(path.len(), 240);
        let mut source = PiChangeArchive::new();
        source.record(change(&path, None, "x"));
        assert_eq!(source.summary().status, "tracked");
        source.record(change(&format!("a{path}"), None, "x"));
        assert_eq!(source.summary().reason.as_deref(), Some("invalid_record"));
        let id = source.items[0].id.clone();
        for invalid in [
            format!("{id}\n"),
            "FFFFFFFF-FFFF-4FFF-BFFF-FFFFFFFFFFFF".into(),
            "00000000-0000-1000-8000-000000000000".into(),
        ] {
            assert!(!valid_id(&invalid));
        }
        for duplicate_id in [true, false] {
            let mut archive = source.clone();
            let mut second = archive.items[0].clone();
            if duplicate_id {
                second.path = "different.txt".into();
            } else {
                second.id = uuid::Uuid::new_v4().to_string();
            }
            archive.items.push(second);
            assert!(!archive.validate());
        }
        let mut invalid = change("bad.txt", Some("before"), "after");
        invalid.previous_sha256 = Some(agent_tools::digest(b"different"));
        source.record(invalid);
        assert_eq!(source.items.len(), 1);
        assert!(source.validate());
    }

    #[test]
    fn diff_returns_stored_pair_for_current_matches_changed_missing_and_unavailable() {
        let temporary =
            std::env::temp_dir().join(format!("hub-pi-changes-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&temporary).unwrap();
        let root = temporary.canonicalize().unwrap();
        let _cleanup = agent_tools::TestWorkspace { path: root.clone() };
        let mut archive = PiChangeArchive::new();
        archive.record(change("a.txt", Some("stored before"), "stored after"));
        let id = archive.items[0].id.clone();
        for (body, state) in [
            (Some("stored after"), "matches"),
            (Some("outside"), "changed"),
            (None, "missing"),
        ] {
            if let Some(body) = body {
                fs::write(root.join("a.txt"), body).unwrap();
            } else {
                fs::remove_file(root.join("a.txt")).unwrap();
            }
            let diff = archive.diff(&root, &id).unwrap();
            assert_eq!(diff.current_state, state);
            assert_eq!(diff.before, "stored before");
            assert_eq!(diff.after, "stored after");
        }
        fs::write(root.join("a.txt"), [0xff]).unwrap();
        assert_eq!(
            archive.diff(&root, &id).unwrap().current_state,
            "unavailable"
        );
        fs::remove_file(root.join("a.txt")).unwrap();
        fs::create_dir(root.join("a.txt")).unwrap();
        assert_eq!(
            archive.diff(&root, &id).unwrap().current_state,
            "unavailable"
        );
        assert_eq!(
            archive
                .diff(&root.join("absent"), &id)
                .unwrap()
                .current_state,
            "unavailable"
        );
        assert!(archive.diff(&root, "invalid\n").is_err());
        assert!(archive
            .diff(&root, &uuid::Uuid::new_v4().to_string())
            .is_err());
        assert!(PiChangeArchive::new().summary().items.is_empty());
    }
}
