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

No engine code lives here yet.