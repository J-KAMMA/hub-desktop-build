# hub-loop

Hub's own harness core (the model-and-tool loop described in
docs/hub-harness-swap/PLAN.md).

Licence: **MIT** (see LICENSE), owner-approved 2026-10-18. This directory is an
exception: the rest of Hub Desktop (pps/hub-desktop) is AGPL-3.0-only.

Why MIT: the loop is meant to be reusable outside Hub, including by pps/ai,
which is not part of the AGPL self-host package.

Rules:

- Do not import AGPL-only Hub code (pps/hub, pps/federation, or the rest of
  pps/hub-desktop) into this directory. Dependencies point inward only: Hub
  code may use hub-loop, never the reverse.
- The loop takes the model call and tool execution as injected interfaces and has
  no provider- or Hub-specific dependencies.
- Third-party code keeps its own licence and must be MIT-compatible.

## Contents

- `src/journal.rs`: the durable session journal (owner decision 2026-11-06).
  An append-only, fsync'd, per-session log of session, model-turn, tool-call,
  tool-result, user-input, approval, cancel and done records. `replay` rebuilds
  the session and `SessionState::plan` says what may happen on resume:
  read-only tool calls without a result may be retried; side-effecting calls
  without a result are reported as interrupted and never re-run; unanswered
  approvals stay pending. A torn last record is ignored. Secret-looking keys
  and strings are redacted before writing, files have a size cap, and
  `Store::prune_finished` removes old finished sessions (never unfinished ones).

Run the tests with `cargo test` in this directory. Hub Desktop consumes the
crate as a path dependency (`apps/hub-desktop/src-tauri`).

- `src/compaction.rs`: context compaction policy (owner decision 2026-11-06). At 70% of the context window (32k if unknown) the oldest turns become one summary written by an injected `Summariser`; system, latest turns, unanswered calls and pending approvals are kept, a call is never split from its result, and the `compacted` journal record is committed before the compacted context is returned. A failing summariser keeps the full context and retries only after growth. Plain-language notes: docs/hub-harness-swap/PLAN.md.

The model-and-tool loop itself is not here yet.