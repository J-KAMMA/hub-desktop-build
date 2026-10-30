# Work preview exercise

This folder deliberately contains a defect in `last.cjs`. Copy it to a separate
test workspace before running a real Work. Do not fix the canonical example.
No dependency installation, network access, credentials or external data is needed.

## Required behavior

`last(items)` accepts only a JavaScript array. Other inputs must throw `TypeError`.
An empty array returns `null`. A non-empty array returns its last item unchanged,
including false, zero, negative zero, empty strings, null, undefined, NaN and object
identity. A hole in the last array slot returns undefined. Never mutate the array.

Only `last.cjs` may change. `acceptance.cjs` is the fixed verification source.
The initial implementation intentionally fails some cases. Passing that initial
failure through a test is preparation evidence, not successful agent execution.

## Work input

Use a configured local model and an already available, digest-pinned Node.js
Docker image. Select the copied folder as the workspace, choose coding and enable
per-operation write/test approval. Use `review.md` as the optional Skill.

Paste this request:

> Read README.md, last.cjs and acceptance.cjs. Fix only last.cjs to satisfy the
> documented behavior. Keep acceptance.cjs unchanged. Show the proposed edit and
> wait for native approval. After the approved final edit, request a JavaScript
> test with `require('/workspace/acceptance.cjs')`. Read acceptance.cjs first so
> the runtime includes it in the copied test workspace. Report the test outcome
> and its scope, and finish without changing any other file.

Before approval, the source file must still match its initial hash. After write
approval, inspect the saved change and approve the displayed test separately.
All 18 cases must pass, the fixed test file must retain its hash, and Work must
report current verification rather than an older test result.

Use a separate second Work to check cancellation before approval; no write may
occur. Close and reopen the native window to inspect the record, then use the
explicit previous-settings button. Starting a new Work must require another
click and permissions; an app restart must not replay a pending approval.

The Node command `node acceptance.cjs` can inspect this fixture on the host.
That command does not prove Docker isolation, model compatibility or native UI
acceptance. Keep those results separate.
