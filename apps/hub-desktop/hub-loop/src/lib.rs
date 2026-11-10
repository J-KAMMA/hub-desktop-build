//! hub-loop: provider-neutral core pieces of Hub's own harness. MIT.
//! Depends on nothing from Hub; Hub code depends on this crate, never the reverse.

pub mod compaction;
pub mod journal;

pub use compaction::{
    apply_compactions, estimate_tokens, CompactionError, CompactionPolicy, Compactor, NoOpReason,
    Outcome, Pending, Role, Summariser, SummaryRequest, Turn, SUMMARY_INSTRUCTION,
};
pub use journal::{
    Approval, Compaction, Effect, Journal, JournalError, Kind, Record, ResumePlan, SessionState, Status,
    Store, ToolOutcome, ToolRecord,
};
