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
- let the agent omit inconvenient hunks without an explicit reason
- modify code while the guided review is in progress

## Planned Workflow

The planned command is:

```text
/review [base]
```

Examples:

```text
/review
/review origin/main
```

With no base argument, DiffWalk will review the current worktree against `HEAD`, including tracked and untracked changes. With a base argument, it will review the current working state against that Git revision.

The review flow will be:

1. DiffWalk captures a frozen snapshot of the current Git changes.
2. Each file and hunk receives a stable identifier.
3. The current agent reads the task, the affected code, and the diff.
4. The agent constructs a review route using the stable hunk identifiers.
5. DiffWalk validates that every hunk requiring review is covered once or explicitly skipped with a reason.
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

A review unit is one conceptual stop in the walkthrough. It may contain one hunk or several tightly related hunks.

In an incremental review, the planned route will contain only hunks marked `needs-review`. Unchanged hunks already reviewed without comment will be carried forward outside the planned route. They will remain visible in the review inventory and coverage summary, and the human will be able to inspect them explicitly without requiring the agent to route or skip them again.

Each unit should include:

- **Why here:** Why this is the right point to inspect now.
- **Context:** The call path, contract, or invariant needed to understand the code.
- **What changed:** A direct description of the behavioral or structural change.
- **Review focus:** Concrete questions the reviewer should answer.
- **Diff:** The exact hunk content from the frozen snapshot.
- **Next:** Why the following unit comes next.

The agent provides the route and explanation. DiffWalk provides the diff content. The model must never generate or rewrite the displayed patch.

## Planned TUI

A review screen will contain the explanation and the selected diff unit:

```text
[3 / 12] Authentication request validation
src/auth/handler.ts  @@ -42,8 +48,19 @@

Why here
This is the external entry point for the authentication flow. The token
parser depends on the invariant established here.

Context
handler -> validateRequest -> parseToken -> createSession

What changed
The handler now validates issuer and audience instead of checking only that
an authorization header exists.

Review focus
- Is the trusted issuer read from configuration?
- Do existing tokens remain compatible?
- Does the failure response expose internal information?

  48   const token = request.headers.authorization
- 49   if (!token) return unauthorized()
+ 49   const claims = await validateToken(token)
> 50   if (claims.issuer !== config.issuer) return unauthorized()
```

Planned controls:

| Key | Action |
|---|---|
| `j`, `k`, `Up`, `Down` | Move through diff lines or scroll the current page |
| `PageUp`, `PageDown` | Move by a viewport |
| `n`, `p`, `Left`, `Right` | Move between review units |
| `c` | Add or edit a comment on the selected line |
| `d` | Delete the comment on the selected line |
| `e` | Open the complete agent explanation |
| `i` | Open the frozen snapshot inventory |
| `s` | Open the comment summary and submission page |
| `Esc` | Return from a secondary page or open explicit cancellation confirmation |

The inventory distinguishes planned, skipped, carried-forward, unsupported, and notice entries. Text hunks outside the planned route remain available for explicit read-only inspection.

A comment will retain its selected file path, old and new paths for renames, old and new line numbers, hunk identifier, review unit, and nearby diff text.

## Comment Submission

The final page will support two submission modes:

- **Discuss first:** The agent investigates and responds to every comment without editing code.
- **Apply change requests:** The agent applies direct change requests and explains questions or disagreements.

The comments are returned only after the reviewer submits the batch. This keeps the review uninterrupted and prevents the agent from changing later hunks while the human is still reading the snapshot. Submission rechecks the repository state; drift blocks submission and leaves draft comments in the walkthrough.

## Grounding and Coverage

The review must remain tied to the repository state that the human is looking at.

DiffWalk will enforce the following rules:

- Git output is the source of truth for all displayed changes.
- The snapshot is immutable for the duration of a review.
- Every hunk marked `needs-review` must appear exactly once in the route or be explicitly skipped.
- A hunk marked `unresolved-comment` cannot be skipped.
- Carried-forward hunks remain visible outside the planned route.
- A skipped hunk must include a visible reason.
- Unknown or duplicate hunk identifiers cause route validation to fail.
- A changed worktree is detected before comment submission.
- Comments retain stable snapshot locations even if the live worktree later changes.
- Binary files, generated files, renames, deletions, and untracked files must be represented or explicitly reported as unsupported.

These rules do not make the agent's explanation correct. They prevent the explanation from silently changing or hiding the code under review.

## Planned Architecture

```text
/review command
    -> Git snapshot collector
    -> diff parser and stable hunk IDs
    -> agent review-route prompt
    -> guided_review tool call
    -> route coverage validation
    -> interactive review TUI
    -> structured comment result
    -> agent response or implementation
```

The expected source layout is:

```text
src/
  index.ts              Command and tool registration
  git-diff.ts           Snapshot collection and diff parsing
  review-delta.ts       Incremental hunk classification and delta validation
  route-validation.ts   Route coverage, ordering, and skip validation
  review-coverage.ts    Submitted hunk outcome calculation
  review-series.ts      Completed review round lifecycle
  review-comments.ts    Comment anchors, drafts, and submission results
  review-ui.ts           Interactive TUI
  prompts.ts             Agent instructions for route construction
  types.ts               Shared data structures and schemas
test/
  git-diff.test.ts
  review-delta.test.ts
  route-validation.test.ts
  review-coverage.test.ts
  review-series.test.ts
  review-comments.test.ts
```

The final package will be a pi extension. Installation instructions will be added after the first working release.

## Design Principles

### The human performs the review

The agent reduces context reconstruction cost. It does not take ownership of the approval decision.

### The route is semantic

Review order should follow behavior, contracts, and data flow. Alphabetical file order is only a fallback.

### The patch is not model output

The agent may explain a hunk, but the extension must render the hunk captured from Git.

### Coverage is visible

The reviewer should always know how much of the snapshot has been reviewed, commented on, or skipped.

### Review state is frozen

The implementation agent must not edit code during the walkthrough. A review of a moving target is not a review.

### Comments return as one batch

The reviewer controls when feedback reaches the agent and what the agent is allowed to do with it.

## Roadmap

The first usable version will focus on:

- worktree and explicit-base snapshots
- tracked and untracked file support
- stable file and hunk identifiers
- agent-planned review routes
- complete route coverage validation
- line-oriented diff navigation
- inline comment editing
- comment summary and batch submission
- worktree drift detection
- parser and route validation tests

Possible later work includes:

- pausing a walkthrough to ask the agent a live question
- resuming an interrupted review
- GitHub pull request sources
- posting comments back to a pull request
- an independent critic agent in addition to the guiding agent
- review history and trust calibration by repository

## License

[MIT](LICENSE)
