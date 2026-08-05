# DiffWalk

Agent-guided code review for [pi](https://github.com/earendil-works/pi).

Coding agents can produce changes faster than a human can rebuild the context needed to review them. A raw diff does not solve that problem. It shows what changed, but it does not tell the reviewer where to begin, why a file matters, or which part of the system to inspect next.

DiffWalk turns a code review into a guided walkthrough. The agent builds a review route through the change, explains the context for each stop, and presents the real Git diff one review unit at a time. The human still reads the code, asks questions, and decides what should happen.

## What DiffWalk Is

DiffWalk is a review navigator, not an autonomous reviewer.

It is intended to:

- give the reviewer a clear entry point into a change
- order review units by how the system works, not by file name
- explain the relevant call path, contracts, and invariants before showing a diff
- keep every explanation anchored to a frozen Git snapshot
- let the reviewer attach comments to exact diff lines
- send all comments back to the agent as one structured result

It is not intended to:

- approve code on behalf of the human
- replace tests, static analysis, security review, or production safeguards
- treat an agent summary as proof that an implementation is correct
- let the agent omit inconvenient changes without an explicit reason
- modify code while the guided review is in progress

## Workflow

Run:

```text
/diffwalk [base]
/diffwalk --discard
```

Examples:

```text
/diffwalk
/diffwalk origin/main
/diffwalk --discard
```

With no base argument, DiffWalk will review the current worktree against `HEAD`, including tracked and untracked changes. With a base argument, it will review the current working state against that Git revision. A Git revision cannot start with `-`, so an option never shadows a base.

When the comparison contains no line that needs review, DiffWalk reports that and starts nothing. No snapshot is left pending, and the agent receives no route request. The report still names carried-forward lines from the previous round, changes that cannot be reviewed line by line, and snapshot notices.

`/diffwalk --discard` drops a pending review without opening the walkthrough.

The review flow is:

1. DiffWalk captures a frozen snapshot of the current Git changes.
2. Each changed line receives a stable address: a file, a side, and a line number.
3. The current agent reads the task, the affected code, and the diff.
4. The agent constructs a review route by drawing spans over the regions a reviewer must understand together.
5. DiffWalk validates that every changed line requiring review is covered once or explicitly skipped with a reason.
6. The TUI walks the reviewer through the route one review unit at a time.
7. The reviewer adds comments to specific lines as needed.
8. A final page shows every comment before submission.
9. DiffWalk returns the comments to the agent as one structured tool result.
10. The agent explains, investigates, or modifies the code according to the selected submission mode.

## Review Order

Git orders diffs by path. Humans usually understand changes in a different order.

The agent should normally construct a route that moves through:

1. user-visible behavior or the system entry point
2. public contracts such as APIs, types, and schemas
3. core data flow and state transitions
4. the main implementation
5. error handling and failure paths
6. callers and integration points
7. tests and the behavior they prove

This is a default reasoning pattern, not a fixed file order. The agent may choose another route when the change demands it, but every step must explain why it appears at that point in the review.

## Review Units

A review unit is one conceptual stop in the walkthrough. The agent defines it by drawing spans: a path with an old line range, a new line range, or both.

A unit is a semantic region, not a diff artifact. It may span several files, so an implementation and the test that proves it can be read together. It may cover part of a Git hunk, so two unrelated changes that happen to sit four lines apart do not have to be reviewed as one thing. It may include unchanged lines for context, and two units may share that context, because only changed lines count toward coverage.

DiffWalk offers the Git hunk boundaries as suggested spans. They are a starting point, not the unit of review. A hunk is produced by the diff algorithm's context radius and has no relationship to what a reviewer must understand together.

DiffWalk also detects exact relocations: a block of removed lines that reappears, byte-exact after indentation normalization, as a block of added lines elsewhere in the change. The inventory lists each detected move as coordinates so the agent can keep both sides of a relocation in one review unit and the human reads a move as a move, not as an unrelated deletion and addition. Detection is conservative and deterministic: it requires a globally unique anchor line, a constant indentation offset, and a minimum amount of relocated code, and it discards ambiguous candidates instead of guessing. The walkthrough screen does not yet mark moved regions.

In an incremental review, the planned route will contain only lines marked `needs-review`. Lines already reviewed without comment will be carried forward outside the planned route. They will remain visible in the review inventory and coverage summary, and the human will be able to inspect them explicitly without requiring the agent to route or skip them again.

Each unit should include:

- **Why here:** Why this is the right point to inspect now.
- **Context:** The call path, contract, or invariant needed to understand the code.
- **What changed:** A direct description of the behavioral or structural change.
- **Review focus:** Concrete questions the reviewer should answer.
- **Diff:** The exact content of the region from the frozen snapshot.
- **Next:** Why the following unit comes next.

The agent provides the route and explanation. DiffWalk provides the diff content. The model must never generate or rewrite the displayed patch.

## Route Quality Signals

Route validation answers whether a route is complete. It cannot answer whether a route is thoughtful. After a route passes validation, DiffWalk checks three mechanical signals of a route that was copied from Git hunks instead of planned semantically:

- every unit copies exactly one suggested span, so the route mirrors hunk boundaries (only for routes with at least three units)
- single-file units walk files in alphabetical path order (only for routes touching at least three files)
- both sides of a detected relocation are covered, but never by the same unit

When a signal fires, DiffWalk returns it to the agent once instead of opening the walkthrough, so the agent can redraw the route before the human starts reading. The signals are advisory, not a quota: the agent may resubmit the same route and the walkthrough opens. A review is nudged at most once.

## TUI

The walkthrough keeps the default screen focused on the review task and frozen diff. Press `e` when the full call path and agent explanation are needed.

```text
DiffWalk • unit 3/12 • reviewed 2/12 • comments 1
Authentication request validation • skipped 1 • unsupported 0 • snapshot check-on-submit

Review this change
The handler now validates issuer and audience.

Focus
• Is the trusted issuer read from configuration?
• Do existing tokens remain compatible?

src/auth/handler.ts
     46    46   const request = await parse(raw)
     47    47   const token = request.headers.authorization
     48        - if (!token) return unauthorized()
>          48 + const claims = await validateToken(token)
           49 + if (claims.issuer !== config.issuer) return unauthorized()
     49    50   return createSession(claims)

test/auth/handler.test.ts
           88 + test("rejects a foreign issuer", async () => {

j/k select line • c comment • n complete section • e details • s summary • Esc pause
```

One unit can cover several files, so the implementation and the test that proves it are read together. A highlighted header identifies each region's file. When a region is taller than the screen, the file header of the region at the top of the viewport stays pinned above the diff while scrolling, so the current file name never disappears. The read-only inventory view pins its file title the same way. Terminals too short to spare a line keep every line for diff content.

The normal flow is to select changed lines with `j` or `k`, add comments with `c`, and explicitly complete each review unit with `n`. Completing the final unit opens the submission page. Press `s` to inspect review progress and comments at any time.

Controls:

| Key | Action |
|---|---|
| `j`, `k`, `Up`, `Down` | Move through diff lines or scroll the current page |
| `gg`, `G` | Jump to the first or last line of the current page |
| `1`-`9` | Start a count prefix that repeats the next movement, for example `5j` or `2Ctrl+d` |
| `Ctrl+d`, `Ctrl+u` | Move by half a viewport |
| `PageUp`, `PageDown`, `Ctrl+f`, `Ctrl+b` | Move by a viewport |
| `n` | Mark the current review unit as explicitly reviewed and continue; the last unit opens the submission page |
| `p`, `h`, `Left` | Move to the previous review unit without marking anything reviewed |
| `l`, `Right` | Move to the next review unit without marking anything reviewed |
| `c` | Add or edit a comment on the selected line |
| `d` | Delete the comment on the selected line |
| `e` | Open the complete agent explanation |
| `i` | Open the frozen snapshot inventory |
| `s` | Open the comment summary and submission page |
| `Esc` | Return from a secondary page or open the pause and discard screen |

The walkthrough footer shows only the most common keys. The table above is the complete set. On secondary pages `h` and `l` follow `Left` and `Right`: `h` returns from the explanation, inventory, and read-only diff pages, `l` opens the selected inventory entry, and on the submission page both switch the submission mode.

The inventory lists one entry per changed file with its planned, skipped, and carried-forward line counts, plus metadata-only, binary, unsupported, and notice entries. Metadata entries include file status and mode transitions. Any changed region can be opened for explicit read-only inspection, including regions outside the planned route.

A comment will retain its selected file path, old and new paths for renames, the side and line number it is anchored to, the selected line text, its review unit, and nearby file context.

## Comment Submission

The final page will support two submission modes:

- **Discuss first:** The agent investigates and responds to every comment without editing code.
- **Apply change requests:** The agent applies direct change requests and explains questions or disagreements.

The comments are returned only after the reviewer explicitly completes every planned review unit and submits the batch. An incomplete summary sends Enter back to the first pending unit. This keeps the review uninterrupted and prevents the agent from changing later regions while the human is still reading the snapshot. Submission rechecks the repository state; drift blocks submission and leaves draft comments in the walkthrough. Snapshot verification can be cancelled without losing drafts.

## Grounding and Coverage

The review must remain tied to the repository state that the human is looking at.

DiffWalk will enforce the following rules:

- Git output is the source of truth for all displayed changes.
- The snapshot is immutable for the duration of a review.
- Every changed line marked `needs-review` must be covered by exactly one review unit or explicitly skipped.
- A line marked `unresolved-comment` cannot be skipped.
- Carried-forward lines remain visible outside the planned route.
- A skipped region must include a visible reason.
- A span naming an unknown file, an out-of-range line, or no changed line causes route validation to fail.
- A changed line covered twice, or both covered and skipped, causes route validation to fail.
- A changed worktree is detected before comment submission.
- Comments retain stable snapshot locations even if the live worktree later changes.
- Binary files, generated files, renames, deletions, and untracked files must be represented or explicitly reported as unsupported.

These rules do not make the agent's explanation correct. They prevent the explanation from silently changing or hiding the code under review.

## Architecture

```text
/diffwalk command
    -> Git snapshot collector
    -> whole-file reconstruction and changed-line addressing
    -> agent review-route prompt
    -> guided_review tool call
    -> route coverage validation
    -> interactive review TUI
    -> structured comment result
    -> agent response or implementation
```

The source layout is:

```text
src/
  index.ts              Command and tool registration
  git-diff.ts           Snapshot collection and diff parsing
  review-span.ts        Changed-line atom, span resolution, and coverage arithmetic
  review-delta.ts       Incremental changed-line classification and delta validation
  review-moves.ts       Exact relocation detection over the frozen snapshot
  in-progress-review.ts Resumable review lifecycle and submission eligibility
  route-validation.ts   Route coverage, ordering, and skip validation
  route-advisory.ts     Advisory route-quality signals and the one-shot nudge
  review-coverage.ts    Submitted changed-line outcome calculation
  review-series.ts      Completed review round lifecycle
  review-persistence.ts Session-entry serialization of completed rounds
  review-comments.ts    Comment anchors, drafts, and submission results
  review-ui.ts           Interactive TUI
  prompts.ts             Agent instructions for route construction
  types.ts               Shared data structures and schemas
test/
  index.test.ts
  git-diff.test.ts
  review-delta.test.ts
  review-moves.test.ts
  in-progress-review.test.ts
  route-validation.test.ts
  route-advisory.test.ts
  review-coverage.test.ts
  review-series.test.ts
  review-persistence.test.ts
  review-comments.test.ts
  prompt-surface.test.ts
```

Every standing string the model can see, including the kickoff prompt, the tool description, result instructions, and the advisory nudge, is rendered over fixed fixtures and pinned by a golden file in `test/prompt-surface.test.ts`. Changing the model-visible surface is an explicit, reviewable act. Validation error text is deliberately outside the pinned surface: it is conflict feedback and free to improve.

## Development Usage

Install the locked dependencies without lifecycle scripts, then load the extension directly:

```bash
npm ci --ignore-scripts
pi -e ./src/index.ts
```

Run `/diffwalk` from a Git worktree in interactive TUI mode. Pressing Esc can pause the current review without returning draft comments to the agent. Running `/diffwalk` again in the same extension process resumes the frozen route, explicit unit progress, draft comments, and submission mode when the worktree still matches the snapshot.

If the worktree changed while a routed review was paused, the next `/diffwalk` reports the drift, discards the stale review together with its draft comments, and starts a new review. Running `/diffwalk` with a different base while a routed review holds draft comments or reviewed units fails with instructions instead of silently discarding that work; the message points at `/diffwalk --discard`. A pending review with no recorded work, and a pending review that has no route yet, are replaced when the base changes or the worktree drifts. Inside the walkthrough, discard remains a separate explicit action.

Completed review rounds persist as custom entries in the pi session, so the carried-forward baseline survives pi restarts, `/reload`, and session resume. The next `/diffwalk` against the same repository, branch, and base classifies unchanged, previously reviewed lines as carried-forward instead of routing them again. Entries with an unknown format version or a broken structure are ignored on restore. A paused in-progress review is still extension memory only: it does not survive a reload, and the next `/diffwalk` starts over from a fresh snapshot.

## Review Lifecycle Domain

The domain layer represents an in-progress review independently from a TUI, tool call, or agent conversation. An in-progress review owns its frozen snapshot, validated route, explicit per-unit progress, draft comments, submission mode, and optimistic version. Repository drift is derived by comparing the current repository state with the frozen snapshot rather than stored as a lifecycle state.

The atom of the domain is the changed line, addressed by file, side, and line number. Review rounds record an outcome for every changed line, and the next round matches the two rounds by aligning each file's changed-line sequence. A line therefore stays carried forward when unrelated edits shift it or rewrite its neighbours.

The lifecycle currently supports route preparation, readiness, submission into an immutable review round, and explicit discard. Submission is rejected until every planned unit is explicitly reviewed and the repository state captured at submission time still matches the snapshot. The extension resumes this domain object within one extension process. Completed rounds are written to the session as versioned entries and restored on session start as the delta baseline for the next round; the in-progress review itself is not persisted across extension reloads or processes.

## Design Principles

### The human performs the review

The agent reduces context reconstruction cost. It does not take ownership of the approval decision.

### The route is semantic

Review order should follow behavior, contracts, and data flow. Alphabetical file order is only a fallback.

### The patch is not model output

The agent may explain a region, but the extension must render the content captured from Git. The kickoff inventory tells the agent which lines changed, not what they contain; the agent reads the code with its own tools.

### Coverage is visible

The reviewer should always know how much of the snapshot has been reviewed, commented on, or skipped.

### Review state is frozen

The implementation agent must not edit code during the walkthrough. A review of a moving target is not a review.

### Comments return as one batch

The reviewer controls when feedback reaches the agent and what the agent is allowed to do with it.

## Roadmap

The current version includes:

- worktree and explicit-base snapshots
- tracked and untracked file support
- changed-line addressing with whole-file reconstruction
- agent-planned review routes with semantic, possibly cross-file, review units
- an inventory-only agent prompt that carries no file content
- complete changed-line coverage validation
- line-oriented diff navigation
- inline comment editing
- comment summary and batch submission
- worktree drift detection
- explicit pause and in-process resume of an interrupted review
- incremental review rounds with carried-forward classification, persisted across restarts as session entries
- parser, route, workflow, comment, and TUI tests

Possible later work includes:

- persisted review state and rounds across extension reloads and processes
- pausing a walkthrough to ask the agent a live question
- GitHub pull request sources
- posting comments back to a pull request
- an independent critic agent in addition to the guiding agent
- review history and trust calibration by repository

## License

[MIT](LICENSE)
